import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useWorktreeGate, type WorktreeChoice, WorktreeGateProvider } from "./WorktreeGate";

/** A caller that asks once when clicked and records what came back. */
function Asker({ answers }: { answers: WorktreeChoice[] }) {
  const ask = useWorktreeGate();
  return (
    <button
      type="button"
      onClick={() => {
        void ask("Reviewing with Codex").then((choice) => answers.push(choice));
      }}
    >
      ask
    </button>
  );
}

function mount() {
  const answers: WorktreeChoice[] = [];
  render(
    <WorktreeGateProvider>
      <Asker answers={answers} />
    </WorktreeGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "ask" }));
  return answers;
}

const setupToggle = () => screen.getByRole("switch", { name: "Run the setup script" });

describe("WorktreeGate", () => {
  it("names the action that needs the checkout", () => {
    mount();
    expect(screen.getByRole("dialog")).toHaveTextContent(/Reviewing with Codex needs/);
  });

  /** The whole reason the dialog exists: cutting a worktree writes a working tree
   *  to disk, and until now reviewing a PR did that without saying so. */
  it("creates nothing until the user says so", async () => {
    const answers = mount();
    expect(answers).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(answers).toEqual([{ ok: true, runSetup: false }]));
  });

  it("declines on cancel, so the caller simply does not proceed", async () => {
    const answers = mount();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(answers).toEqual([{ ok: false, runSetup: false }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /** `.santree/init.sh` installs dependencies and can run for minutes. Reading a
   *  pull request is not consent to that, so the switch starts off — and the
   *  answer only carries `runSetup` when it was actually turned on. */
  it("leaves the setup script off unless it is asked for", async () => {
    const answers = mount();
    expect(setupToggle()).toHaveAttribute("aria-checked", "false");

    fireEvent.click(setupToggle());
    expect(setupToggle()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(answers).toEqual([{ ok: true, runSetup: true }]));
  });

  /** A remembered "yes" would quietly run the script on the next PR, which is the
   *  opposite of asking. */
  it("forgets the toggle between questions", async () => {
    const answers = mount();
    fireEvent.click(setupToggle());
    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(answers).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    expect(setupToggle()).toHaveAttribute("aria-checked", "false");
  });

  it("closes on Escape without creating anything", async () => {
    const answers = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(answers).toEqual([{ ok: false, runSetup: false }]));
  });

  /** Outside a provider nothing may be created. A surface that forgot to mount
   *  the gate must fail to cut a worktree, never cut one without asking. */
  it("declines when there is no gate mounted", async () => {
    const answers: WorktreeChoice[] = [];
    render(<Asker answers={answers} />);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    await waitFor(() => expect(answers).toEqual([{ ok: false, runSetup: false }]));
  });
});
