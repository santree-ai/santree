/**
 * The hidden **Dev** tab — dogfooding santree development inside santree.
 *
 * Gated to the developer's GitHub login (see useDevEnabled). One configurable
 * checkout of santree itself, and around it: a persistent Claude session rooted
 * there (same resume mechanics as a worktree tab), a Build pane that runs
 * `pnpm tauri build` as a background process and streams it into a read-only
 * log, DMG install with a quit → drag → auto-reopen flow, an app-log tail, and
 * the TODO sidebar (TodoPanel).
 *
 * Deliberately self-contained (this folder + src-tauri/src/dev.rs + one
 * migration + a delimited hooks block in lib/queries.ts) so the whole feature
 * can be deleted cleanly if it doesn't survive to a public release.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Channel } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { commands, type DevInfo, type StreamEvent } from "../../bindings";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { OutputPane } from "../../components/OutputPane";
import { Button, ConfirmDialog, EmptyState, Tabs } from "../../components/primitives";
import {
  DEV_REPO_PATH_KEY,
  queryKeys,
  useDevEject,
  useDevInfo,
  useDevInstall,
  useDevNormalizeRepo,
  useDevTodoPrompt,
  useSetSetting,
  useSetting,
} from "../../lib/queries";
import { formatRelativeTime, useLiveNow } from "../../lib/relativeTime";
import { useApp } from "../../state/AppContext";
import { markStopped, startRun } from "../../state/streamRuns";
import { toast } from "../../state/toast";
import { useStreamRun } from "../../state/useStreamRun";
import { useTerminals } from "../terminal/TerminalsContext";
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";
import { useAgentTab } from "../trees/useAgentTab";
import { DevFilesPane } from "./DevFilesPane";
import { DevReleasePane } from "./DevReleasePane";
import { TodoPanel } from "./TodoPanel";
import { useDevEnabled } from "./useDevEnabled";

/** `terminal_sessions` is keyed `(repo, term_key)`; Dev sessions live under a
 *  sentinel repo so they can never collide with a registered repo's keys (and
 *  survive repo add/remove churn). */
const DEV_SESSION_REPO = "@dev";
/** The Claude session's identity. Includes the checkout path, so pointing Dev
 *  at a different clone starts a separate conversation instead of `--resume`ing
 *  one whose transcript lives under the old cwd. */
const devRefId = (repoPath: string) => `dev:${repoPath}`;

/** Uniquifies log session refIds across pane remounts (module scope, so
 *  navigating away and back never reuses a dead session's id for a new run). */
let devTermSeq = 0;

/** The build run's key in `streamRuns`. Per checkout, matching the backend's own
 *  run key, so two checkouts can build at once and one can't build twice. */
const devBuildKey = (repoPath: string) => `dev-build:${repoPath}`;

type Pane = "claude" | "files" | "release" | "build" | "log";

export function DevView() {
  const { enabled, fetched } = useDevEnabled();
  const navigate = useNavigate();
  // Guard like the other gated views: an unavailable tab redirects home.
  useEffect(() => {
    if (fetched && !enabled) navigate({ to: "/" });
  }, [fetched, enabled, navigate]);

  const repoPath = useSetting("app", DEV_REPO_PATH_KEY);

  // `DevContent` mounts its own chrome rather than being wrapped here: the bug
  // list is the view's left column, and it goes through `ViewChrome`'s `sidebar`
  // (so the top bar's divider lines up with it) — which needs the send handler
  // that lives inside `DevContent`.
  if (!enabled || !repoPath.isFetched) return <ViewChrome>{null}</ViewChrome>;
  if (!repoPath.data) {
    return (
      <ViewChrome>
        <PickRepo />
      </ViewChrome>
    );
  }
  return <DevContent repoPath={repoPath.data} />;
}

/** Pick + validate the santree checkout; stores its git toplevel. */
function useChooseRepo() {
  const normalize = useDevNormalizeRepo();
  const setSetting = useSetSetting();
  return useCallback(async () => {
    const picked = await openDialog({ directory: true, title: "Choose your santree checkout" });
    if (typeof picked !== "string") return;
    try {
      const root = await normalize.mutateAsync(picked);
      setSetting.mutate({ scope: "app", key: DEV_REPO_PATH_KEY, value: root });
    } catch {
      // the mutation's global error toast already fired
    }
  }, [normalize, setSetting]);
}

