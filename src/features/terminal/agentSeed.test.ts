import { describe, expect, it } from "vitest";

import type { AgentSession } from "../../bindings";
import { agentProvider } from "./agentProvider";
import {
  type AgentLaunchConfig,
  agentSessionSeed,
  resumeInvocation,
  shellQuote,
} from "./agentSeed";

const fresh: Extract<AgentSession, { type: "fresh" }> = {
  type: "fresh",
  agentKind: "Claude",
  executable: "claude",
  sessionId: "sess-1",
  launchFlags: "",
  launchEnv: [],
  account: null,
};
const resume: Extract<AgentSession, { type: "resume" }> = {
  type: "resume",
  agentKind: "Claude",
  executable: "claude",
  sessionId: "sess-1",
  launchFlags: "",
  launchEnv: [],
  account: null,
};

describe("agentSessionSeed", () => {
  it("returns undefined for a plain shell (or no session)", () => {
    expect(agentSessionSeed({ type: "shell" }, { prompt: "hi" })).toBeUndefined();
    expect(agentSessionSeed(undefined, { prompt: "hi" })).toBeUndefined();
  });

  /** Codex launches as the plain CLI. It used to attach to a santree-owned
   *  `codex app-server` via `resume --remote <socket> <thread>`, which enforces
   *  one writer per thread — a relaunch while the previous process still held
   *  the lock failed with "already has an active writer" and left a bare shell.
   *  A fresh launch therefore carries NO id: Codex has no launch-time id flag,
   *  mints its own, and reports it back through the `SessionStart` hook. */
  it("starts Codex as the plain CLI, with no id and no socket", () => {
    const seed = agentSessionSeed(
      {
        type: "fresh",
        agentKind: "Codex",
        executable: "/custom/codex",
        sessionId: null,
        launchFlags: "",
        launchEnv: [],
        account: null,
      },
      { prompt: "inspect this" },
    );
    expect(seed).toBe("exec '/custom/codex' 'inspect this'");
    expect(seed).not.toContain("--remote");
  });

  /** The hook injection and the trust bypass travel together. Codex silently
   *  skips an untrusted hook — no error, no warning — so injecting without the
   *  bypass would look exactly like "hooks don't work", and passing the bypass
   *  with nothing to inject would widen trust for no reason. */
  it("pairs Codex's hook injection with the trust bypass, and never passes one alone", () => {
    const codex = {
      type: "resume",
      agentKind: "Codex",
      executable: "codex",
      sessionId: "t1",
      launchFlags: "",
      launchEnv: [],
      account: null,
    } satisfies AgentSession;
    const seed = agentSessionSeed(codex, {
      hookFlag: "-c 'hooks.SessionStart=[]'",
      repo: "acme/app",
      termKey: "tree:AK-1",
    });
    expect(seed).toContain("--dangerously-bypass-hook-trust -c 'hooks.SessionStart=[]'");
    expect(seed).toContain("SANTREE_TERM_KEY='tree:AK-1'");
    expect(agentSessionSeed(codex, {})).not.toContain("--dangerously-bypass-hook-trust");
  });

  /** Codex's sandbox, approval policy and review tools are resolved backend-side
   *  (`codex_config.rs`) and ride on the session, precisely so that no call site
   *  has to remember them. They apply on a resume too: a resumed AI review that
   *  dropped `--sandbox read-only` would come back with write access, and one
   *  that dropped its MCP server would come back with nowhere to record a
   *  finding. */
  it("carries the session's own launch flags on both fresh and resume", () => {
    const launchFlags =
      "--sandbox read-only --ask-for-approval never " +
      "-c 'mcp_servers.santree-review={command=\"/app/santree-hook\",required=true}'";
    expect(
      agentSessionSeed(
        {
          type: "fresh",
          agentKind: "Codex",
          executable: "codex",
          sessionId: null,
          launchFlags,
          launchEnv: [],
          account: null,
        },
        { prompt: "review it", hookFlag: "-c 'hooks.SessionStart=[]'" },
      ),
    ).toBe(
      "exec 'codex' --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[]' " +
        `${launchFlags} 'review it'`,
    );
    expect(
      agentSessionSeed(
        {
          type: "resume",
          agentKind: "Codex",
          executable: "codex",
          sessionId: "t1",
          launchFlags,
          launchEnv: [],
          account: null,
        },
        {},
      ),
    ).toBe(`exec 'codex' ${launchFlags} resume 't1'`);
  });

  /** Claude's launch line comes from its own spec and the typed config; the
   *  field exists on every session but is only ever filled for Codex. */
  it("ignores launch flags on a Claude session", () => {
    expect(agentSessionSeed({ ...fresh, launchFlags: "--sandbox read-only" }, {})).toBe(
      "exec 'claude' --session-id 'sess-1'",
    );
  });

  it("starts a fresh Claude session with a reserved id and the prompt", () => {
    expect(agentSessionSeed(fresh, { prompt: "Work on AK-1" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'Work on AK-1'",
    );
  });

  /** On a resume the session keeps its own model and effort, but every
   *  launch-time capability is re-applied: session-state hooks must fire, a
   *  resumed AI review still needs its tool server, and Remote Control, Chrome
   *  and the permission mode are startup options. The prompt is not re-sent. */
  it("resumes Claude with the launch-time flags but not model, effort or prompt", () => {
    expect(
      agentSessionSeed(resume, {
        prompt: "unused",
        model: "opus",
        effort: "high",
        remoteControl: "AK-165",
        hookFlag: "--settings '/data/claude-hooks-ai-review.json'",
        mcpConfigPath: "/data/mcp/acme-web-42.mcp.json",
        chrome: true,
        permissionMode: "acceptEdits",
        repo: "acme",
        termKey: "tree:AK-1",
      }),
    ).toBe(
      "exec env SANTREE_REPO='acme' SANTREE_TERM_KEY='tree:AK-1' 'claude' " +
        "--remote-control 'AK-165' --settings '/data/claude-hooks-ai-review.json' " +
        "--mcp-config '/data/mcp/acme-web-42.mcp.json' --chrome " +
        "--permission-mode 'acceptEdits' --resume 'sess-1'",
    );
  });

  /** The `env` prefix carries two independent things: the repo/termKey pair
   *  Claude's SessionStart hook reads to adopt a new (e.g. post-/clear) session
   *  id for this exact terminal — half of it is useless — and the account the
   *  session runs on, which an attach needs as much as a launch. */
  it("puts the account env and the attribution pair under one env, each independently", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", repo: "acme" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(fresh, { prompt: "go", termKey: "triage:AK-1" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
    const launchEnv = [
      { name: "CLAUDE_CONFIG_DIR", value: "/acc/it's" },
      { name: "SANTREE_ACCOUNT", value: "work" },
    ];
    expect(agentSessionSeed({ ...resume, launchEnv }, { repo: "acme" })).toBe(
      "exec env CLAUDE_CONFIG_DIR='/acc/it'\\''s' SANTREE_ACCOUNT='work' 'claude' --resume 'sess-1'",
    );
    expect(agentSessionSeed({ ...resume, launchEnv }, { repo: "acme", termKey: "tree:AK-1" })).toBe(
      "exec env CLAUDE_CONFIG_DIR='/acc/it'\\''s' SANTREE_ACCOUNT='work' " +
        "SANTREE_REPO='acme' SANTREE_TERM_KEY='tree:AK-1' 'claude' --resume 'sess-1'",
    );
    expect(
      agentSessionSeed({
        type: "attach",
        agentKind: "Claude",
        executable: "claude",
        sessionId: "sess-1",
        backgroundId: "14ffdc20",
        launchEnv,
        account: "work",
      }),
    ).toBe(
      "exec env CLAUDE_CONFIG_DIR='/acc/it'\\''s' SANTREE_ACCOUNT='work' 'claude' attach '14ffdc20'",
    );
  });

  /** Ticket text becomes a quoted shell word typed into a PTY. C0 bytes
   *  (\x15 kill-line, \r accept-line) and C1 introducers (\u009b CSI, \u0090
   *  DCS, \u009d OSC) would act before the shell ever parsed the quotes. */
  it.each([
    ["an embedded single quote", "don't fail", "'don'\\''t fail'"],
    ["C0 control bytes", "safe\x15rm -rf ~\rdone", "'saferm -rf ~done'"],
    [
      "C1 control codes",
      "Fix \u009b2J the \u0090payload\u009c thing",
      "'Fix 2J the payload thing'",
    ],
    ["newlines (folded to a space)", "line one\nline two", "'line one line two'"],
  ])("shellQuote neutralises %s", (_, raw, quoted) => {
    expect(shellQuote(raw)).toBe(quoted);
  });

  it("quotes the prompt inside the full seed command", () => {
    expect(agentSessionSeed(fresh, { prompt: "AK-1: don't \u009d0;pwned\u0007 fail" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'AK-1: don'\\''t 0;pwned fail'",
    );
  });
});

/**
 * The four call sites that open an agent terminal — the worktree tab, the
 * investigation pane, the triage batch and the AI review — each used to
 * assemble Claude's flags themselves, and they had already diverged: two gated
 * model/effort on `cliLaunchOptions`, two on `resolvedAgent === agentKind`, and
 * only two ever passed `--mcp-config`. Now each passes typed configuration and
 * the provider spells it, so the combinations that varied are pinned here once.
 */
describe("the launch line each call site used to assemble", () => {
  const seed = (config: AgentLaunchConfig) =>
    agentSessionSeed(
      { ...fresh, executable: "/opt/claude" },
      {
        repo: "acme/app",
        termKey: "tree:AK-1",
        configuredFor: "Claude",
        ...config,
      },
    );
  const env = "exec env SANTREE_REPO='acme/app' SANTREE_TERM_KEY='tree:AK-1' '/opt/claude'";

  it("Trees work tab: hooks, chrome, permission mode, model, effort", () => {
    expect(
      seed({
        hookFlag: "--settings '/data/claude-hooks.json'",
        chrome: true,
        permissionMode: "acceptEdits",
        model: "opus",
        effort: "high",
        remoteControl: "AK-1",
      }),
    ).toBe(
      `${env} --remote-control 'AK-1' --settings '/data/claude-hooks.json' --chrome ` +
        "--permission-mode 'acceptEdits' --model 'opus' --effort 'high' --session-id 'sess-1'",
    );
  });

  it("AI review: its own restricted settings and tool server, and no Remote Control name", () => {
    const line = seed({
      hookFlag: "--settings '/data/claude-hooks-ai-review.json'",
      mcpConfigPath: "/data/mcp/acme-web-42.mcp.json",
      model: "sonnet",
      permissionMode: "plan",
      prompt: "Read /tmp/review.md and follow the instructions inside.",
    });
    expect(line).toBe(
      `${env} --settings '/data/claude-hooks-ai-review.json' ` +
        "--mcp-config '/data/mcp/acme-web-42.mcp.json' --permission-mode 'plan' " +
        "--model 'sonnet' --session-id 'sess-1' " +
        "'Read /tmp/review.md and follow the instructions inside.'",
    );
    expect(line).not.toContain("--remote-control");
  });

  /** Settings are per provider. A surface configured for one whose stored
   *  session turns out to run the other must not hand the first one's model
   *  name to the second one's CLI — two of the four sites checked this, two
   *  did not. */
  it("drops per-provider settings when the session runs a different provider", () => {
    expect(
      agentSessionSeed(fresh, {
        configuredFor: "Codex",
        model: "gpt-5-codex",
        effort: "high",
        permissionMode: "acceptEdits",
        hookFlag: "--settings '/data/claude-hooks.json'",
      }),
    ).toBe("exec 'claude' --settings '/data/claude-hooks.json' --session-id 'sess-1'");
    // Without `configuredFor` there is nothing to disagree with.
    expect(agentSessionSeed(fresh, { model: "opus" })).toBe(
      "exec 'claude' --model 'opus' --session-id 'sess-1'",
    );
  });

  /** Codex takes none of them: its model, effort, sandbox and tool server are
   *  resolved backend-side and ride on the session. Passing Claude's would be a
   *  launch failure, not a no-op. */
  it("never leaks a Claude-shaped flag onto a Codex launch", () => {
    const line = agentSessionSeed(
      {
        type: "fresh",
        agentKind: "Codex",
        executable: "codex",
        sessionId: null,
        launchFlags: "",
        launchEnv: [],
        account: null,
      },
      {
        configuredFor: "Codex",
        model: "gpt-5-codex",
        effort: "high",
        permissionMode: "acceptEdits",
        chrome: true,
        remoteControl: "AK-1",
        mcpConfigPath: "/data/mcp/acme.mcp.json",
      },
    );
    expect(line).toBe("exec 'codex'");
  });

  it("omits a flag whose value is blank or whitespace-only", () => {
    expect(seed({ model: "", effort: "   ", permissionMode: null, remoteControl: "" })).toBe(
      `${env} --session-id 'sess-1'`,
    );
  });
});

/**
 * The seed the PTY runs and the line the Session-history row copies are the
 * same invocation with different wrappers. Written twice they drift — a
 * comparator with this exact duplication already resumes one of its agents by
 * session id in one spelling and by transcript path in the other, held together
 * by a comment. Both now come from the provider's one `launch.resume`.
 */
describe("resumeInvocation agrees with the seeded resume", () => {
  it.each([
    ["Claude", "claude"],
    ["Codex", "codex"],
  ] as const)("%s", (kind, bin) => {
    // A thread id is whatever a rollout's `session_meta.id` says — an arbitrary
    // string read off disk, so the copied line has to quote it too. It did not.
    const sessionId = "don't 'stop'";
    const copied = resumeInvocation(kind, sessionId);
    expect(copied?.startsWith(`${bin} `)).toBe(true);
    const invocation = copied?.slice(bin.length + 1);
    expect(invocation).toContain(shellQuote(sessionId));

    const seeded = agentSessionSeed({
      type: "resume",
      agentKind: kind,
      executable: `/opt/${bin}`,
      sessionId,
      launchFlags: "",
      launchEnv: [],
      account: null,
    });
    expect(seeded).toBe(`exec '/opt/${bin}' ${invocation}`);
  });

  it("prefixes a cd when the command is going into somebody else's terminal", () => {
    // Claude looks a conversation up under the directory it ran in, so the copied
    // line is wrong without this; a PTY session gets its cwd from the spawn.
    expect(resumeInvocation("Claude", "sess-1", "/w/it's here")).toBe(
      "cd '/w/it'\\''s here' && claude --resume 'sess-1'",
    );
  });

  it("has nothing to offer for a provider santree cannot resume", () => {
    expect(resumeInvocation("Cursor", "abc")).toBeNull();
    expect(agentProvider("Cursor").launch).toBeNull();
  });
});
