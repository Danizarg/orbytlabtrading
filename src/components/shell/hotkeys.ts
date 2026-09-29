/**
 * Global search hotkeys: "/" (ignored while typing or when a dialog is open)
 * and Ctrl/⌘+K (works from inputs too, like most terminals).
 */

export interface HotkeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export interface HotkeyContext {
  /** Focus is in a text input, textarea, select or contenteditable element. */
  editing: boolean;
  /** A modal dialog (deposit, search sheet…) is open. */
  dialogOpen: boolean;
}

export function isSearchHotkey(event: HotkeyEvent, context: HotkeyContext): boolean {
  if (event.defaultPrevented || event.isComposing || context.dialogOpen) return false;
  if (event.key === '/') return !event.ctrlKey && !event.metaKey && !event.altKey && !context.editing;
  if (event.key === 'k' || event.key === 'K') return (event.ctrlKey || event.metaKey) && !event.altKey;
  return false;
}

const NON_TEXT_INPUTS: ReadonlySet<string> = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** Whether a focused element accepts typed text. */
export function isEditableElement(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
  return false;
}
