/**
 * Turn the demo mode on (`VITE_SANTREE_FIXTURES=demo`): open a pane for every
 * agent already at work so the sidebar counts them live from the first paint,
 * hand the query client to the state module so scripted changes can refresh
 * the views, bind the presenter's shortcuts, and land on the opening scene —
 * the Tickets graph. The commands themselves are answered by `bindings.ts`,
 * which `vite.config.ts` resolves in place of `src/bindings.ts`.
 */
import type { QueryClient } from "@tanstack/react-query";

import type { TerminalSpec } from "../../../features/terminal/orchestrator";
import { resetDemo, saveStartingPoint, snapshotOnce } from "./reset";
import {
  type AgentSpeed,
  attachQueryClient,
  jobs,
  OPENING_AGENTS,
  setAgentSpeed,
  startClock,
} from "./state";

/** A string only the demo world contains, for `scripts/check-no-demo-in-dist.mjs`
 *  to find if this module ever reaches a production bundle. */
export const DEMO_MARKER = "santree-demo-world";

function terminalSpecs(): TerminalSpec[] {
  return OPENING_AGENTS.map((a) => {
    const job = jobs.get(a.termKey);
    return {
      title: a.tab.title,
      cwd: job?.cwd ?? "",
      command: "",
      source: "issue",
      refId: a.termKey,
      agent: { kind: a.kind, repo: a.repo, termKey: a.termKey },
    };
  });
}

/** Only the view state the opening scene depends on; the rest is left as the
 *  presenter last had it (theme, sidebar width). */
function applyScene() {
  const set = (k: string, v: unknown) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // Storage refused: the app falls back to its defaults, which also work.
    }
  };
  set("santree.tickets.mode", "graph");
  set("santree.tickets.actionableOnly", false);
  set("santree.agents.seenAt", {});
  set("santree.shell.projectTree.collapsed", {});
  history.replaceState(null, "", "/issues");
}

/** A one-line confirmation, bottom-left, built here rather than with the
 *  app's toasts so no app component has to know the demo exists. */
function flash(text: string) {
  let el = document.getElementById(DEMO_MARKER);
  if (!el) {
    el = document.createElement("div");
    el.id = DEMO_MARKER;
    el.setAttribute("role", "status");
    Object.assign(el.style, {
      position: "fixed",
      left: "16px",
      bottom: "36px",
      zIndex: "2147483647",
      padding: "6px 10px",
      borderRadius: "6px",
      background: "rgba(20, 20, 22, 0.88)",
      color: "#f4f4f5",
      font: "500 12px/1.3 system-ui, sans-serif",
      pointerEvents: "none",
      transition: "opacity 200ms ease",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = "1";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (el) el.style.opacity = "0";
  }, 1200);
}
let flashTimer: ReturnType<typeof setTimeout> | undefined;

const SPEED_KEYS: Record<string, AgentSpeed> = { Digit1: 1, Digit2: 1.5, Digit3: 2, Digit4: 3 };

/** ⌃⌥⌘ chords, matched on `code` because ⌥ changes what `key` reports. Capture
 *  phase so a focused terminal or editor can't swallow them first. */
function onKeyDown(e: KeyboardEvent) {
  if (!(e.ctrlKey && e.altKey && e.metaKey) || e.shiftKey) return;
  const speed = SPEED_KEYS[e.code];
  let action: (() => void) | null = null;
  if (speed !== undefined) {
    action = () => {
      setAgentSpeed(speed);
      flash(`Demo speed ${speed}×`);
    };
  } else if (e.code === "KeyR") {
    action = () => {
      flash("Resetting demo…");
      void resetDemo();
    };
  } else if (e.code === "KeyS") {
    action = () => {
      void saveStartingPoint().then(() => flash("Starting point saved"));
    };
  }
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  action();
}

export async function installDemo(queryClient: QueryClient): Promise<void> {
  attachQueryClient(queryClient);
  startClock();
  globalThis.__santreeFixtureTerminals = terminalSpecs();
  applyScene();
  window.addEventListener("keydown", onKeyDown, { capture: true });
  // The first boot is what ⌃⌥⌘R returns to, until ⌃⌥⌘S saves another.
  await snapshotOnce();
  console.info(
    `[santree] ${DEMO_MARKER}: demo mode on (⌃⌥⌘R reset · ⌃⌥⌘1–4 speed · ⌃⌥⌘S save start)`,
  );
}
