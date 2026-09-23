/**
 * Find in what a pane has rendered — ⌘F, and the bar it opens.
 *
 * A Tauri window has no browser find bar, so ⌘F is ours to bind or the file on
 * screen has no search at all. It searches the **DOM** rather than the data
 * behind it because the things a file view can render — a third-party diff
 * component, highlighted source, a rendered markdown document — share no text
 * representation, and the diff's markup is not ours to rewrite.
 *
 * Matches are painted with the CSS Custom Highlight API: no DOM mutation, so
 * nothing re-renders and every pane is left exactly as it drew itself. Where
 * that API is missing (an older WebKitGTK) the current match is *selected*
 * instead — every engine paints a selection, so you still land on the match and
 * the counter still says how many there are; only the other matches go unlit.
 *
 * **What is not rendered cannot be found.** A diff's unexpanded context lines
 * are not in the DOM, so the count is honest about what is on screen rather than
 * about the file on disk.
 */
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { targetOwnsKey } from "../lib/useKeyboardShortcuts";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "./icons";

/** Marks the bar's own subtree: it is on screen, but it is not what you are
 *  searching, and its input owns the keys the rest of the app would take. */
const BAR_ATTR = "data-find-bar";

/** Highlight registry names. The registry is global to the document, so both are
 *  namespaced rather than called "match" and "current". */
const ALL = "santree-find";
const CURRENT = "santree-find-current";

/** Stop scanning past this many hits. A one-letter query on a long file is the
 *  case this exists for: the matches past the cap can't be stepped to, so the
 *  counter says so (`500+`) rather than pretending the rest aren't there. */
const MAX_MATCHES = 500;

export interface FindState {
  open: boolean;
  query: string;
  setQuery: (query: string) => void;
  /** Matches currently rendered — capped at {@link MAX_MATCHES}. */
  count: number;
  /** Which match is current, 0-based. `0` with no matches. */
  index: number;
  /** The scan stopped at the cap, so `count` is a floor, not a total. */
  capped: boolean;
  next: () => void;
  prev: () => void;
  close: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

interface Chunk {
  node: Text;
  /** Where this node's text starts in the concatenated haystack. */
  start: number;
}

/**
 * Every text node the pane is showing, concatenated, plus the offsets needed to
 * turn a match back into a DOM range.
 *
 * Concatenated rather than searched node by node, because highlighted code is
 * one node per token: `foo = 1` is three of them, and a per-node search would
 * fail on any query that crosses a token boundary — which is most of what
 * anyone types into a find bar. The cost is that a query can also match across
 * the seam between two rendered lines; that is rarer than searching for two
 * words in a row, so it is the trade taken.
 */
function collect(root: HTMLElement): { text: string; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(`[${BAR_ATTR}]`)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    if (value === "") continue;
    chunks.push({ node: node as Text, start: text.length });
    text += value;
  }
  return { text, chunks };
}

/** The text node and offset a haystack position falls in. Binary search: a long
 *  file is tens of thousands of chunks and this runs per match boundary. */
function locate(chunks: Chunk[], offset: number): { node: Text; offset: number } | null {
  let lo = 0;
  let hi = chunks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].start <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return null;
  return { node: chunks[found].node, offset: offset - chunks[found].start };
}

/** Every rendered occurrence of `query` under `root`, as live ranges. */
export function findRanges(root: HTMLElement, query: string): { ranges: Range[]; capped: boolean } {
  const needle = query.toLowerCase();
  if (needle === "") return { ranges: [], capped: false };
  const { text, chunks } = collect(root);
  const haystack = text.toLowerCase();
  const ranges: Range[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    if (ranges.length === MAX_MATCHES) return { ranges, capped: true };
    const start = locate(chunks, at);
    const end = locate(chunks, at + needle.length);
    if (start && end) {
      const range = document.createRange();
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        ranges.push(range);
      } catch {
        // A node that moved between the walk and here — skip that hit rather
        // than lose the whole scan; the next mutation rescans anyway.
      }
    }
    at = haystack.indexOf(needle, at + needle.length);
  }
  return { ranges, capped: false };
}

/** The Highlight API, when this engine has it. */
function registry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
}

function clearHighlights() {
  const highlights = registry();
  if (!highlights) return;
  highlights.delete(ALL);
  highlights.delete(CURRENT);
}

/**
 * ⌘F over `scope`, live only while `enabled`.
 *
 * `enabled` is what keeps a hidden pane from answering: the file view stays
 * mounted behind whichever tab is showing, and a find bar that opened over a
 * terminal to search an invisible file would be a puzzle, not a feature.
 */
