/**
 * The one place a triage ticket gets its project, and the question that asks.
 *
 * Every action in the workspace that runs something — an investigation, a
 * terminal, the file and history panes beside the ticket — runs on a project's
 * main checkout, so it needs one. A ticket usually has it already (its own pick,
 * or the triage-wide default; see `useTriageRepo`), and then nothing here is
 * seen. When it doesn't, the action asks through {@link useTriageRepoGate}: the
 * dialog names the action, lists the registered projects, and offers to make
 * the pick the default.
 *
 * The provider is the one writer. It resolves the ask with the picked name only
 * *after* persisting it — per ticket, and as the default when the switch was on
 * — so a caller that gets a name back can run without a second write, and two
 * callers can't disagree about what a pick means. `null` is a cancel, so a
 * caller can simply not proceed. Modelled on `WorktreeGate`, down to the
 * one-question-at-a-time rule and the declined-outside-a-provider default.
 */
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

import { ProjectPickerDialog } from "../../components/ProjectPickerDialog";
import { useTriageRepo } from "../../lib/queries";

/** Ask for a project. `action` is named in the dialog, so it reads as a
 *  sentence: "Investigating with Codex needs a project." Resolves to the picked
 *  (and by then persisted) repo name, or `null` on cancel. */
type Ask = (action: string) => Promise<string | null>;

/** Outside a provider nothing can be attached — deliberately not "silently the
 *  active repo": a surface that forgot to mount the gate must fail to launch,
 *  not launch on a project the user never chose. */
const TriageRepoGateContext = createContext<Ask>(() => Promise.resolve(null));

export function useTriageRepoGate(): Ask {
  return useContext(TriageRepoGateContext);
}

export function TriageRepoGateProvider({
  ticketId,
  children,
}: {
  /** The ticket the pick is written for. Key the provider by it: a pending
   *  question is about *this* ticket, and must not outlive it. */
  ticketId: string;
  children: ReactNode;
}) {
  const { repo, setRepo } = useTriageRepo(ticketId);
  const [action, setAction] = useState<string | null>(null);
  // The pending question's resolver. A ref, not state: answering it must not
  // wait for a render, and a second ask while one is open would otherwise
  // strand the first caller's promise forever.
  const pending = useRef<((repo: string | null) => void) | null>(null);

  const settle = useCallback((picked: string | null) => {
    pending.current?.(picked);
    pending.current = null;
    setAction(null);
  }, []);

  const ask = useCallback<Ask>((next) => {
    // One question at a time. The one already on screen is the one the user is
    // looking at, so a second asker is declined rather than allowed to replace
    // the prompt under their cursor.
    if (pending.current) return Promise.resolve(null);
    setAction(next);
    return new Promise<string | null>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  return (
    <TriageRepoGateContext.Provider value={ask}>
      {children}
      {action !== null && (
        <ProjectPickerDialog
          title={repo ? "Change the project" : "Attach a project"}
          action={action}
          explain="It runs on the project's main checkout. No worktree is created."
          current={repo}
          defaultToggle={{
            label: "Use as the default for triage",
            hint: "Every ticket without a pick of its own runs here, and the queue reads from its Linear workspace. Off: only this ticket.",
          }}
          onPick={(name, asDefault) => {
            // Persist first, resolve second: the optimistic write is what makes
            // the name a caller gets back already true of the cache.
            setRepo(name, { asDefault });
            settle(name);
          }}
          onCancel={() => settle(null)}
        />
      )}
    </TriageRepoGateContext.Provider>
  );
}
