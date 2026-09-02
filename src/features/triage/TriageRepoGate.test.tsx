/**
 * The gate's promise: an ask resolves with the picked name only after the pick
 * has been written, `null` on cancel, and nothing outside a provider.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  repo: null as string | null,
  setRepo: vi.fn(),
}));
vi.mock("../../lib/queries", () => ({
  useRepos: () => ({ data: [{ name: "acme/app", path: "/src/app" }] }),
  useTriageRepo: () => ({
    repo: state.repo,
    attached: false,
    defaultRepo: null,
    loading: false,
    setRepo: state.setRepo,
  }),
}));

import { TriageRepoGateProvider, useTriageRepoGate } from "./TriageRepoGate";

/** A caller that asks once when clicked and records what came back. */
function Asker({ answers }: { answers: (string | null)[] }) {
  const ask = useTriageRepoGate();
  return (
    <button
      type="button"
      onClick={() => {
        void ask("Investigating with Codex").then((repo) => answers.push(repo));
      }}
    >
      ask
    </button>
  );
}

function mount(withProvider = true) {
  const answers: (string | null)[] = [];
  const asker = <Asker answers={answers} />;
  render(
    withProvider ? <TriageRepoGateProvider ticketId="AK-1">{asker}</TriageRepoGateProvider> : asker,
  );
  fireEvent.click(screen.getByRole("button", { name: "ask" }));
  return answers;
}

describe("TriageRepoGate", () => {
  beforeEach(() => {
    state.repo = null;
    state.setRepo.mockClear();
  });

  it("names the action, and offers to attach when nothing is", () => {
    mount();
    expect(screen.getByRole("dialog", { name: "Attach a project" })).toHaveTextContent(
      /Investigating with Codex needs a project/,
    );
  });

  it("calls it a change once a project is attached", () => {
    state.repo = "acme/app";
    mount();
    expect(screen.getByRole("dialog", { name: "Change the project" })).toBeInTheDocument();
  });

  /** The provider is the one writer: the caller gets a name that is already
   *  true of the cache, so it runs without a second write. */
  it("writes the pick, then resolves with it", async () => {
    const answers = mount();
    expect(answers).toHaveLength(0);

    fireEvent.click(screen.getByRole("option", { name: /app/ }));

    await waitFor(() => expect(answers).toEqual(["acme/app"]));
    expect(state.setRepo).toHaveBeenCalledWith("acme/app", { asDefault: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("carries the default switch into the write", async () => {
    const answers = mount();
    fireEvent.click(screen.getByRole("switch", { name: "Use as the default for triage" }));
    fireEvent.click(screen.getByRole("option", { name: /app/ }));

    await waitFor(() => expect(answers).toEqual(["acme/app"]));
    expect(state.setRepo).toHaveBeenCalledWith("acme/app", { asDefault: true });
  });

  it("resolves null on cancel, and writes nothing", async () => {
    const answers = mount();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(answers).toEqual([null]));
    expect(state.setRepo).not.toHaveBeenCalled();
  });

  it("declines outside a provider rather than guessing", async () => {
    const answers = mount(false);
    await waitFor(() => expect(answers).toEqual([null]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
