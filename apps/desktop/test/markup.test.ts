import { describe, expect, it } from 'vitest';
import { inviteCodes, mentionsIn, plainText, tokenize } from '../src/renderer/lib/markup';

const alice = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('message markup', () => {
  it('links web addresses, with or without the scheme, not their trailing punctuation', () => {
    expect(tokenize('see https://example.org/a?b=1.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', v: 'https://example.org/a?b=1', href: 'https://example.org/a?b=1' },
      { t: 'text', v: '.' },
    ]);
    expect(tokenize('(www.example.org)')).toEqual([
      { t: 'text', v: '(' },
      { t: 'link', v: 'www.example.org', href: 'https://www.example.org' },
      { t: 'text', v: ')' },
    ]);
  });

  it('links bare domains people type, but not file names or decimals', () => {
    expect(tokenize('go to crocodilechat.com/download now')).toEqual([
      { t: 'text', v: 'go to ' },
      {
        t: 'link',
        v: 'crocodilechat.com/download',
        href: 'https://crocodilechat.com/download',
      },
      { t: 'text', v: ' now' },
    ]);
    expect(tokenize('notes.txt costs 3.50, see a.b, mail bob@example.com')).toEqual([
      { t: 'text', v: 'notes.txt costs 3.50, see a.b, mail bob@example.com' },
    ]);
  });

  it('turns invite links into invites', () => {
    expect(tokenize('join us: croc://join/abcdefgh23')).toEqual([
      { t: 'text', v: 'join us: ' },
      { t: 'invite', v: 'croc://join/abcdefgh23', code: 'abcdefgh23' },
    ]);
    expect(inviteCodes('croc://join/abcdefgh23 and again croc://join/ABCDEFGH23')).toEqual([
      'abcdefgh23',
    ]);
  });

  it('reads mentions, and shows them as names in plain text', () => {
    const text = `hi <@${alice}>!`;
    expect(tokenize(text)).toEqual([
      { t: 'text', v: 'hi ' },
      { t: 'mention', user: alice },
      { t: 'text', v: '!' },
    ]);
    expect(mentionsIn(text)).toEqual([alice]);
    expect(plainText(text, () => 'alice')).toBe('hi @alice!');
  });

  it('keeps code as code, links and all', () => {
    expect(tokenize('```js\nfetch("https://x.org")```')).toEqual([
      { t: 'block', v: 'fetch("https://x.org")' },
    ]);
    expect(tokenize('`<@x>` **bold** *it* ~~no~~')).toEqual([
      { t: 'code', v: '<@x>' },
      { t: 'text', v: ' ' },
      { t: 'bold', v: 'bold' },
      { t: 'text', v: ' ' },
      { t: 'italic', v: 'it' },
      { t: 'text', v: ' ' },
      { t: 'strike', v: 'no' },
    ]);
  });
});
