import { describe, expect, it } from "vitest";

import type { AgentSession } from "../../bindings";
import { agentSessionSeed, shellQuote } from "./agentSeed";

const fresh: Extract<AgentSession, { type: "fresh" }> = {
  type: "fresh",
  agentKind: "Claude",
  executable: "claude",
  sessionId: "sess-1",
  launchFlags: "",
};
const resume: Extract<AgentSession, { type: "resume" }> = {
  type: "resume",
  agentKind: "Claude",
  executable: "claude",
  sessionId: "sess-1",
  launchFlags: "",
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
      },
      { prompt: "inspect this" },
    );
    expect(seed).toBe("exec '/custom/codex' 'inspect this'");
    expect(seed).not.toContain("--remote");
  });

  it("resumes Codex by thread id, without a socket", () => {
    expect(
      agentSessionSeed(
        {
          type: "resume",
          agentKind: "Codex",
          executable: "/custom/codex",
          sessionId: "thread-1",
          launchFlags: "",
        },
        {},
      ),
    ).toBe("exec '/custom/codex' resume 'thread-1'");
  });

  /** The hook injection and the trust bypass travel together. Codex silently
   *  skips an untrusted hook — no error, no warning — so injecting without the
   *  bypass would look exactly like "hooks don't work", and passing the bypass
   *  with nothing to inject would widen trust for no reason. */
  it("pairs Codex's hook injection with the trust bypass", () => {
    const seed = agentSessionSeed(
      { type: "resume", agentKind: "Codex", executable: "codex", sessionId: "t1", launchFlags: "" },
      { settingsFlag: "-c 'hooks.SessionStart=[]'", repo: "acme/app", termKey: "tree:AK-1" },
    );
    expect(seed).toContain("--dangerously-bypass-hook-trust -c 'hooks.SessionStart=[]'");
    expect(seed).toContain("SANTREE_TERM_KEY='tree:AK-1'");
  });

  it("never passes the trust bypass with no hooks to inject", () => {
    const seed = agentSessionSeed(
      { type: "resume", agentKind: "Codex", executable: "codex", sessionId: "t1", launchFlags: "" },
      {},
    );
    expect(seed).not.toContain("--dangerously-bypass-hook-trust");
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
        },
        { prompt: "review it", settingsFlag: "-c 'hooks.SessionStart=[]'" },
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
        },
        {},
      ),
    ).toBe(`exec 'codex' ${launchFlags} resume 't1'`);
  });

  /** The Work surface resolves to no flags at all — santree leaves the user's own
   *  Codex sandbox alone there — and that must not leave a stray space behind. */
  it("stays a clean command line when a session has no launch flags", () => {
    expect(
      agentSessionSeed(
        {
          type: "fresh",
          agentKind: "Codex",
          executable: "codex",
          sessionId: null,
          launchFlags: "",
        },
        {},
      ),
    ).toBe("exec 'codex'");
  });

  /** Claude assembles its own launch line from `options`; the field exists on
   *  every session but is only ever filled for Codex. */
  it("ignores launch flags on a Claude session", () => {
    expect(agentSessionSeed({ ...fresh, launchFlags: "--sandbox read-only" }, {})).toBe(
      "exec 'claude' --session-id 'sess-1'",
    );
  });

  it("starts a fresh session with a reserved id and the prompt", () => {
    expect(agentSessionSeed(fresh, { prompt: "Work on AK-1" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'Work on AK-1'",
    );
  });

  it("starts a fresh session with no trailing prompt when none is given (a manual Claude tab)", () => {
    expect(agentSessionSeed(fresh, {})).toBe("exec 'claude' --session-id 'sess-1'");
    expect(agentSessionSeed(fresh, { modelFlag: "--model 'opus'" })).toBe(
      "exec 'claude' --model 'opus' --session-id 'sess-1'",
    );
  });

  it("resumes an on-disk session", () => {
    expect(agentSessionSeed(resume, { prompt: "unused" })).toBe("exec 'claude' --resume 'sess-1'");
  });

  it("names the session for Remote Control on both fresh and resume", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", remoteControl: "AK-165" })).toBe(
      "exec 'claude' --remote-control 'AK-165' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(resume, { prompt: "go", remoteControl: "AK-165" })).toBe(
      "exec 'claude' --remote-control 'AK-165' --resume 'sess-1'",
    );
  });

  it("places model + effort after remote-control, before the session id", () => {
    expect(
      agentSessionSeed(fresh, {
        prompt: "go",
        modelFlag: "--model 'opus'",
        effortFlag: "--effort 'high'",
        remoteControl: "AK-9",
      }),
    ).toBe(
      "exec 'claude' --remote-control 'AK-9' --model 'opus' --effort 'high' --session-id 'sess-1' 'go'",
    );
  });

  it("places --settings after remote-control, and applies it on both fresh and resume", () => {
    const settingsFlag = "--settings '/data/claude-hooks.json'";
    expect(
      agentSessionSeed(fresh, {
        prompt: "go",
        settingsFlag,
        modelFlag: "--model 'opus'",
        remoteControl: "AK-9",
      }),
    ).toBe(
      "exec 'claude' --remote-control 'AK-9' --settings '/data/claude-hooks.json' --model 'opus' --session-id 'sess-1' 'go'",
    );
    // Unlike model/effort, --settings IS injected on resume — session-state hooks
    // should fire on resumed sessions too.
    expect(agentSessionSeed(resume, { settingsFlag })).toBe(
      "exec 'claude' --settings '/data/claude-hooks.json' --resume 'sess-1'",
    );
  });

  it("adds --mcp-config on both fresh and resume, right after --settings", () => {
    const mcpFlag = "--mcp-config '/data/mcp/acme-web-42.mcp.json'";
    const settingsFlag = "--settings '/data/claude-hooks-ai-review.json'";
    expect(agentSessionSeed(fresh, { prompt: "go", settingsFlag, mcpFlag })).toBe(
      "exec 'claude' --settings '/data/claude-hooks-ai-review.json' --mcp-config '/data/mcp/acme-web-42.mcp.json' --session-id 'sess-1' 'go'",
    );
    // A resumed AI review still needs its tools, or it has nowhere to write.
    expect(agentSessionSeed(resume, { settingsFlag, mcpFlag })).toBe(
      "exec 'claude' --settings '/data/claude-hooks-ai-review.json' --mcp-config '/data/mcp/acme-web-42.mcp.json' --resume 'sess-1'",
    );
  });

  it("adds --chrome on both fresh and resume, and omits it when off", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", chrome: true, remoteControl: "AK-9" })).toBe(
      "exec 'claude' --remote-control 'AK-9' --chrome --session-id 'sess-1' 'go'",
    );
    // A launch-time capability, so it applies on resume too.
    expect(agentSessionSeed(resume, { chrome: true })).toBe(
      "exec 'claude' --chrome --resume 'sess-1'",
    );
    // Off (or unset) ⇒ no flag.
    expect(agentSessionSeed(fresh, { prompt: "go", chrome: false })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
  });

  it("adds --permission-mode on both fresh and resume, and omits it when empty", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", permissionMode: "plan" })).toBe(
      "exec 'claude' --permission-mode 'plan' --session-id 'sess-1' 'go'",
    );
    // A startup mode, so it applies on restart (resume) too.
    expect(agentSessionSeed(resume, { permissionMode: "acceptEdits" })).toBe(
      "exec 'claude' --permission-mode 'acceptEdits' --resume 'sess-1'",
    );
    // Empty ("Default") ⇒ no flag.
    expect(agentSessionSeed(fresh, { prompt: "go", permissionMode: "" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
  });

  it("omits model/effort on a resume (the session keeps its own)", () => {
    expect(
      agentSessionSeed(resume, {
        prompt: "go",
        modelFlag: "--model 'opus'",
        effortFlag: "--effort 'high'",
      }),
    ).toBe("exec 'claude' --resume 'sess-1'");
  });

  it("exports the terminal identity via `env` on both fresh and resume (for /clear reconcile)", () => {
    // Both repo + termKey ⇒ an `env NAME=value …` prefix Claude's SessionStart hook
    // reads to adopt a new (e.g. post-/clear) session id for this exact terminal.
    expect(agentSessionSeed(fresh, { prompt: "go", repo: "acme", termKey: "triage:AK-1" })).toBe(
      "exec env SANTREE_REPO='acme' SANTREE_TERM_KEY='triage:AK-1' 'claude' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(resume, { repo: "acme", termKey: "tree:AK-1" })).toBe(
      "exec env SANTREE_REPO='acme' SANTREE_TERM_KEY='tree:AK-1' 'claude' --resume 'sess-1'",
    );
  });

  it("omits the env prefix unless both repo and termKey are given", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", repo: "acme" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(fresh, { prompt: "go", termKey: "triage:AK-1" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("don't fail")).toBe("'don'\\''t fail'");
  });

  it("strips C0 control bytes so ticket content can't escape the quoted seed", () => {
    // \x15 is kill-line, \r is accept-line in most shell line editors — both must
    // be gone before this reaches the PTY, quoting alone doesn't stop them.
    expect(shellQuote("safe\x15rm -rf ~\rdone")).toBe("'saferm -rf ~done'");
  });

  it("strips C1 control codes (8-bit CSI/DCS/OSC introducers) from ticket text", () => {
    // A terminal in 8-bit-control mode reads these as escape-sequence introducers,
    // so quoting alone wouldn't contain them: \u009b = CSI, \u0090 = DCS, \u009d = OSC.
    expect(shellQuote("Fix \u009b2J the \u0090payload\u009c thing")).toBe(
      "'Fix 2J the payload thing'",
    );
    expect(agentSessionSeed(fresh, { prompt: "AK-1: \u009d0;pwned\u0007 title" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'AK-1: 0;pwned title'",
    );
  });

  it("folds embedded newlines to a space instead of breaking the quoted seed", () => {
    expect(shellQuote("line one\nline two")).toBe("'line one line two'");
  });

  it("escapes an embedded single quote in the prompt within the full seed command", () => {
    // Real ticket titles contain apostrophes — this exercises shellQuote's
    // escaping as part of the full agentSessionSeed output, not in isolation.
    expect(agentSessionSeed(fresh, { prompt: "Work on AK-1: don't fail" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'Work on AK-1: don'\\''t fail'",
    );
  });
});
