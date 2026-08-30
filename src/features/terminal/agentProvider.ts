import type { AgentKind, AgentSession, Settings } from "../../bindings";

/**
 * Per-launch inputs a call site supplies. Everything here is **Claude's** launch
 * line except `prompt`, `repo`/`termKey` and `settingsFlag`: Claude's model,
 * effort, MCP config and permission mode are assembled by the caller from
 * settings, while Codex's equivalents ride on the resolved session
 * (`AgentSession.launchFlags`), built in Rust by `codex_config.rs`.
 *
 * That split is not cosmetic. A Codex sandbox, approval policy and review tool
 * server are security configuration, and every call site that had to remember
 * them was one that could forget: the AI review's `mcpFlag` is gated on
 * `cliLaunchOptions`, a Claude capability, so a Codex review launched with no
 * tools and produced no drafts, silently. Anything a Codex launch must not run
 * without belongs on the session, not in here.
 */
export interface AgentSeedOptions {
  prompt?: string;
  /** Claude's `--model`. Codex's model comes from the session's launch flags. */
  modelFlag?: string;
  /** Claude's `--effort`. Codex's comes from the session's launch flags. */
  effortFlag?: string;
  remoteControl?: string;
  /** Whatever carries santree's session hooks for this provider: Claude's
   *  `--settings <file>`, Codex's `-c 'hooks.<Event>=[…]'` overrides. */
  settingsFlag?: string;
  /** Claude's `--mcp-config`. Codex takes MCP servers as configuration, so its
   *  review server is in the session's launch flags. */
  mcpFlag?: string;
  chrome?: boolean;
  permissionMode?: string;
  repo?: string;
  termKey?: string;
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
  buildSeed: (
    session: Exclude<AgentSession, { type: "shell" }>,
    options: AgentSeedOptions,
  ) => string | undefined;
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

const unsupportedSeed: AgentProviderContract["buildSeed"] = () => undefined;

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
    buildSeed: (session, options) => {
      const bin = shellQuote(session.executable);
      const env =
        options.repo && options.termKey
          ? `env SANTREE_REPO=${shellQuote(options.repo)} SANTREE_TERM_KEY=${shellQuote(options.termKey)} `
          : "";
      const remote = options.remoteControl
        ? `--remote-control ${shellQuote(options.remoteControl)} `
        : "";
      const settings = options.settingsFlag ? `${options.settingsFlag} ` : "";
      const mcp = options.mcpFlag ? `${options.mcpFlag} ` : "";
      const chrome = options.chrome ? "--chrome " : "";
      const permission = options.permissionMode
        ? `--permission-mode ${shellQuote(options.permissionMode)} `
        : "";
      if (session.type === "resume") {
        return `exec ${env}${bin} ${remote}${settings}${mcp}${chrome}${permission}--resume ${shellQuote(session.sessionId)}`;
      }
      const model = options.modelFlag ? `${options.modelFlag} ` : "";
      const effort = options.effortFlag ? `${options.effortFlag} ` : "";
      const prompt = options.prompt !== undefined ? ` ${shellQuote(options.prompt)}` : "";
      // `--session-id` only when santree chose one. The field is nullable
      // because Codex mints its own id and reports it back through a hook;
      // Claude always gets one from us, so this is type honesty, not a case
      // the launch path is expected to hit.
      const id = session.sessionId ? `--session-id ${shellQuote(session.sessionId)}` : "";
      return `exec ${env}${bin} ${remote}${settings}${mcp}${chrome}${permission}${model}${effort}${id}${prompt}`;
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
    buildSeed: (session, options) => {
      // The plain CLI, not an App Server attachment. `resume --remote <socket>`
      // routed every Codex TUI through one santree-owned `codex app-server`,
      // which enforces a single writer per thread — so a re-launch against a
      // thread whose previous process still held the lock failed outright with
      // "already has an active writer" and dropped the tab to a bare shell.
      // Orca and Superset both spawn the plain binary; so do we now.
      const bin = shellQuote(session.executable);
      // Same attribution channel Claude uses: the hook reads these to bind the
      // id Codex mints to the surface that launched it.
      const env =
        options.repo && options.termKey
          ? `env SANTREE_REPO=${shellQuote(options.repo)} SANTREE_TERM_KEY=${shellQuote(options.termKey)} `
          : "";
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
      const hooks = options.settingsFlag
        ? `--dangerously-bypass-hook-trust ${options.settingsFlag} `
        : "";
      // What this session runs *under* — sandbox, approval policy, model,
      // reasoning effort, and for a review santree's own MCP tool server, with
      // `required = true` so a review whose tools cannot start fails instead of
      // running as an ordinary agent. Built in Rust (`codex_config.rs`) against
      // the surface the backend resolved, already shell-quoted, and carried on
      // the session so that no launch site can omit it. Empty for Claude, whose
      // launch line is assembled from `options` above.
      const launch = session.launchFlags ? `${session.launchFlags} ` : "";
      const prompt = options.prompt !== undefined ? ` ${shellQuote(options.prompt)}` : "";
      // The hook and launch flags are top-level options (`codex [OPTIONS]
      // <COMMAND>`), so they precede `resume` rather than sitting between it and
      // its id — clap accepts either, but the id belongs next to the subcommand
      // that takes it.
      if (session.type === "resume") {
        return `exec ${env}${bin} ${hooks}${launch}resume ${shellQuote(session.sessionId)}`;
      }
      // No id on a fresh launch: Codex has no launch-time id flag. It mints one
      // and the `SessionStart` hook reports it back, which is what binds the
      // session to this surface for the next resume.
      //
      // That report does NOT arrive at launch. Codex creates the thread on the
      // first submitted turn and fires `SessionStart` there, so a tab opened and
      // left at the prompt reports nothing at all (verified on codex-cli 0.151.0
      // — see `hooks.rs` `CODEX_EVENTS`). Anything that must show a Codex agent
      // before it has been spoken to reads santree's own launch, not the hook.
      return `exec ${env}${bin} ${hooks}${launch}`.trimEnd() + prompt;
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
    buildSeed: unsupportedSeed,
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
    buildSeed: unsupportedSeed,
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

export function agentSessionSeed(
  session: AgentSession | undefined,
  options: AgentSeedOptions,
): string | undefined {
  if (!session || session.type === "shell") return undefined;
  return agentProvider(session.agentKind).buildSeed(session, options);
}
