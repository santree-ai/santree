import { describe, expect, it } from "vitest";

import { classifyAgentTitle } from "./agentTitle";

/**
 * Every string below was **captured**, not invented: each CLI was run under a
 * real PTY on 2026-08-28 and every `ESC ] 0 ; … BEL` it wrote was recorded. A
 * classifier tested against made-up title text proves only that it agrees with
 * whoever made the text up.
 */
const CLAUDE = {
  /** `claude` 2.x, at rest before the first turn, and again once one finishes. */
  idle: ["✳ Claude Code", "✳ Notes.txt poem"],
  /** Quarter-circle spinner frames, animated ~2×/second through a turn. */
  working: ["◐ Claude Code", "◑ Claude Code", "◐ Notes.txt poem", "◑ Notes.txt poem"],
};

const CODEX = {
  /** `codex` 0.150.1 at rest: the bare cwd basename, no status glyph at all. */
  idle: ["titlelab2"],
  /** Braille spinner frames, animated ~10×/second through a turn. */
  working: [
    "⠋ titlelab2",
    "⠙ titlelab2",
    "⠹ titlelab2",
    "⠸ titlelab2",
    "⠼ titlelab2",
    "⠴ titlelab2",
    "⠦ titlelab2",
    "⠧ titlelab2",
    "⠇ titlelab2",
    "⠏ titlelab2",
  ],
};

describe("classifyAgentTitle", () => {
  it("reads every captured Claude Code spinner frame as working", () => {
    for (const title of CLAUDE.working) expect(classifyAgentTitle(title)).toBe("working");
  });

  it("reads Claude Code's ✳ as at rest, before and after a turn", () => {
    for (const title of CLAUDE.idle) expect(classifyAgentTitle(title)).toBe("idle");
  });

  it("reads every captured Codex spinner frame as working", () => {
    for (const title of CODEX.working) expect(classifyAgentTitle(title)).toBe("working");
  });

  it("says nothing about a Codex title at rest, because the title says nothing", () => {
    // Codex's idle title is just the cwd basename — no glyph, no agent name. The
    // honest answer is "no evidence", which lets the caller's own default stand
    // instead of dressing a guess up as a reading.
    for (const title of CODEX.idle) expect(classifyAgentTitle(title)).toBeNull();
  });

  it("holds a spinner over a task label that contains the idle glyph", () => {
    // Claude's working title is `<spinner> <task summary>`, and the summary is
    // arbitrary text — including text the idle check would otherwise match.
    expect(classifyAgentTitle("◐ rename ✳ in the header")).toBe("working");
  });

  it("takes no title, an empty one, or blank space as no evidence", () => {
    // Claude clears the title (`ESC ] 0 ; BEL`) as it exits.
    for (const title of [null, undefined, "", "   "]) {
      expect(classifyAgentTitle(title)).toBeNull();
    }
  });

  it("does not read an ordinary shell title as an agent", () => {
    for (const title of ["~/dev/santree-app", "zsh", "npm run dev"]) {
      expect(classifyAgentTitle(title)).toBeNull();
    }
  });
});
