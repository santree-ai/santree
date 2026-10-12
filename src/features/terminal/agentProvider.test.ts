import { describe, expect, it } from "vitest";

import { agentProvider, agentSessionSeed, providerExecutable, sessionAgent } from "./agentProvider";

describe("agent provider contract", () => {
  it("keeps the persisted session provider authoritative", () => {
    expect(
      sessionAgent(
        {
          type: "resume",
          agentKind: "Claude",
          executable: "/opt/claude",
          sessionId: "old",
          launchFlags: "",
        },
        "Codex",
      ),
    ).toBe("Claude");
  });

  it("never treats an unsupported provider as Claude", () => {
    expect(agentProvider("Cursor").capabilities.cliLaunchOptions).toBe(false);
    // No launch spec at all, so there is nothing to fall back to a default with:
    // the tab opens as a plain shell and the history row offers no resume line.
    expect(agentProvider("Cursor").launch).toBeNull();
    expect(
      agentSessionSeed(
        {
          type: "fresh",
          agentKind: "Cursor",
          executable: "/opt/cursor-agent",
          sessionId: "cursor-1",
          launchFlags: "",
        },
        {},
      ),
    ).toBeUndefined();
  });

  it("attaches to a background session with none of santree's launch flags", () => {
    const session = {
      type: "attach",
      agentKind: "Claude",
      executable: "/opt/claude",
      sessionId: "14ffdc20-a4ce-4bac-b737-d952b4a43500",
      backgroundId: "14ffdc20",
    } as const;
    // The running session keeps the flags it was started under; the config
    // that would decorate a resume or a fresh launch is not applied to it.
    expect(
      agentSessionSeed(session, {
        repo: "santree-ai/santree",
        termKey: "tree:__base__:tab:1",
        prompt: "ignored",
        model: "opus",
        remoteControl: "__base__",
        hookFlag: "--settings '/x.json'",
        permissionMode: "auto",
        chrome: true,
      }),
    ).toBe("exec '/opt/claude' attach '14ffdc20'");
    expect(sessionAgent(session, "Codex")).toBe("Claude");
  });

  it("uses configured, requested, then provider-default executables", () => {
    expect(providerExecutable(undefined, "Codex", "/custom/codex")).toBe("/custom/codex");
    expect(providerExecutable(undefined, "Codex")).toBe("codex");
  });
});
