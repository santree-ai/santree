import type { AgentKind, AgentSession, Settings } from "../../bindings";

export interface AgentSeedOptions {
  prompt?: string;
  modelFlag?: string;
  effortFlag?: string;
  remoteControl?: string;
  settingsFlag?: string;
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
      return `exec ${env}${bin} ${remote}${settings}${mcp}${chrome}${permission}${model}${effort}--session-id ${shellQuote(session.sessionId)}${prompt}`;
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
    },
    buildSeed: (session, options) => {
      if (!session.remote) return undefined;
      const prompt =
        session.type === "fresh" && options.prompt !== undefined
          ? ` ${shellQuote(options.prompt)}`
          : "";
      return `exec ${shellQuote(session.executable)} resume --remote ${shellQuote(session.remote)} ${shellQuote(session.sessionId)}${prompt}`;
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