/** Centered copy + an action, for panes that have nothing to show yet. */
function CenterNote({
  title,
  subtitle,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <div className="text-[12.5px] text-muted-2">{title}</div>
      {subtitle && <div className="text-[11px] leading-[1.5] text-muted-4">{subtitle}</div>}
      {children && <div className="mt-2 flex items-center gap-2">{children}</div>}
    </div>
  );
}

function PickRepo() {
  const choose = useChooseRepo();
  return (
    <CenterNote
      title="Where does santree live?"
      subtitle="Pick your santree checkout. The Dev tab builds, installs, and runs Claude there."
    >
      <Button variant="primary" onClick={() => void choose()}>
        Choose folder…
      </Button>
    </CenterNote>
  );
}

function DevContent({ repoPath }: { repoPath: string }) {
  const qc = useQueryClient();
  const [pane, setPane] = useState<Pane>("claude");
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const info = useDevInfo(repoPath);
  const { tabs } = useTerminals();
  const todoPrompt = useDevTodoPrompt();

  const claudeLive = tabs.some((t) => t.source === "issue" && t.refId === devRefId(repoPath));

  // A log session started here keeps running in the TerminalLayer when this view
  // unmounts (tab switch). Deriving the active refId from the live tabs
  // re-attaches the pane on return instead of spawning a duplicate.
  const liveLogRefId =
    tabs.find((t) => t.source === "issue" && t.refId?.startsWith("dev-log:"))?.refId ?? null;

  // The build is a *background* run, not a terminal session (see `stream.rs`):
  // nothing to attach to, nothing to re-seed, and its transcript lives in
  // `streamRuns` keyed by checkout — so it keeps streaming while you're on
  // another pane or tab, and the last result stays until the next build.
  const buildKey = devBuildKey(repoPath);
  const build = useStreamRun(buildKey);
  const startBuild = useCallback(() => {
    setPane("build");
    startRun(
      buildKey,
      () => new Channel<StreamEvent>(),
      (channel) => commands.devBuild(repoPath, channel as Channel<StreamEvent>),
      Date.now(),
    );
  }, [buildKey, repoPath]);

  // A finished build changes what's on disk — the header's "DMG built / stale"
  // reading is only true after a refetch.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !build.running) {
      qc.invalidateQueries({ queryKey: queryKeys.devInfo(repoPath) });
    }
    wasRunning.current = build.running;
  }, [build.running, qc, repoPath]);

  const sendTodo = useCallback(
    async (id: string) => {
      try {
        const path = await todoPrompt.mutateAsync({ repoPath, id });
        const line = `Read ${path} and follow the instructions inside.`;
        setPane("claude");
        // Never write into a live session programmatically — the terminal layer
        // only seeds at creation (COMPLIANCE.md). The line always lands on the
        // clipboard; a *fresh* launch additionally seeds it (a `--resume` keeps
        // its conversation and ignores prompts, so the clipboard is the carrier
        // for both the live and the resumed case).
        await navigator.clipboard.writeText(line);
        if (!claudeLive) setPendingPrompt(line);
        toast.success(
          claudeLive
            ? "Prompt copied. Paste it into the Claude session."
            : "Prompt copied. It also seeds the Claude launch.",
        );
      } catch {
        // the mutation's global error toast already fired
      }
    },
    [claudeLive, repoPath, todoPrompt],
  );

  return (
    // The bug list is a plain panel, not a navigable tree, so the repo switcher
    // stays in the top bar rather than becoming a header above it — but the
    // column itself is ViewChrome's, which is what puts its right edge under the
    // top bar's divider (and gets it the shared width, resizer and collapse).
    <ViewChrome repoInTopBar sidebar={<TodoPanel onSend={sendTodo} />}>
      <div className="flex min-w-0 flex-1 flex-col">
        <DevBar
          repoPath={repoPath}
          info={info.data}
          pane={pane}
          onPane={setPane}
          onBuild={startBuild}
        />
        <div className="relative min-h-0 flex-1">
          {/* Conditional mounts are safe here: each pane's PTY lives in the
              global TerminalLayer keyed by refId, so remounting a host just
              re-attaches the overlay (the TreesView pattern). */}
          {pane === "claude" && (
            <DevClaudePane
              repoPath={repoPath}
              prompt={pendingPrompt}
              onPromptConsumed={() => setPendingPrompt(undefined)}
            />
          )}
          {pane === "files" && (
            <DevFilesPane repoPath={repoPath} repoName={info.data?.repoName ?? null} />
          )}
          {pane === "release" && <DevReleasePane repoPath={repoPath} />}
          {pane === "build" && (
            <DevBuildPane repoPath={repoPath} runKey={buildKey} onStart={startBuild} />
          )}
          {pane === "log" && (
            <DevLogPane logPath={info.data?.logPath ?? null} existingRefId={liveLogRefId} />
          )}
        </div>
      </div>
    </ViewChrome>
  );
}

