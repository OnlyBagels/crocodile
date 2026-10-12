import { describe, expect, it, vi } from 'vitest';
import { contextMenuTemplate } from '../src/main/context-menu';

const flags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false,
};
const params = (over: object = {}) => ({
  isEditable: false,
  selectionText: '',
  linkURL: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: flags,
  ...over,
});
const actions = () => ({
  replaceMisspelling: vi.fn(),
  addToDictionary: vi.fn(),
  openLink: vi.fn(),
  copy: vi.fn(),
});
const labels = (items: { role?: string; label?: string; type?: string }[]) =>
  items.map((i) => i.label ?? i.role ?? i.type);

describe('right-click menu', () => {
  it('offers cut, copy and paste in a text field', () => {
    expect(labels(contextMenuTemplate(params({ isEditable: true }), actions()))).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ]);
  });

  it('puts spelling fixes first, and applies them', () => {
    const act = actions();
    const items = contextMenuTemplate(
      params({
        isEditable: true,
        misspelledWord: 'helo',
        dictionarySuggestions: ['hello', 'help'],
      }),
      act,
    );
    expect(labels(items).slice(0, 4)).toEqual(['hello', 'help', 'Add to dictionary', 'separator']);
    (items[0]!.click as () => void)();
    expect(act.replaceMisspelling).toHaveBeenCalledWith('hello');
  });

  it('copies selected text, and opens or copies web links', () => {
    expect(labels(contextMenuTemplate(params({ selectionText: 'hi' }), actions()))).toEqual([
      'copy',
    ]);
    const act = actions();
    const items = contextMenuTemplate(params({ linkURL: 'https://example.org/' }), act);
    expect(labels(items)).toEqual(['Open link', 'Copy link']);
    (items[1]!.click as () => void)();
    expect(act.copy).toHaveBeenCalledWith('https://example.org/');
    // Nothing to offer on plain page background.
    expect(contextMenuTemplate(params(), actions())).toEqual([]);
  });
});
