import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

export interface ContextMenuActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
  openLink(url: string): void;
  copy(text: string): void;
}

type Params = Pick<
  ContextMenuParams,
  | 'isEditable'
  | 'selectionText'
  | 'linkURL'
  | 'misspelledWord'
  | 'dictionarySuggestions'
  | 'editFlags'
>;

/**
 * The right-click menu for text: spelling fixes, cut/copy/paste in fields,
 * copy for selected text, open/copy for web links. Messages have their own
 * menu in the app, which keeps this one from showing.
 */
export function contextMenuTemplate(
  p: Params,
  act: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const separate = () => {
    if (items.length && items[items.length - 1]!.type !== 'separator')
      items.push({ type: 'separator' });
  };
  if (p.isEditable && p.misspelledWord) {
    for (const word of p.dictionarySuggestions.slice(0, 5))
      items.push({ label: word, click: () => act.replaceMisspelling(word) });
    if (p.dictionarySuggestions.length === 0)
      items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({ label: 'Add to dictionary', click: () => act.addToDictionary(p.misspelledWord) });
  }
  if (/^https?:\/\//i.test(p.linkURL)) {
    separate();
    items.push(
      { label: 'Open link', click: () => act.openLink(p.linkURL) },
      { label: 'Copy link', click: () => act.copy(p.linkURL) },
    );
  }
  if (p.isEditable) {
    separate();
    items.push(
      { role: 'undo', enabled: p.editFlags.canUndo },
      { role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: p.editFlags.canSelectAll },
    );
  } else if (p.selectionText.trim()) {
    separate();
    items.push({ role: 'copy' });
  }
  return items;
}
