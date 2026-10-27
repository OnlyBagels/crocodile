import Fastify, { type FastifyInstance } from 'fastify';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { keyMatchesUserId, toPublicDirectoryEntry, verifyPayload } from '@crocodile/crypto';
import {
  DIRECTORY_PATHS,
  DirectoryEntry,
  SIG_DOMAIN,
  type DirectoryListing,
} from '@crocodile/protocol';

export interface DirectoryConfig {
  host: string;
  port: number;
  /** Entries not refreshed within this window are dropped from the listing. */
  ttlMs: number;
  /** Verify a server's /health answers from its advertised URL before listing it. */
  verifyReachability: boolean;
  /** Allow loopback/private URLs (for development and LAN setups). */
  allowPrivateUrls: boolean;
  /** Persist entries across restarts. */
  statePath?: string;
  /** Read client addresses from X-Forwarded-For (only behind a proxy). */
  trustProxy: boolean;
  /** Registrations one address may send per minute. */
  registrationsPerMinute: number;
  /** Servers listed at most; new ones are refused past this. */
  maxEntries: number;
  /** Resolves a host name for the reachability probe (tests replace it). */
  resolve?: (host: string) => Promise<string[]>;
  log?: (msg: string) => void;
}

export const defaultDirectoryConfig: DirectoryConfig = {
  host: '0.0.0.0',
  port: 7400,
  ttlMs: 3 * 60_000,
  verifyReachability: true,
  allowPrivateUrls: false,
  trustProxy: false,
  // A server registers once a minute; a few share an address at most.
  registrationsPerMinute: 20,
  maxEntries: 5000,
};

type Stored = DirectoryEntry & { lastSeen: number; verifiedAt: number };

const MAX_SKEW_MS = 5 * 60_000;
const REVERIFY_MS = 10 * 60_000;

/**
 * The directory: a phone book of coordination servers. Servers register a
 * self-signed entry every minute; clients fetch the list and probe latency
 * themselves. It knows nothing about users, spaces or content.
 */
export class Directory {
  readonly config: DirectoryConfig;
  private entries = new Map<string, Stored>();
  private app?: FastifyInstance;
  private saveTimer?: ReturnType<typeof setInterval>;
  /** Registrations per client address in the current minute. */
  private recent = new Map<string, { n: number; since: number }>();

  constructor(config: Partial<DirectoryConfig> = {}) {
    this.config = { ...defaultDirectoryConfig, ...config };
    if (this.config.statePath && existsSync(this.config.statePath)) {
      const saved = JSON.parse(readFileSync(this.config.statePath, 'utf8')) as Stored[];
      for (const e of saved) this.entries.set(e.server.id, e);
    }
  }

  listing(now = Date.now()): DirectoryListing {
    // Addresses are published obfuscated, never as plain URLs/IPs.
    const servers = [...this.entries.values()]
      .filter((e) => now - e.lastSeen < this.config.ttlMs)
      .map(({ verifiedAt: _v, ...e }) => toPublicDirectoryEntry(e));
    return { servers, generatedAt: now };
  }

  async register(
    input: unknown,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const parsed = DirectoryEntry.safeParse(input);
    if (!parsed.success) return { ok: false, status: 400, error: 'malformed entry' };
    const entry = parsed.data;
    const now = Date.now();
    if (Math.abs(now - entry.signedAt) > MAX_SKEW_MS)
      return { ok: false, status: 400, error: 'stale signature; check clock' };
    if (!keyMatchesUserId(entry.server.key, entry.server.id))
      return { ok: false, status: 400, error: 'id does not match key' };
    const signed = { server: entry.server, load: entry.load, signedAt: entry.signedAt };
    if (!verifyPayload(entry.server.key, SIG_DOMAIN.directory, signed, entry.sig)) {
      return { ok: false, status: 401, error: 'bad signature' };
    }
    const url = new URL(entry.server.url);
    if (!['http:', 'https:'].includes(url.protocol))
      return { ok: false, status: 400, error: 'url must be http(s)' };
    if (!this.config.allowPrivateUrls && isPrivateHost(url.hostname)) {
      return { ok: false, status: 400, error: 'url must be publicly reachable' };
    }

    const previous = this.entries.get(entry.server.id);
    if (!previous && this.liveCount(now) >= this.config.maxEntries)
      return { ok: false, status: 503, error: 'the directory is full' };
    let verifiedAt = previous && previous.server.url === entry.server.url ? previous.verifiedAt : 0;
    if (this.config.verifyReachability && now - verifiedAt > REVERIFY_MS) {
      const problem = await this.probe(entry.server.url, entry.server.id);
      if (problem) return { ok: false, status: 422, error: problem };
      verifiedAt = now;
    }
    // One URL belongs to one server; a re-keyed server replaces its old entry.
    for (const [id, e] of this.entries)
      if (e.server.url === entry.server.url && id !== entry.server.id) this.entries.delete(id);
    if (!previous) this.config.log?.(`registered ${entry.server.name} (${entry.server.url})`);
    this.entries.set(entry.server.id, { ...entry, lastSeen: now, verifiedAt });
    return { ok: true };
  }

