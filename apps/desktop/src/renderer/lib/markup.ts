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

/** Invite links as people paste them: croc://join/<code>. */
export const INVITE_LINK = /croc:\/\/join\/([a-z2-7]{8,16})\b/gi;

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

/** Invite codes in a message, each once, in order. */
export function inviteCodes(text: string): string[] {
  return [...new Set([...text.matchAll(INVITE_LINK)].map((m) => m[1]!.toLowerCase()))];
}

/** Users a message mentions. */
export function mentionsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/<@([a-z2-7]{8,64})>/gi)].map((m) => m[1]!.toLowerCase()))];
}

/** The message as plain text: mentions as @names (copying, notifications, quotes). */
export function plainText(text: string, nameOf: (userId: string) => string): string {
  return text.replace(/<@([a-z2-7]{8,64})>/gi, (_, id: string) => `@${nameOf(id.toLowerCase())}`);
}
