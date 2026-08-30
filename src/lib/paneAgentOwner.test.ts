import { describe, expect, it } from "vitest";

import type { AgentState } from "../bindings";
import {
  type PaneAgentOwner,
  type PaneAgentOwnerSignals,
  resolvePaneAgentOwner,
} from "./paneAgentOwner";

/**
 * The precedence, tier by tier. Each case is a real situation santree ends up
 * in, not a permutation for its own sake — the ordering exists because these
 * disagree in the field.
 */
describe("resolvePaneAgentOwner", () => {
  it("takes the session row over everything, because the row owns the session id", () => {
    expect(
      resolvePaneAgentOwner({
        sessionAgent: "Claude",
        detectedAgent: "Codex",
        launchAgent: "Cursor",
      }),
    ).toBe("Claude");
  });

  it("takes what `ps` sees now over what santree recorded at launch", () => {
    // The user quit the CLI santree started and ran another in the same pane.
    // Only the scan can see that; the launch record is a memory of a decision.
    expect(resolvePaneAgentOwner({ detectedAgent: "Codex", launchAgent: "Claude" })).toBe("Codex");
  });

  it("counts an agent the process table names that santree never launched", () => {
    // The bug this module was extracted for: a pane santree opened as a plain
    // shell, with a CLI the user started by hand in it. Tier 3 has nothing to
    // say; tier 2 does, and the answer is an agent.
    expect(resolvePaneAgentOwner({ detectedAgent: "Claude" })).toBe("Claude");
  });

  it("leaves the launch record standing when the scan names nothing", () => {
    // `ps` can fail, and a CLI behind an interpreter is not recognisable by
    // `argv[0]`. Absence is no information — never "no agent".
    expect(resolvePaneAgentOwner({ launchAgent: "Codex" })).toBe("Codex");
    expect(resolvePaneAgentOwner({ detectedAgent: null, launchAgent: "Codex" })).toBe("Codex");
    expect(resolvePaneAgentOwner({ detectedAgent: undefined, launchAgent: "Codex" })).toBe("Codex");
  });

  it("falls through a silent tier to the next one that speaks", () => {
    expect(resolvePaneAgentOwner({ sessionAgent: null, detectedAgent: "Codex" })).toBe("Codex");
    expect(
      resolvePaneAgentOwner({ sessionAgent: null, detectedAgent: null, launchAgent: "Cursor" }),
    ).toBe("Cursor");
  });

  it("answers null only when all three are silent", () => {
    expect(resolvePaneAgentOwner({})).toBeNull();
    expect(
      resolvePaneAgentOwner({ sessionAgent: null, detectedAgent: null, launchAgent: null }),
    ).toBeNull();
  });

  it("reads a null signal exactly like a missing one", () => {
    // Both mean "this source has nothing to say about this pane". A caller that
    // has a nullable field must not have to translate it into an omission.
    expect(resolvePaneAgentOwner({ sessionAgent: null })).toEqual(resolvePaneAgentOwner({}));
  });

  it("cannot answer what an agent is doing — enforced by `tsc`, not by convention", () => {
    // No agent *state* can enter the resolver, so none can come out of it. If
    // either type is ever widened to carry a status, `AssertNever`'s constraint
    // fails and `pnpm typecheck:test` goes red before this test runs — which is
    // the whole point of splitting this question from `lib/attention.ts`.
    const answerCarriesNoState: AssertNever<Extract<PaneAgentOwner, AgentState>>[] = [];
    const signalsCarryNoState: AssertNever<
      Extract<PaneAgentOwnerSignals[keyof PaneAgentOwnerSignals], AgentState>
    >[] = [];
    expect([answerCarriesNoState, signalsCarryNoState]).toEqual([[], []]);
  });
});

/** Compiles only while `T` is `never` — a type-level assertion with a runtime
 *  witness in the test above, since a bare alias would read as dead code. */
type AssertNever<T extends never> = T;
