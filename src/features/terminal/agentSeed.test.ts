import { describe, expect, it } from "vitest";

import type { AgentSession } from "../../bindings";
import { agentSessionSeed, shellQuote } from "./agentSeed";

const fresh: AgentSession = {
  type: "fresh",
  agentKind: "Claude",
  executable: "claude",
  sessionId: "sess-1",
  remote: null,
};
const resume: AgentSession = {
  type: "resume",
  agentKind: "Claude",
  executable: "claude",
  sessionId: "sess-1",
  remote: null,
};

describe("agentSessionSeed", () => {
  it("returns undefined for a plain shell (or no session)", () => {
    expect(agentSessionSeed({ type: "shell" }, { prompt: "hi" })).toBeUndefined();
    expect(agentSessionSeed(undefined, { prompt: "hi" })).toBeUndefined();
  });

  it("attaches Codex to its App Server thread without overriding its security profile", () => {
    expect(
      agentSessionSeed(
        {
          type: "fresh",
          agentKind: "Codex",
          executable: "/custom/codex",
          sessionId: "thread-1",
          remote: "unix:///tmp/codex.sock",
        },
        { prompt: "inspect this" },
      ),
    ).toBe(
      "exec '/custom/codex' resume --remote 'unix:///tmp/codex.sock' 'thread-1' 'inspect this'",
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
    expect(agentSessionSeed(fresh, { prompt: "go", repo: "@dev", termKey: "dev:/co" })).toBe(
      "exec env SANTREE_REPO='@dev' SANTREE_TERM_KEY='dev:/co' 'claude' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(resume, { repo: "acme", termKey: "tree:AK-1" })).toBe(
      "exec env SANTREE_REPO='acme' SANTREE_TERM_KEY='tree:AK-1' 'claude' --resume 'sess-1'",
    );
  });

  it("omits the env prefix unless both repo and termKey are given", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", repo: "@dev" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(fresh, { prompt: "go", termKey: "dev:/co" })).toBe(
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
