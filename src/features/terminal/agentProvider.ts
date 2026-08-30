import type { AgentKind, AgentSession, Settings } from "../../bindings";

/**
 * A launch, as **structured data**: what the user configured, never how a
 * particular CLI spells it. Each provider's [`AgentLaunchSpec`] turns this into
 * its own argv, and the whole thing is serialised into one shell word list
 * exactly once, at the PTY boundary ([`agentSessionSeed`]).
 *
 * That direction matters. The previous shape took *pre-spelled* fragments
 * (`modelFlag: "--model 'opus'"`), so every call site had to know Claude's flag
 * names, Claude's quoting, and which of them Codex must not receive — four
 * components each assembling a slightly different version of one command line.
 * The comparators show where the string route ends: one of them carries a shell
 * tokenizer, an executable-position finder and a span splicer just to edit the
 * command it built, dispatched by `if (agent === 'claude')`.
 *
 * Two fields arrive pre-quoted and stay opaque, because Rust built them and
 * nothing here may second-guess their content: `hookFlag` (`hooks.rs`) and the
 * session's own `launchFlags` (`codex_config.rs`).
 */
export interface AgentLaunchConfig {
  /** The first message, seeded on a fresh start only — a resume continues a
   *  conversation that already has one. */
  prompt?: string;
  /**
   * The provider `model` / `effort` / `permissionMode` were read for. Those
   * settings are per provider, so when the resolved session turns out to run a
   * *different* one — a persisted Codex investigation reopened from a
   * Claude-configured surface — they are somebody else's values and are
   * dropped rather than passed on. Omit only where the two cannot differ.
   */
  configuredFor?: AgentKind;
  model?: string | null;
  effort?: string | null;
  /** Claude's `--permission-mode`. Empty/absent means "the CLI's default" —
   *  santree never selects a permissive one (COMPLIANCE.md). */
  permissionMode?: string | null;
  /** The name to register with Claude's Remote Control web (we pass the ticket
   *  id). `null` when the user turned it off, or the surface doesn't use it. */
  remoteControl?: string | null;
  chrome?: boolean;
  /** santree's own MCP config file — the AI review's tool server. */
  mcpConfigPath?: string | null;
  /** santree's session hooks in whatever form this provider takes them
   *  (Claude's `--settings <file>`, Codex's `-c 'hooks.<Event>=[…]'`), built in
   *  Rust and already shell-quoted. Comes from `useHookInjection`, which is the
   *  one place that picks the mechanism. */
  hookFlag?: string;
  /** The surface's identity, exported so the hook binary knows which row to
   *  update. Both or neither. */
  repo?: string;
  termKey?: string;
}

/** A session santree can actually launch — everything but a plain shell. */
type LaunchableSession = Exclude<AgentSession, { type: "shell" }>;

/**
 * How one CLI spells a launch: three ordered lists of shell words that follow
 * the binary. A new provider is this record plus its capabilities — not an edit
 * to every component that opens a terminal.
 */
export interface AgentLaunchSpec {
  /** What every launch of this provider carries, fresh or resumed. */
  common: (session: LaunchableSession, config: AgentLaunchConfig) => string[];
  /** What only a *fresh* start adds — the settings a resumed session keeps for
   *  itself, and the id santree reserved for it. */
  fresh: (session: Extract<AgentSession, { type: "fresh" }>, config: AgentLaunchConfig) => string[];
  /**
   * How this CLI is told to continue session `id`.
   *
   * **The one definition.** The seed the PTY runs and the command the Session
   * history pane copies to the clipboard are the same invocation with different
   * wrappers, and writing it twice is how it drifts: a comparator with this
   * exact duplication already resumes one of its agents by session id in one
   * spelling and by transcript path in the other.
   */
  resume: (sessionId: string) => string[];
}

export interface ProviderCapabilities {
  cliLaunchOptions: boolean;
  modelSource: "claude" | "codex" | "catalog";
  effort: boolean;
  permissionMode: boolean;
  remoteControl: boolean;
  terminalSettings: "claude" | null;
  settingsPanel: "cli" | "codex" | "unsupported";
  /** How santree injects its session hooks at launch, which is what makes an
   *  agent's sessions resumable and visible in the registry.
   *
   *  `"settings-file"` — Claude takes a `--settings <path>` JSON file.
   *  `"config-flags"`  — Codex takes `-c 'hooks.<Event>=[…]'` config overrides,
   *                      per launch, so nothing the user owns is written.
   *  `null`            — the provider has no hook mechanism; its sessions are
   *                      only as visible as the PTY it runs in. */
  hookInjection: "settings-file" | "config-flags" | null;
}

interface AgentProviderContract {
  label: string;
  defaultExecutable: string;
  capabilities: ProviderCapabilities;
  /** `null` for a provider santree cannot drive: a tab for it opens as a plain
   *  shell, and it has no resume line to copy either. */
  launch: AgentLaunchSpec | null;
}

