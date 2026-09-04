/**
 * The gate's three answers, in order — the one project that carries the
 * ticket, the Work default, the question — and the promise around them: an ask
 * resolves with the name (after the default is written, when asked to), `null`
 * on cancel, and nothing outside a provider.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  repo: null as string | null,
  setRepo: vi.fn(),
}));
vi.mock("../lib/queries", () => ({
  useRepos: () => ({
    data: [
      { name: "acme/app", path: "/src/app" },
      { name: "acme/infra", path: "/src/infra" },
      { name: "acme/web", path: "/src/web" },
    ],
  }),
  useWorkDefaultRepo: () => ({ repo: state.repo, loading: false, setRepo: state.setRepo }),
}));

import { useWorkRepoGate, WorkRepoGateProvider } from "./WorkRepoGate";

/** A caller that asks once when clicked and records what came back. */
function Asker({
  candidates,
  always,
  answers,
}: {
  candidates: string[];
  always?: boolean;
  answers: (string | null)[];
}) {
  const ask = useWorkRepoGate();
  return (
    <button
      type="button"
      onClick={() => {
        void ask(candidates, "Starting AK-1", { always }).then((repo) => answers.push(repo));
      }}
    >
      ask
    </button>
  );
}

function mount(candidates: string[], opts: { always?: boolean; provider?: boolean } = {}) {
  const answers: (string | null)[] = [];
  const asker = <Asker candidates={candidates} always={opts.always} answers={answers} />;
  render(opts.provider === false ? asker : <WorkRepoGateProvider>{asker}</WorkRepoGateProvider>);
  fireEvent.click(screen.getByRole("button", { name: "ask" }));
  return answers;
}

const TWO = ["acme/app", "acme/infra"];

describe("WorkRepoGate", () => {
  beforeEach(() => {
    state.repo = null;
    state.setRepo.mockClear();
  });

  it("answers a ticket only one project carries without asking", async () => {
    const answers = mount(["acme/infra"]);
    await waitFor(() => expect(answers).toEqual(["acme/infra"]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("answers with the Work default when it is one of the candidates", async () => {
    state.repo = "acme/infra";
    const answers = mount(TWO);
    await waitFor(() => expect(answers).toEqual(["acme/infra"]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks when the default is not on offer, over just the candidates", () => {
    state.repo = "acme/web";
    mount(TWO);
    const dialog = screen.getByRole("dialog", { name: "Which project?" });
    expect(dialog).toHaveTextContent(/Starting AK-1 needs a project/);
    const options = screen.getAllByRole("option").map((o) => o.getAttribute("title"));
    expect(options).toEqual(TWO);
  });

  it("resolves with the pick, and writes the default only when the switch is on", async () => {
    const answers = mount(TWO);
    fireEvent.click(screen.getByRole("option", { name: /infra/ }));
    await waitFor(() => expect(answers).toEqual(["acme/infra"]));
    expect(state.setRepo).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("makes the pick the Work default when asked to", async () => {
    const answers = mount(TWO);
    fireEvent.click(screen.getByRole("switch", { name: "Use as the default for work" }));
    fireEvent.click(screen.getByRole("option", { name: /app/ }));
    await waitFor(() => expect(answers).toEqual(["acme/app"]));
    expect(state.setRepo).toHaveBeenCalledWith("acme/app");
  });

  it("asks anyway when told to, with the default marked current", () => {
    state.repo = "acme/app";
    mount(TWO, { always: true });
    expect(screen.getByRole("dialog", { name: "Which project?" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /app/ })).toHaveAttribute("aria-selected", "true");
  });

  it("resolves null on cancel", async () => {
    const answers = mount(TWO);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(answers).toEqual([null]));
  });

  it("declines outside a provider", async () => {
    const answers = mount(TWO, { provider: false });
    await waitFor(() => expect(answers).toEqual([null]));
  });
});
