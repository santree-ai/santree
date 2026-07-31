/**
 * The searchable keyboard-shortcuts overlay (Conductor-style): a centered card
 * over a blurred backdrop, with a filter box and shortcuts grouped into sections.
 * Opened with ⌘/ or from the help menu. The list is the single on-screen
 * reference for the bindings wired in `useKeyboardShortcuts` (global) and in the
 * per-view models (Issues/Trees/Reviews/Triage) — keep it in sync when shortcuts
 * change.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { useApp, useAppUi } from "../state/AppContext";
import { SearchIcon } from "./icons";
import { useModalA11y } from "./primitives";

interface Shortcut {
  label: string;
  /** Key tokens rendered as individual chips, e.g. ["⌘", "/"]. */
  keys: string[];
}
interface Section {
  title: string;
  items: Shortcut[];
}

/** Build the section list; tab numbers follow NavTabs order — the repo-independent
 *  views first (Agents, then Dev when enabled), then the repo-scoped ones. */
function buildSections(triageEnabled: boolean, devEnabled: boolean): Section[] {
  const tabLabels = [
    "Agents",
    ...(devEnabled ? ["Dev"] : []),
    ...(triageEnabled ? ["Triage"] : []),
    "Issues",
    "Trees",
    "Reviews",
  ];
  return [
    {
      title: "General",
      items: [
        { label: "Keyboard shortcuts", keys: ["⌘", "/"] },
        { label: "Settings", keys: ["⌘", ","] },
        { label: "Toggle sidebar", keys: ["⌘", "B"] },
        { label: "Leave Settings", keys: ["Esc"] },
      ],
    },
    {
      title: "Navigation",
      items: tabLabels.map((label, i) => ({
        label: `Go to ${label}`,
        keys: ["⌘", String(i + 1)],
      })),
    },
    {
      title: "Issues",
      items: [
        { label: "Toggle right panel", keys: ["⌘", "L"] },
        { label: "Toggle actionable only", keys: ["⌘", "⇧", "."] },
        { label: "Add ticket to queue", keys: ["⌘", "Click"] },
      ],
    },
    {
      title: "Trees",
      items: [{ label: "Toggle files panel", keys: ["⌘", "L"] }],
    },
    {
      title: "Reviews",
      items: [{ label: "Toggle info panel", keys: ["⌘", "L"] }],
    },
    {
      title: "Triage",
      items: [
        { label: "Next issue", keys: ["J"] },
        { label: "Previous issue", keys: ["K"] },
        { label: "Investigate issue", keys: ["⌘", "I"] },
        { label: "Open issue in Linear", keys: ["⌘", "O"] },
      ],
    },
  ];
}

function Kbd({ token }: { token: string }) {
  return (
    <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-[5px] border border-line-2 bg-input px-1.5 font-mono text-[11px] text-fg-2">
      {token}
    </span>
  );
}

export function ShortcutsOverlay() {
  const { triageEnabled, devEnabled } = useApp();
  const { shortcutsOpen, setShortcutsOpen } = useAppUi();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset the filter each time it opens.
  useEffect(() => {
    if (!shortcutsOpen) return;
    setQuery("");
  }, [shortcutsOpen]);

  // Initial focus, Escape-to-close, Tab trap, and focus-restore on close —
  // shared with ConfirmDialog/CreatePrDialog so modal a11y can't drift apart.
  useModalA11y({
    open: shortcutsOpen,
    onClose: () => setShortcutsOpen(false),
    dialogRef,
    initialFocusRef: inputRef,
  });

  const sections = useMemo(() => {
    const all = buildSections(triageEnabled, devEnabled);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all
      .map((s) => ({ ...s, items: s.items.filter((i) => i.label.toLowerCase().includes(q)) }))
      .filter((s) => s.items.length > 0);
  }, [triageEnabled, devEnabled, query]);

  if (!shortcutsOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] flex justify-center px-4 pt-[12vh]">
      {/* Blurred click-away backdrop. */}
      <button
        type="button"
        aria-label="Close keyboard shortcuts"
        onClick={() => setShortcutsOpen(false)}
        className="fixed inset-0 cursor-default bg-black/40 backdrop-blur-sm"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-label="Keyboard shortcuts"
        className="relative flex max-h-[76vh] w-[760px] max-w-full flex-col overflow-hidden rounded-2xl border border-line-3 bg-popover shadow-[0_30px_80px_-20px_rgba(0,0,0,.85)]"
      >
        <div className="flex items-center gap-2.5 px-6 pt-5 pb-3">
          <span className="font-mono text-[15px] text-muted-2">⌘</span>
          <h2 className="text-[15px] font-semibold text-fg-bright">Keyboard shortcuts</h2>
        </div>
        <div className="px-6 pb-3">
          <div className="flex items-center gap-2.5 rounded-lg border border-line-2 bg-input px-3 py-2 focus-within:border-[color:var(--accent)]">
            <span className="text-muted-3">
              <SearchIcon />
            </span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts…"
              className="w-full bg-transparent text-[13px] text-fg-2 outline-none placeholder:text-muted-4"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          {sections.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-muted-3">
              No matching shortcuts.
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.title} className="mb-5 last:mb-0">
                <div className="mb-1.5 pt-2 text-[12px] font-medium text-muted-3">
                  {section.title}
                </div>
                {section.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between rounded-md px-1 py-[7px]"
                  >
                    <span className="text-[13px] text-fg-3">{item.label}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((k, i) => (
                        <Kbd key={`${item.label}-${i}`} token={k} />
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