function DevBar({
  repoPath,
  info,
  pane,
  onPane,
  onBuild,
}: {
  repoPath: string;
  info: DevInfo | undefined;
  pane: Pane;
  onPane: (p: Pane) => void;
  onBuild: () => void;
}) {
  const { accent } = useApp();
  const now = useLiveNow();
  const install = useDevInstall();
  const eject = useDevEject();
  const choose = useChooseRepo();
  const [confirmInstall, setConfirmInstall] = useState(false);

  return (
    <div className="flex flex-none flex-col border-b border-line bg-surface">
      <div className="flex h-9 items-center gap-2 pr-2">
        <Tabs<Pane>
          tabs={[
            { value: "claude", label: "Claude" },
            { value: "files", label: "Files" },
            { value: "release", label: "Release" },
            { value: "build", label: "Build" },
            { value: "log", label: "App log" },
          ]}
          value={pane}
          onChange={onPane}
          variant="inset"
          accent={accent}
          className="h-full items-stretch px-1"
          tabClassName="h-full"
        />
        <div className="flex-1" />
        <Button size="sm" variant="tinted" onClick={onBuild}>
          Build DMG
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!info?.dmgPath}
          title={info?.dmgPath ?? "No DMG built yet"}
          onClick={() => setConfirmInstall(true)}
        >
          Install…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => eject.mutate()}>
          Eject
        </Button>
      </div>
      <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-muted-3">
        <span className="flex-none font-mono">v{info?.appVersion ?? "…"}</span>
        {info && (
          <span className="flex-none">
            {info.runningInstalled ? "installed build" : "dev build"}
          </span>
        )}
        {info?.headSha && (
          <span
            className="min-w-0 truncate font-mono text-muted-2"
            title={info.headSubject ?? undefined}
          >
            {info.headSha}
            {info.dirtyFiles > 0 ? ` +${info.dirtyFiles} dirty` : ""} · {info.headSubject}
          </span>
        )}
        <span className="flex-1" />
        <span className="flex-none">
          {info?.dmgBuiltMs != null
            ? `DMG ${formatRelativeTime(info.dmgBuiltMs, now)}${info.dmgStale ? " · stale" : ""}`
            : "no DMG built"}
        </span>
        <button
          type="button"
          className="flex-none cursor-pointer text-muted-4 underline-offset-2 hover:text-fg-2 hover:underline"
          title={repoPath}
          onClick={() => void choose()}
        >
          change repo
        </button>
      </div>
      <ConfirmDialog
        open={confirmInstall}
        title="Install the new build?"
        message={
          info?.runningInstalled
            ? "The newest DMG opens for a drag-and-drop install. santree then quits so the app can be replaced. After you drop the new build into Applications it reopens itself and ejects the DMG."
            : "The newest DMG opens for a drag-and-drop install. You're running a dev build, so the app keeps running."
        }
        confirmLabel="Open DMG"
        busyLabel="Opening…"
        onConfirm={async () => {
          const quitting = await install.mutateAsync(repoPath);
          if (!quitting) toast.success("DMG opened. Drag santree into Applications.");
        }}
        onClose={() => setConfirmInstall(false)}
      />
    </div>
  );
}

