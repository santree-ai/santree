/**
 * The one place a pull request's worktree gets cut, and the confirmation that
 * asks first.
 *
 * Reviewing a PR used to put a throwaway detached tree on disk without saying so:
 * `.santree/reviews/`, five deep, deleted oldest-first. A PR's checkout is an
 * ordinary worktree now — it keeps work, runs terminals and agents, and stays
 * until you delete it — which makes it worth a sentence *before* it appears
 * rather than a note explaining it afterwards.
 *
 * So every action that needs one asks through {@link useWorktreeGate}: the dialog
 * names the action, says what will be created, and offers the setup script as a
 * choice. **The script is off by default.** `.santree/init.sh` installs
 * dependencies and can run for minutes, and "I want to read this PR" is not
 * consent to that — but "I want to run this PR" is exactly what the toggle is
 * for, and it is one click away at the moment it is relevant.
 *
 * The promise resolves once, on the user's answer: `ok: false` on cancel, so a
 * caller can simply not proceed, and there is no second "are you sure" anywhere
 * downstream.
 */
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { BranchIcon } from "../../components/icons";
import { Button, Toggle } from "../../components/primitives";

/** What the user chose. `runSetup` is meaningless when `ok` is false. */
export interface WorktreeChoice {
  ok: boolean;
  runSetup: boolean;
}

/** Ask before cutting the checkout. `action` is named in the dialog, so it reads
 *  as a sentence: "Reviewing with Codex needs a worktree for this pull request." */
type Ask = (action: string) => Promise<WorktreeChoice>;

const DECLINED: WorktreeChoice = { ok: false, runSetup: false };

/** The toggle's accessible name lives in the row's own text, so the switch and
 *  the words that explain it are one control to a screen reader. */
const SETUP_LABEL_ID = "worktree-gate-setup-label";

/** Outside a provider nothing can be created — deliberately not "silently yes":
 *  a surface that forgot to mount the gate must fail to cut a worktree, not cut
 *  one without asking. */
const WorktreeGateContext = createContext<Ask>(() => Promise.resolve(DECLINED));

export function useWorktreeGate(): Ask {
  return useContext(WorktreeGateContext);
}

export function WorktreeGateProvider({ children }: { children: ReactNode }) {
  const [action, setAction] = useState<string | null>(null);
  const [runSetup, setRunSetup] = useState(false);
  // The pending question's resolver. A ref, not state: answering it must not wait
  // for a render, and a second ask while one is open would otherwise strand the
  // first caller's promise forever.
  const pending = useRef<((choice: WorktreeChoice) => void) | null>(null);

  const settle = useCallback((choice: WorktreeChoice) => {
    pending.current?.(choice);
    pending.current = null;
    setAction(null);
    // Back to off for the next PR: the toggle is a decision about this checkout,
    // not a preference. A remembered "yes" would quietly run the script on a
    // repo the user only meant to glance at.
    setRunSetup(false);
  }, []);

  const ask = useCallback<Ask>((next) => {
    // One question at a time. The one already on screen is the one the user is
    // looking at, so a second asker is declined rather than allowed to replace
    // the prompt under their cursor.
    if (pending.current) return Promise.resolve(DECLINED);
    setAction(next);
    return new Promise<WorktreeChoice>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  return (
    <WorktreeGateContext.Provider value={ask}>
      {children}
      {action !== null && (
        <WorktreeDialog
          action={action}
          runSetup={runSetup}
          onToggleSetup={() => setRunSetup((on) => !on)}
          onCancel={() => settle(DECLINED)}
          onConfirm={() => settle({ ok: true, runSetup })}
        />
      )}
    </WorktreeGateContext.Provider>
  );
}

function WorktreeDialog({
  action,
  runSetup,
  onToggleSetup,
  onCancel,
  onConfirm,
}: {
  action: string;
  runSetup: boolean;
  onToggleSetup: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[3px]"
      />
      <div
        role="dialog"
        aria-modal
        aria-label="Create a worktree for this pull request"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="relative flex w-[440px] max-w-full flex-col gap-3 rounded-xl border border-line-3 bg-panel p-4 shadow-2xl"
        style={{ animation: "toastIn .16s ease-out" }}
      >
        <div className="flex items-center gap-2">
          <BranchIcon size={13} className="flex-none text-muted-3" />
          <h2 className="text-[13px] font-medium text-fg">Create a worktree?</h2>
        </div>

        <p className="text-[12px] leading-[1.55] text-muted-2">
          {action} needs this pull request checked out. santree will create a worktree on the PR's
          branch — a real checkout you can build, run and open terminals in.
        </p>
        <p className="text-[11px] leading-[1.5] text-muted-4">
          It stays out of Trees until you keep it, and it lives until you delete it.
        </p>

        {/* The one decision worth offering here: everything else about the
            checkout is the same as any other worktree's, but the setup script
            costs minutes and installs things, so it is asked rather than
            assumed. */}
        <div className="flex items-start gap-2.5 rounded-lg border border-hairline bg-raised px-3 py-2.5">
          <span className="mt-px flex-none">
            <Toggle on={runSetup} onClick={onToggleSetup} ariaLabelledBy={SETUP_LABEL_ID} />
          </span>
          <span className="min-w-0">
            <span id={SETUP_LABEL_ID} className="block text-[12px] leading-4 text-fg-2">
              Run the setup script
            </span>
            <span className="block text-[10.5px] leading-[1.45] text-muted-4">
              <code className="font-mono">.santree/init.sh</code> — installs dependencies so the
              branch can be built and run. Off by default: it can take minutes.
            </span>
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-0.5">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {/* Autofocused so Enter confirms and Escape cancels — the dialog
              interrupts an action the user just asked for, so the fast path out
              of it is the one they were already taking. */}
          <Button size="sm" autoFocus onClick={onConfirm}>
            Create worktree
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