export function shellQuote(value: string): string {
  const sanitized = Array.from(value.replace(/\n/g, " "))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return !(code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f));
    })
    .join("");
  return `'${sanitized.replace(/'/g, `'\\''`)}'`;
}

/** `--flag 'value'`, or nothing when the value is absent or blank. Trailing
 *  whitespace is the user's, not a value. */
function flag(name: string, value: string | null | undefined): string[] {
  const trimmed = value?.trim();
  return trimmed ? [name, shellQuote(trimmed)] : [];
}

const providers: Record<AgentKind, AgentProviderContract> = {
  Claude: {
    label: "Claude Code",
    defaultExecutable: "claude",
    capabilities: {
      cliLaunchOptions: true,
      modelSource: "claude",
      effort: true,
      permissionMode: true,
      remoteControl: true,
      terminalSettings: "claude",
      settingsPanel: "cli",
      hookInjection: "settings-file",
    },
    launch: {
      common: (_session, config) => [
        ...flag("--remote-control", config.remoteControl),
        // Pre-quoted in Rust: one word already, whatever it contains.
        ...(config.hookFlag ? [config.hookFlag] : []),
        ...flag("--mcp-config", config.mcpConfigPath),
        // A launch-time capability, so it applies to a resume too.
        ...(config.chrome ? ["--chrome"] : []),
        ...flag("--permission-mode", config.permissionMode),
      ],
      fresh: (session, config) => [
        // Model and effort are fresh-only: a resumed session keeps its own.
        ...flag("--model", config.model),
        ...flag("--effort", config.effort),
        // `--session-id` only when santree chose one. The field is nullable
        // because Codex mints its own id and reports it back through a hook;
        // Claude always gets one from us, so this is type honesty, not a case
        // the launch path is expected to hit.
        ...flag("--session-id", session.sessionId),
      ],
      resume: (sessionId) => ["--resume", shellQuote(sessionId)],
    },
  },
  Codex: {
    label: "Codex",
    defaultExecutable: "codex",
    capabilities: {
      cliLaunchOptions: false,
      modelSource: "codex",
      effort: true,
      permissionMode: false,
      remoteControl: false,
      terminalSettings: null,
      settingsPanel: "codex",
      hookInjection: "config-flags",
    },
    launch: {
      // The plain CLI, not an App Server attachment. `resume --remote <socket>`
      // routed every Codex TUI through one santree-owned `codex app-server`,
      // which enforces a single writer per thread — so a re-launch against a
      // thread whose previous process still held the lock failed outright with
      // "already has an active writer" and dropped the tab to a bare shell.
      // Orca and Superset both spawn the plain binary; so do we now.
      //
      // Codex's model, effort, sandbox, approval policy and — for a review —
      // santree's own MCP tool server are NOT assembled here: they are resolved
      // backend-side (`codex_config.rs`) against the surface and ride on the
      // session, so no launch site can omit them. Everything below is what a
      // *call site* legitimately owns.
      common: (session, config) => [
        // Codex's hooks are injected per launch (`-c 'hooks.<Event>=[…]'`), built
        // backend-side where the bundled hook binary's path is known. They are
        // SILENTLY skipped without the trust bypass — re-verified on codex-cli
        // 0.150.1 in an isolated CODEX_HOME: no hook ran, and no warning or error
        // said so — so the flag rides with the injection and never alone.
        //
        // The flag is not scoped to our hook: it lifts the trust gate for every
        // enabled hook in that invocation, the user's own global ones included
        // (for that session only — nothing is persisted). Trusting just ours is
        // possible in principle and measured to work; see `hooks.rs`
        // `codex_hook_flags` for the key format, and for the one piece missing.
        ...(config.hookFlag ? ["--dangerously-bypass-hook-trust", config.hookFlag] : []),
        // What this session runs *under*, already shell-quoted by Rust. It rides
        // on the session precisely so a call site cannot drop it: a review that
        // launched without `--sandbox read-only` would come back with write
        // access, and one without its MCP server with nowhere to record a
        // finding. Top-level options (`codex [OPTIONS] <COMMAND>`), so they
        // precede `resume` rather than sitting between it and its id.
        ...(session.launchFlags ? [session.launchFlags] : []),
      ],
      // No id on a fresh launch: Codex has no launch-time id flag. It mints one
      // and the `SessionStart` hook reports it back, which is what binds the
      // session to this surface for the next resume.
      //
      // That report does NOT arrive at launch. Codex creates the thread on the
      // first submitted turn and fires `SessionStart` there, so a tab opened and
      // left at the prompt reports nothing at all (verified on codex-cli 0.151.0
      // — see `hooks.rs` `CODEX_EVENTS`). Anything that must show a Codex agent
      // before it has been spoken to reads santree's own launch, not the hook.
      fresh: () => [],
      resume: (sessionId) => ["resume", shellQuote(sessionId)],
    },
  },
  Cursor: {
    label: "Cursor",
    defaultExecutable: "cursor-agent",
    capabilities: {
      cliLaunchOptions: false,
      modelSource: "catalog",
      effort: false,
      permissionMode: false,
      remoteControl: false,
      terminalSettings: null,
      settingsPanel: "unsupported",
      hookInjection: null,
    },
    launch: null,
  },
  Opencode: {
    label: "OpenCode",
    defaultExecutable: "opencode",
    capabilities: {
      cliLaunchOptions: false,
      modelSource: "catalog",
      effort: false,
      permissionMode: false,
      remoteControl: false,
      terminalSettings: null,
      settingsPanel: "unsupported",
      hookInjection: null,
    },
    launch: null,
  },
};

export function agentProvider(kind: AgentKind): AgentProviderContract {
  return providers[kind];
}

export function sessionAgent(session: AgentSession | undefined, requested: AgentKind): AgentKind {
  return session && session.type !== "shell" ? (session.agentKind ?? requested) : requested;
}

export function providerExecutable(
  settings: Settings | null | undefined,
  kind: AgentKind,
  requestedExecutable?: string,
): string {
  return (
    settings?.agents?.find((agent) => agent.key === kind)?.exec?.trim() ||
    requestedExecutable?.trim() ||
    agentProvider(kind).defaultExecutable
  );
}

/**
 * Drop the per-provider settings when the session turns out to run a different
 * provider than the one they were read for. A worktree configured for Codex
 * whose stored session is a Claude one must not hand Codex's model name to
 * `claude --model`.
 */
function scopedToSession(session: LaunchableSession, config: AgentLaunchConfig): AgentLaunchConfig {
  if (!config.configuredFor || config.configuredFor === session.agentKind) return config;
  return { ...config, model: null, effort: null, permissionMode: null };
}

/** `env NAME=value …` — the attribution channel santree's hook binary reads to
 *  bind the id the CLI mints to the surface that launched it. Both halves or
 *  neither: a partial pair names nothing. */
function envWords(config: AgentLaunchConfig): string[] {
  if (!config.repo || !config.termKey) return [];
  return [
    "env",
    `SANTREE_REPO=${shellQuote(config.repo)}`,
    `SANTREE_TERM_KEY=${shellQuote(config.termKey)}`,
  ];
}

/**
 * The shell command that (re)launches an agent in a terminal, from a
 * backend-resolved {@link AgentSession} and a provider-neutral
 * {@link AgentLaunchConfig}. `undefined` for a plain shell, or a provider
 * santree cannot drive.
 *
 * `exec <bin>` replaces the login shell so quitting the agent ends the PTY — and
 * the next time the tab opens, the session has a record on disk, so the backend
 * resolves it to a resume instead of a fresh start.
 *
 * This is the single serialisation point: everything above it is typed data,
 * everything below it is bytes the PTY runs. Built **once**, when a human opens
 * a tab, and applied at session creation — never re-parsed, never re-emitted
 * (COMPLIANCE.md: no output-parsing influences input, no unattended loop).
 */
export function agentSessionSeed(
  session: AgentSession | undefined,
  config: AgentLaunchConfig = {},
): string | undefined {
  if (!session || session.type === "shell") return undefined;
  const spec = agentProvider(session.agentKind).launch;
  if (!spec) return undefined;

  const scoped = scopedToSession(session, config);
  const words = [
    "exec",
    ...envWords(scoped),
    shellQuote(session.executable),
    ...spec.common(session, scoped),
  ];
  if (session.type === "resume") {
    words.push(...spec.resume(session.sessionId));
  } else {
    words.push(...spec.fresh(session, scoped));
    if (scoped.prompt !== undefined) words.push(shellQuote(scoped.prompt));
  }
  return words.join(" ");
}

/**
 * The same invocation a launched session runs, as a line a user can paste into
 * their own terminal. `null` for a provider with no resume path.
 *
 * The only legitimate difference from the seed is the wrapper: a PTY session
 * gets its working directory from the spawn, while a pasted command has to say
 * it — and it is load-bearing, since Claude looks a conversation up under the
 * directory it ran in. The invocation itself comes from the provider's one
 * {@link AgentLaunchSpec.resume}, so the copied line and the seeded one cannot
 * disagree about how this CLI is resumed.
 */
export function resumeInvocation(
  kind: AgentKind,
  sessionId: string,
  cwd?: string | null,
): string | null {
  const { defaultExecutable, launch } = agentProvider(kind);
  if (!launch) return null;
  // The plain binary name, not santree's resolved path: this is typed by a
  // human into their own shell, where their own PATH applies.
  const invocation = [defaultExecutable, ...launch.resume(sessionId)].join(" ");
  return cwd ? `cd ${shellQuote(cwd)} && ${invocation}` : invocation;
}
