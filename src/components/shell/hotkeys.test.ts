import { describe, expect, it } from 'vitest';
import { isEditableElement, isSearchHotkey, type HotkeyEvent } from './hotkeys';

const key = (k: string, mods: Partial<HotkeyEvent> = {}): HotkeyEvent => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
const free = { editing: false, dialogOpen: false };

describe('isSearchHotkey', () => {
  it('accepts "/" only when not typing and no dialog is open', () => {
    expect(isSearchHotkey(key('/'), free)).toBe(true);
    expect(isSearchHotkey(key('/'), { editing: true, dialogOpen: false })).toBe(false);
    expect(isSearchHotkey(key('/'), { editing: false, dialogOpen: true })).toBe(false);
    expect(isSearchHotkey(key('/', { ctrlKey: true }), free)).toBe(false);
    expect(isSearchHotkey(key('/', { altKey: true }), free)).toBe(false);
  });

  it('accepts Ctrl/⌘+K even while typing, but not inside dialogs', () => {
    expect(isSearchHotkey(key('k', { ctrlKey: true }), { editing: true, dialogOpen: false })).toBe(true);
    expect(isSearchHotkey(key('K', { metaKey: true }), free)).toBe(true);
    expect(isSearchHotkey(key('k'), free)).toBe(false);
    expect(isSearchHotkey(key('k', { ctrlKey: true, altKey: true }), free)).toBe(false);
    expect(isSearchHotkey(key('k', { ctrlKey: true }), { editing: false, dialogOpen: true })).toBe(false);
  });

  it('ignores composing and already-handled events', () => {
    expect(isSearchHotkey(key('/', { isComposing: true }), free)).toBe(false);
    expect(isSearchHotkey(key('/', { defaultPrevented: true }), free)).toBe(false);
    expect(isSearchHotkey(key('a'), free)).toBe(false);
  });
});

describe('isEditableElement', () => {
  it('detects text entry targets', () => {
    expect(isEditableElement({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isEditableElement({ tagName: 'input' })).toBe(true);
    expect(isEditableElement({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isEditableElement({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableElement({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableElement({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('ignores buttons, checkboxes and plain elements', () => {
    expect(isEditableElement({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isEditableElement({ tagName: 'INPUT', type: 'submit' })).toBe(false);
    expect(isEditableElement({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableElement({ tagName: 'BODY' })).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});
