/**
 * Fake PTYs for the fixture world.
 *
 * The app opens a terminal for every pane it shows (and, through
 * `fixtureSeam.ts`, for every fake agent), talks to it by numeric session id,
 * and paints whatever bytes come back through its output channel. This module
 * answers those calls for ids it minted — high numbers, so they can never
 * collide with a real session — and paints a scripted transcript into the
 * channel instead of a process. Everything else passes through to the real
 * PTY manager.
 */
import type { Channel } from "@tauri-apps/api/core";

import type {
  AgentKind,
  TerminalAttached,
  TerminalOpenOpts,
  TerminalSession,
} from "../../bindings";
import { renderTranscript } from "./transcript";
import { agentByTermKey, type TranscriptKind, worktrees } from "./world";

interface FakePty {
  id: number;
  label: string;
  agentKind: AgentKind | null;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  channel: Channel<ArrayBuffer> | null;
  transcript: TranscriptKind;
  repaint: ReturnType<typeof setTimeout> | null;
}

const FIRST_ID = 90_001;
const ptys = new Map<number, FakePty>();
let nextId = FIRST_ID;
const encoder = new TextEncoder();

export const isFakePty = (id: unknown): id is number => typeof id === "number" && ptys.has(id);

/** Whether a label names a surface the fixture world owns. Real shells the user
 *  opens elsewhere (none, in practice) keep going to the real backend. */
export const ownsLabel = (label: string) =>
  label.startsWith("tree:") || label.startsWith("triage:") || label.startsWith("ai-review:");

function transcriptFor(label: string, agentKind: AgentKind | null): TranscriptKind {
  const agent = agentByTermKey(label);
  if (agent) return agent.transcript;
  if (agentKind === "Codex") return "codex-dark-mode";
  if (agentKind) return "claude-idle";
  return "shell";
}

function branchFor(cwd: string): string {
  const id = cwd.split("/").pop() ?? "";
  for (const repo of [
    "mallard-labs/quackstack",
    "mallard-labs/pond-infra",
    "mallard-labs/beak-cli",
  ]) {
    const w = worktrees(repo, Date.now()).find((w) => w.id === id);
    if (w) return w.branch;
  }
  return "main";
}

function paint(pty: FakePty) {
  if (!pty.channel) return;
  const text = renderTranscript(pty.transcript, pty.cols, {
    cwd: pty.cwd,
    branch: branchFor(pty.cwd),
  });
  const bytes = encoder.encode(text);
  // A fresh buffer of exactly the encoded length — the channel hands the pane
  // an `ArrayBuffer`, and an empty one is the exit sentinel, which this never is.
  pty.channel.onmessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Repaint a beat after the last geometry change, the way a TUI settles. */
function schedulePaint(pty: FakePty) {
  if (pty.repaint) clearTimeout(pty.repaint);
  pty.repaint = setTimeout(() => {
    pty.repaint = null;
    paint(pty);
  }, 60);
}

export function openFake(opts: TerminalOpenOpts, channel: Channel<ArrayBuffer>): number {
  const id = nextId++;
  const pty: FakePty = {
    id,
    label: opts.label,
    agentKind: opts.agentKind,
    cwd: opts.cwd ?? "/Users/sam/dev/mallard-labs/quackstack",
    command: opts.command || "/bin/zsh",
    cols: opts.cols,
    rows: opts.rows,
    channel,
    transcript: transcriptFor(opts.label, opts.agentKind),
    repaint: null,
  };
  ptys.set(id, pty);
  schedulePaint(pty);
  return id;
}

export function attachFake(id: number, channel: Channel<ArrayBuffer>): TerminalAttached {
  const pty = ptys.get(id);
  if (pty) {
    pty.channel = channel;
    schedulePaint(pty);
  }
  return { epoch: "fixture", seq: null, mode: "reanchor" };
}

export function resizeFake(id: number, cols: number, rows: number) {
  const pty = ptys.get(id);
  if (!pty || (pty.cols === cols && pty.rows === rows)) return;
  pty.cols = cols;
  pty.rows = rows;
  schedulePaint(pty);
}

export function detachFake(id: number) {
  const pty = ptys.get(id);
  if (pty) pty.channel = null;
}

export function closeFake(id: number) {
  ptys.delete(id);
}

/** The fake sessions, in the shape the real registry reports its own. */
export function fakeSessions(): TerminalSession[] {
  return [...ptys.values()].map((p) => ({
    id: p.id,
    label: p.label,
    cwd: p.cwd,
    command: p.command,
    pid: 40_000 + (p.id - FIRST_ID),
    cols: p.cols,
    rows: p.rows,
    attached: p.channel !== null,
    alive: true,
  }));
}

/** Which agent the (fake) process table sees in each fake pane. */
export function fakeAgentProcesses(): {
  termKey: string;
  paneAgentKind: AgentKind | null;
  agentKind: AgentKind;
}[] {
  return [...ptys.values()]
    .filter((p) => p.agentKind !== null)
    .map((p) => ({
      termKey: p.label,
      paneAgentKind: p.agentKind,
      agentKind: p.agentKind as AgentKind,
    }));
}
