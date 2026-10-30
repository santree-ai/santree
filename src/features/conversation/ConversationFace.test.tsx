/**
 * A Claude tab's two faces over one area. The switch between them is instant
 * because the conversation, once shown, stays mounted under the terminal —
 * hidden and inert — instead of being drawn again from scratch on every switch:
 * back on it, it is as it was (its scroll, the cards opened, the draft).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

// The view itself, as one piece of state that only survives if it is never
// remounted.
vi.mock("./ConversationView", async () => {
  const { useState } = await import("react");
  return {
    ConversationView: ({ shown }: { shown: boolean }) => {
      const [opened, setOpened] = useState(false);
      return (
        <button type="button" aria-pressed={opened} onClick={() => setOpened(true)}>
          {shown ? "Conversation on screen" : "Conversation hidden"}
        </button>
      );
    },
  };
});

import { ConversationFace } from "./ConversationFace";

const live = { repo: "acme/app", termKey: "tree:a:tab:1" };
const terminal = <div data-testid="terminal host" />;

it("mounts the conversation once shown and keeps it, hidden and inert under the terminal, so switching back finds it as it was", () => {
  const { rerender, container } = render(
    <ConversationFace face={{ offered: true, shown: false }} live={live}>
      {terminal}
    </ConversationFace>,
  );
  // A tab that stays on its terminal never draws a conversation.
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByTestId("terminal host")).toBeInTheDocument();

  rerender(
    <ConversationFace face={{ offered: true, shown: true }} live={live}>
      {null}
    </ConversationFace>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Conversation on screen" }));
  const cover = container.querySelector("[data-conversation-face]");
  expect(cover).not.toHaveAttribute("inert");

  // To the terminal: the same element, hidden and inert, holding what it held.
  rerender(
    <ConversationFace face={{ offered: true, shown: false }} live={live}>
      {terminal}
    </ConversationFace>,
  );
  expect(container.querySelector("[data-conversation-face]")).toBe(cover);
  expect(cover).toHaveAttribute("inert");
  expect(cover).toHaveClass("invisible");
  expect(screen.getByRole("button", { name: "Conversation hidden" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  rerender(
    <ConversationFace face={{ offered: true, shown: true }} live={live}>
      {null}
    </ConversationFace>,
  );
  expect(screen.getByRole("button", { name: "Conversation on screen" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
