import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskNotes } from "./TaskNotes";

// Success<T> shape produced by tauri-specta's typedError wrapper — mocked here
// so the component's useUnwrappedQuery/useOptimisticMutation hooks can run
// against a real QueryClient without a Tauri backend.
vi.mock("../../bindings", () => ({
  commands: {
    taskNote: vi.fn(async () => ({ status: "ok", data: null })),
    setTaskNote: vi.fn(async () => ({ status: "ok", data: null })),
  },
}));

import { commands } from "../../bindings";

const taskNote = vi.mocked(commands.taskNote);
const setTaskNote = vi.mocked(commands.setTaskNote);

function renderNotes(repo: string, taskId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const result = render(<TaskNotes repo={repo} taskId={taskId} />, { wrapper: Wrapper });
  return { ...result, qc };
}

describe("TaskNotes", () => {
  beforeEach(() => {
    taskNote.mockClear();
    setTaskNote.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes an unsaved draft on unmount instead of discarding it", async () => {
    const { unmount } = renderNotes("acme/repo", "AK-1");

    fireEvent.click(screen.getByRole("button", { name: /notes/i }));
    const textarea = await screen.findByPlaceholderText(/context for this task/i);
    // Let the initial note fetch (and the one-time draft seeding it triggers)
    // fully settle before typing, so the test isn't racing that unrelated effect.
    await waitFor(() => expect(taskNote).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.change(textarea, { target: { value: "call the vendor before Friday" } });

    // Unmount immediately — well before the 500ms debounce would otherwise fire,
    // simulating a keyboard-shortcut view switch mid-edit (Finding #21).
    unmount();

    await waitFor(() => {
      expect(setTaskNote).toHaveBeenCalledWith(
        "acme/repo",
        "AK-1",
        "call the vendor before Friday",
      );
    });
  });

  it("does not save on unmount when the draft matches what's already stored", async () => {
    taskNote.mockResolvedValue({ status: "ok", data: "existing note" });
    const { unmount } = renderNotes("acme/repo", "AK-2");

    fireEvent.click(screen.getByRole("button", { name: /notes/i }));
    await screen.findByDisplayValue("existing note");

    unmount();

    // Give any stray async work a tick, then assert no save was triggered.
    await new Promise((r) => setTimeout(r, 0));
    expect(setTaskNote).not.toHaveBeenCalled();
  });
});
