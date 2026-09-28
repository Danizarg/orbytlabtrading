'use client';

import { LoaderCircle, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@/components/ui/cn';
import { useSearch } from '@/data/hooks/useSearch';
import { isEditableElement, isSearchHotkey } from './hotkeys';
import { useRecentSearches, type RecentToken } from './recent';
import { buildOptions, type SearchOption } from './search-options';
import { SearchResults, type SearchVariant } from './SearchResults';

/** Dispatched when a hotkey fires while the inline search is hidden (small screens). */
const OPEN_SEARCH_EVENT = 'orbyt:open-search';

const NO_RECENT: readonly RecentToken[] = [];

/**
 * Header search (≥ 1024 px). Accepts a name, symbol, mint, wallet, signature
 * or a pasted token link. "/" or Ctrl/⌘+K focuses it from anywhere.
 */
export function GlobalSearch() {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const context = { editing: isEditableElement(document.activeElement as HTMLElement | null), dialogOpen: !!document.querySelector('dialog[open]') };
      if (!isSearchHotkey(e, context)) return;
      e.preventDefault();
      const input = inputRef.current;
      // offsetParent is null while an ancestor is display:none (the inline box on small screens).
      if (input && input.offsetParent !== null) {
        input.focus();
        input.select();
      } else {
        window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <SearchCombobox variant="inline" inputRef={inputRef} />;
}

/** Search icon for small screens; opens a full-width search sheet. */
export function MobileSearch({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Search tokens and wallets"
        aria-haspopup="dialog"
        // Mount and focus inside the tap itself: iOS only raises the keyboard for focus within a user gesture.
        onClick={() => flushSync(() => setOpen(true))}
        className={cn('size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg', className ?? 'flex')}
      >
        <Search className="size-4" aria-hidden />
      </button>
      {open && <SearchSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function SearchSheet({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Layout effect: runs inside the flushSync commit of the opening tap.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-label="Search"
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-bg p-0 text-fg backdrop:bg-black/70"
    >
      <SearchCombobox variant="sheet" inputRef={inputRef} onDone={() => dialogRef.current?.close()} />
    </dialog>
  );
}

function SearchCombobox({ variant, inputRef, onDone }: { variant: SearchVariant; inputRef: RefObject<HTMLInputElement | null>; onDone?: () => void }) {
  const router = useRouter();
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * An Enter waiting for its lookup to settle runs only while its ticket is
   * current: typing, Escape, Tab, leaving the box or closing the sheet cancel it.
   */
  const enterTicketRef = useRef(0);
  const cancelPendingEnter = () => void enterTicketRef.current++;

  const [query, setQueryState] = useState('');
  const [open, setOpen] = useState(false);
  // Highlight by option key, so results arriving never move it; typing resets it to the first option.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const search = useSearch(query);
  const recent = useRecentSearches((s) => s.items);
  const addRecent = useRecentSearches((s) => s.add);
  const clearRecent = useRecentSearches((s) => s.clear);

  const setQuery = (value: string) => {
    cancelPendingEnter();
    setQueryState(value);
    setActiveKey(null);
  };

  useEffect(() => {
    const tickets = enterTicketRef;
    return () => {
      tickets.current++;
    };
  }, []);

  const recentShown = search.parsed.kind === 'empty' ? recent : NO_RECENT;
  const options = useMemo(() => buildOptions({ actions: search.actions, hits: search.hits, recent: recentShown }), [search.actions, search.hits, recentShown]);
  const chosenIndex = activeKey === null ? -1 : options.findIndex((o) => o.key === activeKey);
  const active = Math.max(0, chosenIndex);
  const setActive = (index: number) => setActiveKey(options[index]?.key ?? null);

  const panelVisible = variant === 'sheet' || (open && (search.parsed.kind !== 'empty' || options.length > 0));
  const activeOption = panelVisible ? options[active] : undefined;
  const activeOptionKey = activeOption?.key;

  useEffect(() => {
    if (!activeOptionKey) return;
    document.getElementById(`${baseId}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionKey, active, baseId]);

  const finish = () => {
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
    onDone?.();
  };

  const remember = (option: SearchOption) => {
    if (option.kind !== 'token') return;
    const { mint, symbol, name, image } = option.token;
    addRecent({ mint, symbol, name, image });
  };

  const choose = (option: SearchOption, newTab: boolean) => {
    remember(option);
    if (option.external || newTab) {
      window.open(option.href, '_blank', 'noopener,noreferrer');
      if (!newTab) finish();
      return;
    }
    router.push(option.href);
    finish();
  };

  const onPick = (option: SearchOption, event: MouseEvent<HTMLAnchorElement>) => {
    cancelPendingEnter();
    remember(option);
    // Modified clicks open a new tab (browser default); keep the results open.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    finish();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!panelVisible) setOpen(true);
        else if (options.length) setActive((active + 1) % options.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (panelVisible && options.length) setActive((active - 1 + options.length) % options.length);
        break;
      case 'Enter': {
        if (!panelVisible) return;
        const newTab = e.metaKey || e.ctrlKey;
        // Nothing picked yet and the first option is still being decided (debounce, lookup, or
        // telling a mint from a wallet or pool): wait briefly so Enter opens the right thing.
        // Only in-app navigation is deferred: browsers block window.open outside the key press.
        if (chosenIndex < 0 && search.resolving && !newTab) {
          e.preventDefault();
          const ticket = ++enterTicketRef.current;
          void search.resolve().then((resolved) => {
            if (enterTicketRef.current !== ticket) return;
            const first = buildOptions({ ...resolved, recent: NO_RECENT })[0];
            // An explorer link needs a fresh key press (popup rules); it is highlighted by then.
            if (first && !first.external) choose(first, false);
          });
          return;
        }
        const option = options[active];
        if (!option) return;
        e.preventDefault();
        choose(option, newTab);
        break;
      }
      case 'Escape':
        cancelPendingEnter();
        // In the sheet, Escape closes the dialog (native behaviour).
        if (variant === 'sheet') return;
        e.preventDefault();
        if (panelVisible) setOpen(false);
        else if (query) setQuery('');
        else inputRef.current?.blur();
        break;
      case 'Tab':
        cancelPendingEnter();
        setOpen(false);
        break;
    }
  };

  const input = (
    <div
      className={cn(
        'group flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 transition-colors',
        'focus-within:border-brand/70 hover:not-focus-within:border-line-strong',
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Search tokens and wallets"
        aria-expanded={panelVisible}
        aria-controls={panelVisible ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeOption ? optionId(active) : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={variant === 'sheet' ? 'Token, mint, wallet or link' : 'Search token, mint or wallet'}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="go"
        maxLength={256}
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
      />
      {search.isLoading && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted" aria-hidden />}
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery('');
            inputRef.current?.focus();
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : (
        variant === 'inline' && (
          <kbd
            aria-hidden
            className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-line-strong px-1 font-sans text-2xs leading-none text-faint group-focus-within:hidden"
          >
            /
          </kbd>
        )
      )}
    </div>
  );

  const results = (
    <SearchResults
      variant={variant}
      listboxId={listboxId}
      optionId={optionId}
      options={options}
      active={active}
      search={search}
      onHover={setActive}
      onPick={onPick}
      onClearRecent={clearRecent}
    />
  );

  if (variant === 'sheet') {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
          {input}
          <button type="button" onClick={() => onDone?.()} className="h-8 shrink-0 rounded-md px-2 text-xs font-medium text-muted hover:bg-hover hover:text-fg">
            Cancel
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" onMouseDown={(e) => e.preventDefault()}>
          {results}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="relative w-full max-w-[480px]"
      onBlur={(e) => {
        if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
        cancelPendingEnter();
        setOpen(false);
      }}
    >
      <div className="flex">{input}</div>
      {panelVisible && (
        <div
          // Keep focus in the input while clicking inside the panel.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute top-[calc(100%+4px)] left-0 z-50 w-full min-w-[440px] overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60"
        >
          <div className="max-h-[min(520px,calc(100dvh-140px))] overflow-y-auto overscroll-contain">{results}</div>
        </div>
      )}
    </div>
  );
}
