import { describe, expect, it } from 'vitest';
import { SOUNDS, messageSound, soundLength } from '../src/renderer/lib/sounds';

const msg = { mine: false, update: false, mentionsMe: false, busy: false, watching: false };

describe('sounds', () => {
  it('chimes for messages you are not looking at, and always for mentions', () => {
    expect(messageSound(msg)).toBe('message');
    expect(messageSound({ ...msg, watching: true })).toBeNull();
    expect(messageSound({ ...msg, watching: true, mentionsMe: true })).toBe('mention');
  });

  it('stays quiet for your own messages, edits, and while busy', () => {
    expect(messageSound({ ...msg, mine: true })).toBeNull();
    expect(messageSound({ ...msg, update: true })).toBeNull();
    expect(messageSound({ ...msg, busy: true, mentionsMe: true })).toBeNull();
  });

  it('keeps every sound short, and rings within the ring interval', () => {
    for (const name of Object.keys(SOUNDS) as (keyof typeof SOUNDS)[])
      expect(soundLength(name)).toBeLessThan(1000);
    expect(soundLength('ring')).toBeLessThan(2000);
  });
});
