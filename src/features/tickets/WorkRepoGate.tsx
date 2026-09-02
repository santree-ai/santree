/**
 * The one place a ticket gets the project it is started in, and the question
 * that asks.
 *
 * A ticket is a Linear object, and several registered projects can share its
 * org — so "start AK-1" isn't runnable until a project is named. Three answers,
 * in order: a ticket only one project carries runs there, and nothing is asked;
 * the Work default project (Settings → Work), when it is one of them; else the
 * dialog, which lists just the projects that carry the ticket and offers to
 * make the pick the default. Both ways of starting work from the list — Run and
 * the launch queue — resolve through here, so they can't answer the same ticket
 * differently.
 *
 * `always` skips the first two answers: the menu's "Run in another project…" is
 * a request to be asked. Modelled on `TriageRepoGate`, down to the
 * one-question-at-a-time rule and the declined-outside-a-provider default — a
 * list that forgot to mount the gate must fail to start, not start on a project
 * the user never chose.
 */
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

import { ProjectPickerDialog } from "../../components/ProjectPickerDialog";
import { useWorkDefaultRepo } from "../../lib/queries";

/** Resolve the project for `action` — named in the dialog, so it reads
 *  "Starting AK-1 needs a project." — out of `candidates`, the projects that
 *  carry the ticket. Resolves to the picked name, or `null` on cancel. */
export type AskWorkRepo = (
  candidates: string[],
  action: string,
  opts?: { always?: boolean },
) => Promise<string | null>;

const WorkRepoGateContext = createContext<AskWorkRepo>(() => Promise.resolve(null));

export function useWorkRepoGate(): AskWorkRepo {
  return useContext(WorkRepoGateContext);
}

interface Question {
  action: string;
  candidates: string[];
}

export function WorkRepoGateProvider({ children }: { children: ReactNode }) {
  const { repo: defaultRepo, setRepo: setDefault } = useWorkDefaultRepo();
  const [question, setQuestion] = useState<Question | null>(null);
  // The pending question's resolver. A ref, not state: answering it must not
  // wait for a render, and a second ask while one is open would otherwise
  // strand the first caller's promise forever.
  const pending = useRef<((repo: string | null) => void) | null>(null);
  // Read at ask time through a ref so `ask` keeps one identity — callers hold
  // it in memoized handlers — while the default changes under it.
  const defaultRef = useRef(defaultRepo);
  defaultRef.current = defaultRepo;

  const settle = useCallback((picked: string | null) => {
    pending.current?.(picked);
    pending.current = null;
    setQuestion(null);
  }, []);

  const ask = useCallback<AskWorkRepo>((candidates, action, opts) => {
    if (!opts?.always) {
      if (candidates.length === 1) return Promise.resolve(candidates[0]);
      const preset = defaultRef.current;
      if (preset && candidates.includes(preset)) return Promise.resolve(preset);
    }
    // Nothing to choose from, or a question already on screen — the one the
    // user is looking at, so a second asker is declined rather than allowed to
    // replace the prompt under their cursor.
    if (candidates.length === 0 || pending.current) return Promise.resolve(null);
    setQuestion({ action, candidates });
    return new Promise<string | null>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  // The default, marked "current", when it is on offer — the `always` path
  // shows the user what they'd have got without asking.
  const current =
    question && defaultRepo && question.candidates.includes(defaultRepo) ? defaultRepo : null;

  return (
    <WorkRepoGateContext.Provider value={ask}>
      {children}
      {question !== null && (
        <ProjectPickerDialog
          title="Which project?"
          action={question.action}
          current={current}
          repos={question.candidates}
          explain="More than one of your projects carries this ticket; the worktree is created in the one you pick."
          defaultToggle={{
            label: "Use as the default for work",
            hint: "Every ticket more than one project carries is started and queued here from now on (Settings → Work). Off: only this once.",
          }}
          onPick={(name, asDefault) => {
            // Persist first, resolve second: the optimistic write is what makes
            // the name a caller gets back already true of the cache.
            if (asDefault) setDefault(name);
            settle(name);
          }}
          onCancel={() => settle(null)}
        />
      )}
    </WorkRepoGateContext.Provider>
  );
}
