import { describe, expect, it } from "vitest";

import type { AgentSession } from "../../bindings";
import { agentSessionSeed, shellQuote } from "./agentSeed";

const fresh: AgentSession = { type: "fresh", sessionId: "sess-1" };
const resume: AgentSession = { type: "resume", sessionId: "sess-1" };

describe("agentSessionSeed", () => {
  it("returns undefined for a plain shell (or no session)", () => {
    expect(agentSessionSeed({ type: "shell" }, "claude", { prompt: "hi" })).toBeUndefined();
    expect(agentSessionSeed(undefined, "claude", { prompt: "hi" })).toBeUndefined();
  });

  it("starts a fresh session with a reserved id and the prompt", () => {
    expect(agentSessionSeed(fresh, "claude", { prompt: "Work on AK-1" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'Work on AK-1'",
    );
  });

  it("resumes an on-disk session", () => {
    expect(agentSessionSeed(resume, "claude", { prompt: "unused" })).toBe(
      "exec 'claude' --resume 'sess-1'",
    );
  });

  it("names the session for Remote Control on both fresh and resume", () => {
    expect(agentSessionSeed(fresh, "claude", { prompt: "go", remoteControl: "AK-165" })).toBe(
      "exec 'claude' --remote-control 'AK-165' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(resume, "claude", { prompt: "go", remoteControl: "AK-165" })).toBe(
      "exec 'claude' --remote-control 'AK-165' --resume 'sess-1'",
    );
  });

  it("places model + effort after remote-control, before the session id", () => {
    expect(
      agentSessionSeed(fresh, "claude", {
        prompt: "go",
        modelFlag: "--model 'opus'",
        effortFlag: "--effort 'high'",
        remoteControl: "AK-9",
      }),
    ).toBe(
      "exec 'claude' --remote-control 'AK-9' --model 'opus' --effort 'high' --session-id 'sess-1' 'go'",
    );
  });

  it("omits model/effort on a resume (the session keeps its own)", () => {
    expect(
      agentSessionSeed(resume, "claude", {
        prompt: "go",
        modelFlag: "--model 'opus'",
        effortFlag: "--effort 'high'",
      }),
    ).toBe("exec 'claude' --resume 'sess-1'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("don't fail")).toBe("'don'\\''t fail'");
  });

  it("strips C0 control bytes so ticket content can't escape the quoted seed", () => {
    // \x15 is kill-line, \r is accept-line in most shell line editors — both must
    // be gone before this reaches the PTY, quoting alone doesn't stop them.
    expect(shellQuote("safe\x15rm -rf ~\rdone")).toBe("'saferm -rf ~done'");
  });

  it("folds embedded newlines to a space instead of breaking the quoted seed", () => {
    expect(shellQuote("line one\nline two")).toBe("'line one line two'");
  });

  it("escapes an embedded single quote in the prompt within the full seed command", () => {
    // Real ticket titles contain apostrophes — this exercises shellQuote's
    // escaping as part of the full agentSessionSeed output, not in isolation.
    expect(agentSessionSeed(fresh, "claude", { prompt: "Work on AK-1: don't fail" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'Work on AK-1: don'\\''t fail'",
    );
  });
});
