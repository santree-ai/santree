/**
 * Fake PTYs for the demo world. A pane the app opens inside a demo checkout
 * gets a scripted agent screen (`screens.ts`) instead of a process, repainted
 * while the script "works" so the spinner and the steps move; anything else —
 * a Daedalus terminal, a real shell — goes to the real PTY manager.
 */
import type { Channel } from "@tauri-apps/api/core";

import type {
  AgentKind,
  TerminalAttached,
  TerminalOpenOpts,
  TerminalSession,
} from "../../../bindings";
import { blue, dim, green, magenta } from "../transcript";
import { HOME, REPO_PATH } from "./company";
import { BRANCH } from "./prs";
import { isDone, renderScreen } from "./screens";
import { findWt, type Job, jobForPane, jobSecs, jobs } from "./state";

interface FakePty {
  id: number;
  label: string;
  agentKind: AgentKind | null;
  cwd: string;
  cols: number;
  rows: number;
  channel: Channel<ArrayBuffer> | null;
  job: Job | null;
  timer: ReturnType<typeof setInterval> | null;
}

const FIRST_ID = 91_001;
const ptys = new Map<number, FakePty>();
let nextId = FIRST_ID;
const encoder = new TextEncoder();

export const isFakePty = (id: unknown): id is number => typeof id === "number" && ptys.has(id);

/** The demo repo and worktree a cwd belongs to, if it is a demo checkout. */
export function locate(cwd: string | null): { repo: string; worktreeId: string } | null {
  if (!cwd?.startsWith(`${HOME}/`)) return null;
  for (const [repo, path] of Object.entries(REPO_PATH)) {
    if (cwd === path) return { repo, worktreeId: "__base__" };
    const prefix = `${path}/.santree/worktrees/`;
    if (cwd.startsWith(prefix)) return { repo, worktreeId: cwd.slice(prefix.length).split("/")[0] };
  }
  return null;
}

function shellScreen(pty: FakePty): string {
  const where = locate(pty.cwd);
  const branch =
    (where && findWt(where.repo, where.worktreeId)?.branch) ??
    (where?.worktreeId && where.worktreeId in BRANCH
      ? BRANCH[where.worktreeId as keyof typeof BRANCH]
      : "main");
  const home = pty.cwd.replace(/^\/Users\/[^/]+/, "~");
  const prompt = `${blue(home)} ${dim("on")} ${magenta(` ${branch}`)}`;
  return `\x1b[2J\x1b[H${prompt}\r\n${green("❯")} `;
}

function paint(pty: FakePty) {
  if (!pty.channel) return;
  const text = pty.job
    ? renderScreen(pty.job.script, {
        kind: pty.job.kind,
        cwd: pty.cwd,
        cols: pty.cols,
        rows: pty.rows,
        secs: Math.max(0, jobSecs(pty.job)),
      })
    : shellScreen(pty);
  const bytes = encoder.encode(text);
  // A fresh buffer of exactly the encoded length: an empty one is the exit
  // sentinel, which this never is.
  pty.channel.onmessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Repaint on a beat while the job is working; once more when it finishes. */
function animate(pty: FakePty) {
  if (pty.timer) clearInterval(pty.timer);
  paint(pty);
  if (!pty.job) return;
  pty.timer = setInterval(() => {
    paint(pty);
    if (pty.job && isDone(pty.job.script, jobSecs(pty.job)) && pty.timer) {
      clearInterval(pty.timer);
      pty.timer = null;
    }
  }, 250);
}

export function openFake(opts: TerminalOpenOpts, channel: Channel<ArrayBuffer>): number {
  const where = locate(opts.cwd);
  const id = nextId++;
  const cwd = opts.cwd ?? HOME;
  const pty: FakePty = {
    id,
    label: opts.label,
    agentKind: opts.agentKind,
    cwd,
    cols: opts.cols,
    rows: opts.rows,
    channel,
    job:
      opts.agentKind && where
        ? jobForPane(opts.label, opts.agentKind, cwd, where.repo, where.worktreeId)
        : null,
    timer: null,
  };
  ptys.set(id, pty);
  setTimeout(() => animate(pty), 40);
  return id;
}

export function attachFake(id: number, channel: Channel<ArrayBuffer>): TerminalAttached {
  const pty = ptys.get(id);
  if (pty) {
    pty.channel = channel;
    animate(pty);
  }
  return { epoch: "demo", seq: null, mode: "reanchor" };
}

export function resizeFake(id: number, cols: number, rows: number) {
  const pty = ptys.get(id);
  if (!pty || (pty.cols === cols && pty.rows === rows)) return;
  pty.cols = cols;
  pty.rows = rows;
  paint(pty);
}

export function detachFake(id: number) {
  const pty = ptys.get(id);
  if (!pty) return;
  pty.channel = null;
  if (pty.timer) clearInterval(pty.timer);
  pty.timer = null;
}

export function closeFake(id: number) {
  const pty = ptys.get(id);
  if (pty?.timer) clearInterval(pty.timer);
  if (pty?.job) jobs.delete(pty.job.termKey);
  ptys.delete(id);
}

export function fakeSessions(): TerminalSession[] {
  return [...ptys.values()].map((p) => ({
    id: p.id,
    label: p.label,
    cwd: p.cwd,
    command: p.agentKind === "Codex" ? "codex" : p.agentKind ? "claude" : "/bin/zsh",
    pid: 52_000 + (p.id - FIRST_ID),
    cols: p.cols,
    rows: p.rows,
    attached: p.channel !== null,
    alive: true,
  }));
}

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