export function useFindInView(scope: RefObject<HTMLElement | null>, enabled: boolean): FindState {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // Bumped by the observer below: the pane's own content changed, so the ranges
  // held here are stale (an agent just wrote the file, a hunk was expanded).
  const [version, setVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const { ranges, capped } = useMemo(() => {
    const root = scope.current;
    if (!open || !root) return { ranges: [] as Range[], capped: false };
    // `version` is the dependency that matters here — the DOM it reads is not
    // React state, so a content change has to be announced.
    void version;
    return findRanges(root, query);
  }, [open, query, version, scope]);

  const count = ranges.length;

  // A shorter query (or a file that changed under the bar) can leave the cursor
  // past the end. Clamp rather than reset: a rescan mid-typing shouldn't throw
  // you back to the first match.
  useEffect(() => {
    setIndex((i) => (count === 0 ? 0 : Math.min(i, count - 1)));
  }, [count]);

  // Paint. The current match is registered on its own so it can be styled apart
  // from the rest; both registrations are replaced wholesale on every change,
  // which is what keeps stale ranges from accumulating.
  useEffect(() => {
    const highlights = registry();
    const current = ranges[index];
    if (highlights) {
      if (count === 0) {
        clearHighlights();
      } else {
        highlights.set(ALL, new Highlight(...ranges));
        if (current) highlights.set(CURRENT, new Highlight(current));
      }
      return;
    }
    // No Highlight API: select the current match instead. Nothing to clean up
    // per change — the next one replaces the selection.
    const selection = window.getSelection?.();
    if (!selection) return;
    selection.removeAllRanges();
    if (current) selection.addRange(current);
  }, [ranges, index, count]);

  // Bring the current match into view. `scrollIntoView` on the match's own
  // element walks every scroller between it and the window, which is what the
  // nested panes here need (and jsdom has none of it, hence the optional call).
  useEffect(() => {
    const current = ranges[index];
    const el =
      current?.startContainer.nodeType === Node.ELEMENT_NODE
        ? (current.startContainer as HTMLElement)
        : current?.startContainer.parentElement;
    el?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }, [ranges, index]);

  // Rescan while the file is being written underneath the bar.
  useEffect(() => {
    const root = scope.current;
    if (!open || query === "" || !root || typeof MutationObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((v) => v + 1), 120);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [open, query, scope]);

  const close = useCallback(() => {
    setOpen(false);
    clearHighlights();
  }, []);

  const next = useCallback(() => {
    setIndex((i) => (count === 0 ? 0 : (i + 1) % count));
  }, [count]);

  const prev = useCallback(() => {
    setIndex((i) => (count === 0 ? 0 : (i - 1 + count) % count));
  }, [count]);

  // Leaving the pane closes the bar: its highlights belong to a view that is no
  // longer on screen, and finding them still lit on return reads as a stuck app.
  useEffect(() => {
    if (!enabled && openRef.current) close();
  }, [enabled, close]);

  useEffect(() => clearHighlights, []);

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const inBar = (e.target as HTMLElement | null)?.closest?.(`[${BAR_ATTR}]`) != null;
      if (mod && !e.altKey && e.key.toLowerCase() === "f") {
        // A text field owns its keys — except the bar's own input, where ⌘F
        // means "start over with this query", the way a browser's does.
        if (targetOwnsKey(e) && !inBar) return;
        e.preventDefault();
        setOpen(true);
        // After the bar exists. Focused *and* selected: pressing ⌘F again is
        // "search for something else", so the last query goes one keystroke
        // away from being replaced rather than being cleared for you.
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
        return;
      }
      if (!openRef.current) return;
      // ⌘G / ⌘⇧G — step without the bar having focus, the macOS find chords.
      if (mod && !e.altKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) prev();
        else next();
        return;
      }
      if (e.key === "Escape" && (inBar || !targetOwnsKey(e))) {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, next, prev, close]);

  return { open, query, setQuery, count, index, capped, next, prev, close, inputRef };
}

/** The bar itself: floating over the pane's top-right corner, where a browser
 *  puts it. Renders nothing until ⌘F opens it. */
export function FindBar({ find }: { find: FindState }) {
  if (!find.open) return null;
  const { query, count, index, capped } = find;
  const position = count === 0 ? "0/0" : `${index + 1}/${count}${capped ? "+" : ""}`;
  return (
    <div
      data-find-bar=""
      className="absolute top-2 right-3 z-50 flex items-center gap-1.5 rounded-lg border border-line-3 bg-raised px-2 py-1 shadow-lg"
    >
      <SearchIcon size={11} className="flex-none text-muted-4" />
      <input
        ref={find.inputRef}
        value={query}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) find.prev();
            else find.next();
          } else if (e.key === "Escape") {
            e.preventDefault();
            find.close();
          }
        }}
        spellCheck={false}
        aria-label="Find in file"
        placeholder="Find"
        className="w-36 bg-transparent font-mono text-[11.5px] text-fg-2 outline-none placeholder:text-muted-4"
      />
      {/* Reserved width, so stepping through matches doesn't shuffle the
          buttons beside it. Announced, since the number is the only feedback a
          query with no matches gets. */}
      <span
        aria-live="polite"
        className="w-12 flex-none text-right font-mono text-[10.5px] text-muted-4 tabular-nums"
      >
        {query === "" ? "" : position}
      </span>
      <StepButton label="Previous match" onClick={find.prev} disabled={count === 0} up />
      <StepButton label="Next match" onClick={find.next} disabled={count === 0} />
      <button
        type="button"
        onClick={find.close}
        aria-label="Close find"
        title="Close find (Esc)"
        className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}

function StepButton({
  label,
  onClick,
  disabled,
  up = false,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  up?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={`${label} (${up ? "⇧⏎" : "⏎"})`}
      className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <ChevronDownIcon size={11} className={up ? "rotate-180" : ""} />
    </button>
  );
}
