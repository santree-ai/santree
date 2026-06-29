/**
 * The persistent terminal render layer. Mounted once at the app shell so PTY
 * sessions and their xterm state survive navigation between tabs. It is a fixed
 * overlay that renders in one of two places:
 *
 *  - the **Terminal tab** content area (right of the sidebar, below the title
 *    bar), showing the active session; or
 *  - **embedded** over an arbitrary host element (the triage Investigate tab),
 *    showing that ticket's session.
 *
 * On every other route it stays mounted but hidden, so nothing reflows or dies
 * when you switch tabs.
 */

import { useRouterState } from "@tanstack/react-router";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

import { useRepos } from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { useTerminals } from "./TerminalsContext";
import { TerminalView } from "./TerminalView";

/** Height of the window title bar (matches ViewChrome's top bar). */
const TOP_BAR = 46;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Track an element's viewport rect, re-measuring on size/window changes. */
function useElementRect(el: HTMLElement | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!el) {
      setRect(null);
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    // Capture-phase scroll so the overlay tracks the host inside any scroll
    // container (e.g. the embedded login terminal in the scrollable settings pane).
    window.addEventListener("scroll", measure, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [el]);
  return rect;
}

export function TerminalLayer() {
  const { tabs, activeKey, open, close, embed, setEmbed } = useTerminals();
  const { activeRepo } = useApp();
  const { sidebarCollapsed } = useAppUi();
  const { data: repos = [] } = useRepos();
  const repoPath = repos.find((r) => r.name === activeRepo)?.path ?? undefined;
  const onTerminal = useRouterState({ select: (s) => s.location.pathname === "/terminal" });

  // Live-measured rect, falling back to the rect captured at embed time so the
  // very first render is already correctly sized (no full-area flash that would
  // open the PTY too tall).
  const liveRect = useElementRect(embed?.host ?? null);
  const embedRect = liveRect ?? embed?.rect ?? null;
  const embedded = !!embed && !!embedRect;
  const visible = embedded || onTerminal;
  // The session to display: the embedded one when embedding, else the active tab.
  const shownKey = embedded ? embed.key : activeKey;

  // Remember the last embed rect so that when the embed goes away (e.g. the
  // Trees pane navigates to the all-agents overview, or a file diff is opened
  // over the terminal), the hidden overlay keeps the *same* geometry instead of
  // snapping to the full content area. That snap would resize the xterm grid and
  // make zsh reprint its prompt — a spurious blank prompt line every time you
  // came back. Frozen-at-last-size means no resize, so no reprint.
  const lastEmbedRect = useRef<Rect | null>(null);
  if (embedded && embedRect) lastEmbedRect.current = embedRect;

  const fullArea = {
    top: TOP_BAR,
    bottom: 0,
    left: sidebarCollapsed ? 0 : "var(--sidebar-width)",
    right: 0,
  };

  let style: CSSProperties;
  if (embedded) {
    style = {
      top: embedRect.top,
      left: embedRect.left,
      width: embedRect.width,
      height: embedRect.height,
      zIndex: 30,
    };
  } else if (onTerminal) {
    style = { ...fullArea, zIndex: 5 };
  } else if (lastEmbedRect.current) {
    // Hidden, but frozen at the last embed size (see above).
    const r = lastEmbedRect.current;
    style = { top: r.top, left: r.left, width: r.width, height: r.height, zIndex: -1 };
  } else {
    style = { ...fullArea, zIndex: -1 };
  }

  return (
    <div
      className={`fixed bg-panel ${visible ? "" : "invisible pointer-events-none"}`}
      style={style}
    >
      {tabs.length === 0 && onTerminal && !embedded ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <div className="text-[14px] font-medium text-fg-2">No terminals open</div>
          <button
            type="button"
            onClick={() => open({ title: "shell", cwd: repoPath })}
            className="cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium text-[color:var(--on-accent)]"
            style={{ background: "var(--accent)" }}
          >
            New terminal
          </button>
        </div>
      ) : (
        tabs.map((t) => (
          // Keep every pane laid out at full size (not display:none) so xterm
          // never reflows from a zero-size state when switching panes/tabs.
          <div
            key={t.key}
            className={`absolute inset-0 p-2 ${
              t.key === shownKey ? "" : "invisible pointer-events-none"
            }`}
          >
            <TerminalView
              cwd={t.cwd}
              command={t.command}
              args={t.args}
              env={t.env}
              seed={t.seed}
              active={visible && t.key === shownKey}
              onExit={() => {
                // The process ended — drop the session (so the pane disappears
                // instead of showing a dead terminal) and release any embed.
                if (embed?.key === t.key) setEmbed(null);
                close(t.key);
              }}
            />
          </div>
        ))
      )}
    </div>
  );
}