  private liveCount(now: number) {
    let n = 0;
    for (const [id, e] of this.entries) {
      if (now - e.lastSeen < this.config.ttlMs) n++;
      else this.entries.delete(id);
    }
    return n;
  }

  /** Whether an address may register again now (each one also costs a probe). */
  private allow(ip: string, now = Date.now()) {
    const r = this.recent.get(ip);
    if (!r || now - r.since >= 60_000) {
      if (this.recent.size > 100_000) this.recent.clear();
      this.recent.set(ip, { n: 1, since: now });
      return true;
    }
    return ++r.n <= this.config.registrationsPerMinute;
  }

  async start(): Promise<this> {
    const app = Fastify({
      logger: false,
      bodyLimit: 64 * 1024,
      // Only the proxy's own hop: what the client put in the header is not trusted.
      trustProxy: this.config.trustProxy ? (_address: string, hop: number) => hop < 1 : false,
    });
    this.app = app;
    app.addHook('onSend', async (_req, reply) => {
      reply.header('access-control-allow-origin', '*');
    });
    app.get(DIRECTORY_PATHS.health, async () => ({
      ok: true,
      servers: this.listing().servers.length,
      // AGPL-3.0 section 13: where to get this service's source.
      source: process.env.CROC_SOURCE_URL ?? 'https://github.com/pwalda/crocodile',
    }));
    app.get(DIRECTORY_PATHS.list, async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=15');
      return this.listing();
    });
    app.post(DIRECTORY_PATHS.register, async (req, reply) => {
      if (!this.allow(req.ip))
        return reply.code(429).send({ error: 'too many registrations; try again in a minute' });
      const result = await this.register(req.body);
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      return { ok: true, servers: this.listing().servers.length };
    });
    await app.listen({ host: this.config.host, port: this.config.port });
    if (this.config.statePath) {
      this.saveTimer = setInterval(() => this.save(), 30_000);
      this.saveTimer.unref?.();
    }
    return this;
  }

  get url(): string {
    const port = (this.app!.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  private save() {
    const path = this.config.statePath;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify([...this.entries.values()]));
    renameSync(`${path}.tmp`, path);
  }

  /**
   * Why `baseUrl`'s /health does not answer as `expectedId`, or null if it does. The name is
   * resolved here and each connection pinned to one of the addresses checked, so it cannot be
   * pointed elsewhere between the check and the request; redirects are not followed. The whole
   * probe, name lookup included, gets five seconds.
   */
  private async probe(baseUrl: string, expectedId: string): Promise<string | null> {
    const unreachable = `could not reach ${baseUrl}/health`;
    const signal = AbortSignal.timeout(5000);
    try {
      const url = new URL(`${baseUrl.replace(/\/$/, '')}/health`);
      if (url.username || url.password) return unreachable;
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host)
        ? [host]
        : await abortable(signal, (this.config.resolve ?? resolveAll)(host));
      if (!this.config.allowPrivateUrls && addresses.some((a) => isPrivateHost(a)))
        return `${url.hostname} resolves to a private address`;
      // Like a browser, fall back to the next address when one does not connect.
      for (const address of addresses.slice(0, 4)) {
        try {
          const body = await get(url, address, signal);
          if ((JSON.parse(body) as { id?: string }).id === expectedId) return null;
        } catch {
          // try the next
        }
      }
    } catch {
      // fall through
    }
    return unreachable;
  }

  async stop() {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.save();
    await this.app?.close();
  }
}

/** `work`, unless `signal` fires first. */
const abortable = <T>(signal: AbortSignal, work: Promise<T>) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    ),
  ]);

const resolveAll = async (host: string) =>
  (await dnsLookup(host, { all: true })).map((r) => r.address);

/** GETs `url` from `address` (whatever its name says), answering with a short 200 body. */
function get(url: URL, address: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        signal,
        // Its own connection: a pooled one would be to whatever address an earlier probe checked.
        agent: false,
        lookup: (_host, options, cb) => {
          const family = isIP(address);
          if (options.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(new Error(`status ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 4096) {
            reject(new Error('too long'));
            req.destroy();
          }
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return isPrivateV4(Number(v4[1]), Number(v4[2]));
  // A name, not an address (fdroid.example.org is a public name).
  if (!h.includes(':')) return false;
  const g = ipv6Groups(h);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  // An IPv4 address inside IPv6: mapped (::ffff:a.b.c.d), compatible
  // (::a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) reaches that IPv4 address.
  const embedded =
    (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) ||
    (first === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embedded) return isPrivateV4(g[6]! >> 8, g[6]! & 0xff);
  return false;
}

function isPrivateV4(a: number, b: number): boolean {
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    a >= 224 || // multicast and reserved
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. */
function ipv6Groups(h: string): number[] | null {
  let s = h.replace(/%.*$/, '');
  const dotted = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((x) => x > 255)) return null;
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':') : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (!groups.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map((x) => parseInt(x, 16));
}
