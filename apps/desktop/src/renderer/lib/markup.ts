/**
 * Message markup, as data: ```code blocks```, `inline code`, **bold**,
 * *italic*, ~~strike~~, links (http(s) and www.), Crocodile invite links and
 * mentions (`<@userId>`). Rendering turns these into React nodes; nothing
 * here ever becomes HTML.
 */
export type Token =
  | { t: 'text'; v: string }
  | { t: 'block'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'strike'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'invite'; v: string; code: string }
  | { t: 'mention'; user: string };

const TLDS = 'com|org|net|io|dev|app|eu|pl|de|uk|fr|es|it|nl|cz|us|ca|co|me|gg|tv|ai|xyz|info|chat';

const INLINE = new RegExp(
  [
    '`[^`\\n]+`',
    '\\*\\*[^*\\n]+\\*\\*',
    '\\*[^*\\n]+\\*',
    '~~[^~\\n]+~~',
    '<@[a-z2-7]{8,64}>',
    'croc://join/[a-z2-7]{8,16}\\b',
    // A URL ends before trailing punctuation: "see https://x.org." links x.org.
    '(?:https?://|www\\.)[^\\s<]+[^\\s<.,:;"\')\\]!?]',
    // A bare domain with a common ending, as people type them: example.com/path.
    `(?<![@\\w.-])[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:/[^\\s<]*[^\\s<.,:;"')\\]!?])?`,
  ].join('|'),
  'gi',
);

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  text.split('```').forEach((part, i) => {
    if (i % 2 === 1) out.push({ t: 'block', v: part.replace(/^\w*\n/, '') });
    else if (part) out.push(...inline(part));
  });
  return out;
}

function inline(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const s = m[0];
    if (m.index! > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    last = m.index! + s.length;
    if (s.startsWith('`')) out.push({ t: 'code', v: s.slice(1, -1) });
    else if (s.startsWith('**')) out.push({ t: 'bold', v: s.slice(2, -2) });
    else if (s.startsWith('~~')) out.push({ t: 'strike', v: s.slice(2, -2) });
    else if (s.startsWith('*')) out.push({ t: 'italic', v: s.slice(1, -1) });
    else if (s.startsWith('<@')) out.push({ t: 'mention', user: s.slice(2, -1).toLowerCase() });
    else if (/^croc:/i.test(s))
      out.push({ t: 'invite', v: s, code: s.slice('croc://join/'.length).toLowerCase() });
    else out.push({ t: 'link', v: s, href: /^https?:\/\//i.test(s) ? s : `https://${s}` });
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/** Invite codes a message shows as invites (not ones quoted in code), each once, in order. */
export function inviteCodes(text: string): string[] {
  return [...new Set(tokenize(text).flatMap((t) => (t.t === 'invite' ? [t.code] : [])))];
}

/** Users a message mentions (not in code). */
export function mentionsIn(text: string): string[] {
  return [...new Set(tokenize(text).flatMap((t) => (t.t === 'mention' ? [t.user] : [])))];
}

/** The message as plain text: mentions as @names (copying, notifications, quotes). */
export function plainText(text: string, nameOf: (userId: string) => string): string {
  return text.replace(/<@([a-z2-7]{8,64})>/gi, (_, id: string) => `@${nameOf(id.toLowerCase())}`);
}

/**
 * Mentions as typed ("@alice") to the form messages carry ("<@userId>"), for
 * the people who can be mentioned here. A name two of them share stays text.
 */
export function encodeMentions(text: string, people: { id: string; name: string }[]): string {
  const byName = new Map<string, string | null>();
  for (const p of people) {
    const key = p.name.toLowerCase();
    byName.set(key, byName.has(key) && byName.get(key) !== p.id ? null : p.id);
  }
  // Longest names first, so "@ann marie" wins over "@ann".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|[^\\w@])@(${escaped.join('|')})(?![\\w-])`, 'gi');
  return text.replace(re, (all, pre: string, name: string) => {
    const id = byName.get(name.toLowerCase());
    return id ? `${pre}<@${id}>` : all;
  });
}

/**
 * The "@que" or ":que" being typed just before the cursor, if any: what the
 * composer suggests mentions or emoji for.
 */
export function typedTrigger(
  text: string,
  cursor: number,
): { kind: '@' | ':'; query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const m = before.match(/(?:^|\s)([@:])([\w+-]*)$/);
  if (!m) return null;
  const kind = m[1] as '@' | ':';
  const query = m[2]!;
  // ":" suggests from the second letter on, so "re: x" or times don't pop up a list.
  if (kind === ':' && query.length < 2) return null;
  return { kind, query, start: cursor - query.length - 1 };
}
