import { describe, expect, it } from "vitest";

import type { AgentKind } from "../../bindings";
import { agentProvider, agentSessionSeed, providerExecutable, sessionAgent } from "./agentProvider";

describe("agent provider contract", () => {
  it("registers every generated provider kind explicitly", () => {
    const kinds: AgentKind[] = ["Claude", "Codex", "Cursor", "Opencode"];
    expect(kinds.map((kind) => agentProvider(kind).defaultExecutable)).toEqual([
      "claude",
      "codex",
      "cursor-agent",
      "opencode",
    ]);
  });

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

  it("uses configured, requested, then provider-default executables", () => {
    expect(providerExecutable(undefined, "Codex", "/custom/codex")).toBe("/custom/codex");
    expect(providerExecutable(undefined, "Codex")).toBe("codex");
  });
});