/** The persistent Dev Claude session — same resume mechanics as a worktree's
 *  extra Claude tab, rooted in the checkout. `prompt` (a short `Read <path>`
 *  line) seeds the next fresh launch; on an exited session it auto-resumes,
 *  since the user just asked to send work there. */
function DevClaudePane({
  repoPath,
  prompt,
  onPromptConsumed,
}: {
  repoPath: string;
  prompt: string | undefined;
  onPromptConsumed: () => void;
}) {
  const { ended, preparing, seed, resume, onExited } = useAgentTab({
    repo: DEV_SESSION_REPO,
    refId: devRefId(repoPath),
    cwd: repoPath,
    agent: "Claude",
    // The pane exists to run Claude, so any open is an explicit launch.
    allowFresh: true,
    prompt,
  });

  // "Send to Claude" clicked while the session sat exited: relaunch with the
  // prompt seeded (user-initiated — the click is the launch).
  useEffect(() => {
    if (prompt && ended) resume();
  }, [prompt, ended, resume]);

  if (ended) {
    return (
      <CenterNote
        title="Claude session ended"
        subtitle="The conversation is kept. Resume it whenever you're ready."
      >
        <Button size="sm" variant="tinted" onClick={resume}>
          Resume session
        </Button>
      </CenterNote>
    );
  }
  if (preparing) {
    return (
      <EmptyState
        className="h-full"
        title="Starting Claude…"
        subtitle="The terminal opens in a moment."
      />
    );
  }
  return (
    <DevTerminalHost
      refId={devRefId(repoPath)}
      title="Dev · Claude"
      cwd={repoPath}
      seed={seed}
      onExited={onExited}
      onLaunched={prompt ? onPromptConsumed : undefined}
    />
  );
}

/** Runs `pnpm tauri build` in a real login shell so the full toolchain output
 *  streams live; the shell survives the build for inspection/re-runs. Each run
 *  is a fresh session (the previous one is closed by `startBuild`); a live one
 *  re-attaches by its refId. */
/** The build's output, streamed live and then kept: a finished build stays on
 *  screen (with its colours) until the next one is started, and one still running
 *  is picked back up here after leaving the tab — the transcript lives in
 *  `streamRuns`, not in this component. */
function DevBuildPane({
  repoPath,
  runKey,
  onStart,
}: {
  repoPath: string;
  runKey: string;
  onStart: () => void;
}) {
  const run = useStreamRun(runKey);
  const [stopping, setStopping] = useState(false);

  // A run that has never started has nothing to show; one that has keeps its
  // transcript, so the pane goes straight to the log on every later visit.
  if (run.startedMs === 0) {
    return (
      <CenterNote
        title="No build yet"
        subtitle="Builds the production DMG with pnpm tauri build (a few minutes). It keeps running if you leave this tab."
      >
        <Button size="sm" variant="tinted" onClick={onStart}>
          Build DMG
        </Button>
      </CenterNote>
    );
  }
  return (
    <OutputPane
      runKey={runKey}
      label="pnpm tauri build"
      stopping={stopping}
      // Re-grid the build's PTY to the pane, so cargo wraps its remaining output —
      // and draws its progress bar — to the width actually on screen.
      onResize={(cols, rows) => void commands.devResizeBuild(repoPath, cols, rows)}
      onStop={() => {
        setStopping(true);
        void commands.devCancelBuild(repoPath).finally(() => {
          markStopped(runKey);
          setStopping(false);
        });
      }}
    />
  );
}

/**
 * Colorize `tail`'s output by log level, as an awk filter.
 *
 * tauri-plugin-log writes a fixed shape — `[date][time][LEVEL][target] message`
 * (see `log_plugin()` in lib.rs) — so the level can be read positionally rather
 * than by hunting for the word anywhere in the line, which would also light up a
 * message that merely *mentions* "ERROR".
 *
 * The palette is deliberately quiet: the file is almost entirely INFO, so tinting
 * every line would just be noise. Timestamp and target are dimmed, the level tag
 * is tinted, and only ERROR carries its color into the message — that's the line
 * you're scrolling to find. Unparseable lines (panics, multi-line backtraces)
 * pass through untouched rather than being dropped.
 *
 * Plain POSIX awk: `match()`/`RLENGTH`, no gawk-only capture groups or ERE
 * intervals, so it behaves the same under macOS's BSD awk and Linux's gawk.
 * `fflush()` per line keeps `tail -f` feeling live instead of stalling in awk's
 * block buffer once stdout isn't a tty.
 *
 * SGR numbers, not hexes: xterm maps them through the terminal theme, so these
 * follow light/dark with everything else (see XtermRenderer's palettes).
 */
