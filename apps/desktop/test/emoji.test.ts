import { describe, expect, it } from 'vitest';
import { EMOJI_GROUPS, replaceShortcodes, searchEmoji } from '../src/renderer/lib/emoji';

describe('emoji', () => {
  it('finds emoji by name, shortcodes first', () => {
    expect(searchEmoji('thumbs')[0]).toEqual({ emoji: '👍', name: 'thumbsup' });
    expect(searchEmoji(':croc')[0]!.emoji).toBe('🐊');
    // A word inside the names counts too: "laugh" finds 🤣 and 😂.
    expect(searchEmoji('laugh').map((e) => e.emoji)).toEqual(
      expect.arrayContaining(['😆', '🤣', '😂']),
    );
    expect(searchEmoji('')).toEqual([]);
  });

  it('turns typed shortcodes into emoji, and leaves anything else', () => {
    expect(replaceShortcodes('ship it :rocket: :tada: at 10:30 :nope:')).toBe(
      'ship it 🚀 🎉 at 10:30 :nope:',
    );
  });

  it('has no emoji twice', () => {
    const all = EMOJI_GROUPS.flatMap((g) => g.emoji.map(([e]) => e));
    expect(new Set(all).size).toBe(all.length);
  });
});