const LOG_COLORIZE = String.raw`
tail -n 200 -f "$1" | awk '
BEGIN { c["ERROR"]="1;31"; c["WARN"]="1;33"; c["INFO"]="36"; c["DEBUG"]="34"; c["TRACE"]="90" }
{
  if (match($0, /^\[[^]]*\]\[[^]]*\]\[[A-Z]+\]/)) {
    head = substr($0, 1, RLENGTH); rest = substr($0, RLENGTH + 1)
    for (i = length(head); i > 0; i--) if (substr(head, i, 1) == "[") break
    lvl = substr(head, i + 1, length(head) - i - 1)
    col = (lvl in c) ? c[lvl] : "0"
    tgt = ""
    if (match(rest, /^\[[^]]*\]/)) { tgt = substr(rest, 1, RLENGTH); rest = substr(rest, RLENGTH + 1) }
    printf "\033[2m%s\033[0m\033[%sm[%s]\033[0m\033[2m%s\033[0m", substr(head, 1, i - 1), col, lvl, tgt
    if (lvl == "ERROR") printf "\033[31m%s\033[0m\n", rest; else printf "%s\n", rest
  } else print
  fflush()
}'
`;

/** Tails the app's own log file — the fastest way to see what the running
 *  (installed) santree is logging while dogfooding. A live tail re-attaches by
 *  refId across pane/view remounts (`existingRefId`); the first visit opens one
 *  automatically, and after the user closes it, reopening is an explicit click
 *  (tail is read-only, so an auto-open duplicate would be the only harm). */
function DevLogPane({
  logPath,
  existingRefId,
}: {
  logPath: string | null;
  existingRefId: string | null;
}) {
  const [localRefId, setLocalRefId] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const refId = existingRefId ?? localRefId;

  const start = useCallback(() => {
    devTermSeq += 1;
    setLocalRefId(`dev-log:${devTermSeq}`);
    setClosed(false);
  }, []);

  useEffect(() => {
    if (logPath && !refId && !closed) start();
  }, [logPath, refId, closed, start]);

  if (!logPath) {
    return <CenterNote title="No log file" subtitle="The app log path couldn't be resolved." />;
  }
  if (!refId) {
    return (
      <CenterNote title="Log tail closed">
        <Button size="sm" variant="tinted" onClick={start}>
          Reopen
        </Button>
      </CenterNote>
    );
  }
  return (
    <DevTerminalHost
      refId={refId}
      title="Dev · Log"
      command="sh"
      // The path rides in as `$1` rather than being interpolated into the script
      // text, so a path with a space (or a quote) can't break out into `sh`.
      args={["-c", LOG_COLORIZE, "sh", logPath]}
      onExited={() => {
        setLocalRefId(null);
        setClosed(true);
      }}
    />
  );
}

/** Thin embed host (the WorktreeTerminal pattern): the PTY + xterm live in the
 *  global TerminalLayer keyed by `refId`; this just points the layer at a host
 *  element and reports launch/exit. */
function DevTerminalHost({
  refId,
  title,
  cwd,
  command,
  args,
  seed,
  onExited,
  onLaunched,
}: {
  refId: string;
  title: string;
  cwd?: string;
  command?: string;
  args?: string[];
  seed?: string;
  onExited?: () => void;
  /** Fired once after mount when a seed was provided (clears one-shot flags). */
  onLaunched?: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title, cwd, command, args, seed, source: "issue", refId },
    onExited,
  });

  const consumed = useRef(false);
  useEffect(() => {
    if (seed && !consumed.current) {
      consumed.current = true;
      onLaunched?.();
    }
  }, [seed, onLaunched]);

  return <div ref={hostRef} className="h-full w-full" />;
}
