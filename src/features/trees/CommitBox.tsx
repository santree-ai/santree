/** The commit box at the bottom of the Changes list: a message field with an
 *  AI-draft button, honouring the "stage all before committing" preference. The
 *  message is persisted per worktree (DB-backed), so it survives switching tabs,
 *  closing the worktree, or an app crash — until you commit (which clears it) or
 *  regenerate it with AI. Mount with `key={worktreeId}` for a per-worktree draft. */
import { useEffect, useRef, useState } from "react";

import { Button, Spinner } from "../../components/primitives";
import {
  TREES_AUTO_PR_KEY,
  TREES_AUTO_PUSH_KEY,
  TREES_STAGE_ALL_KEY,
  useCommitDraft,
  useCommitMessage,
  useCommitWorktree,
  usePushWorktree,
  useResolvedBoolSetting,
  useSetCommitDraft,
} from "../../lib/queries";
import { BASE_ID, useTrees } from "./model";

const SAVE_DEBOUNCE_MS = 500;

export function CommitBox({
  stagedCount,
  totalCount,
}: {
  stagedCount: number;
  totalCount: number;
}) {
  const { repo, activeId, openPrDialog, prsByWorktree, suggestPr } = useTrees();
  // Resolved through the repo's overrides — Settings → Trees offers these per repo
  // ("never auto-push in this one"), so reading the app default would ignore it.
  const stageAll = useResolvedBoolSetting(repo, TREES_STAGE_ALL_KEY).value;
  const autoPr = useResolvedBoolSetting(repo, TREES_AUTO_PR_KEY).value;
  const autoPush = useResolvedBoolSetting(repo, TREES_AUTO_PUSH_KEY).value;

  const { data: saved } = useCommitDraft(repo, activeId);
  const { mutate: saveDraft } = useSetCommitDraft(repo);
  const { mutate: draft, isPending: drafting } = useCommitMessage(repo);
  const { mutate: commit, isPending: committing } = useCommitWorktree(repo);
  const { mutate: push } = usePushWorktree(repo);

  const [message, setMessage] = useState("");
  // The saved draft loads asynchronously; adopt it into the field exactly once so
  // later cache updates (our own optimistic save) never clobber active typing. If
  // the user already started typing before the draft resolved (cold cache), their
  // in-progress input wins — never stomp it with the loaded value.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || saved === undefined) return;
    seeded.current = true;
    if (message === "") setMessage(saved ?? "");
  }, [saved, message]);

  // Autosave the draft a beat after typing stops (no-op once it matches what's
  // stored — our optimistic write makes `saved` equal `message` after a save).
  useEffect(() => {
    if (!seeded.current || message === (saved ?? "")) return;
    const timer = setTimeout(() => saveDraft({ id: activeId, message }), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [message, saved, activeId, saveDraft]);

  // Mirror the latest values into refs so the unmount effect below can read them
  // without depending on (and re-firing for) every keystroke.
  const messageRef = useRef(message);
  messageRef.current = message;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Switching worktrees mid-typing (this component is mounted with
  // key={worktreeId}) unmounts before the debounce timer above ever fires,
  // silently dropping the last edits. Flush any unsaved draft synchronously on
  // teardown so typing is never lost. Mounted with key={activeId}, so this only
  // runs on true mount/unmount, never on an activeId change underneath the same
  // instance.
  useEffect(() => {
    return () => {
      if (messageRef.current !== (savedRef.current ?? "")) {
        saveDraftRef.current({ id: activeIdRef.current, message: messageRef.current });
      }
    };
  }, []);

  // With "stage all" on we commit everything; otherwise only what's staged.
  const committable = stageAll ? totalCount : stagedCount;
  const canCommit = committable > 0 && message.trim().length > 0 && !committing;

  const onDraft = () => draft(activeId, { onSuccess: (msg) => setMessage(msg) });
  const onCommit = () =>
    commit(
      { id: activeId, message: message.trim(), stageAll },
      {
        onSuccess: () => {
          // The backend clears the persisted draft on commit; clear the field to
          // match (autosave then settles the cache to empty).
          setMessage("");
          // "Push after every commit": upload the new commit to origin straight
          // away (sets upstream on first push). Once it lands, surface the PR
          // suggestion bar (skipped for the base branch). Independent of autoPr.
          if (autoPush && activeId !== BASE_ID) {
            push(activeId, { onSuccess: () => suggestPr(activeId) });
          } else if (autoPush) {
            push(activeId);
          }
          // "Open a PR on the first commit": prompt once there's a commit to PR
          // and no PR exists yet. The dialog validates commits-ahead itself. Never
          // for the base branch — you don't open a PR against main itself.
          const hasPr = (prsByWorktree.get(activeId) ?? []).length > 0;
          if (autoPr && !hasPr && activeId !== BASE_ID) openPrDialog(activeId);
        },
      },
    );

  return (
    <div className="flex-none border-t border-line bg-panel p-2.5">
      <div className="relative">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={stageAll ? "Commit message (stages all)" : "Commit message"}
          rows={3}
          className="w-full resize-none rounded-lg border border-line-3 bg-input px-2.5 py-2 pr-8 font-mono text-[11.5px] text-fg-3 outline-none placeholder:text-muted-4 focus:border-line-strong"
        />
        <button
          type="button"
          onClick={onDraft}
          disabled={drafting || committable === 0}
          title="Draft a message with AI"
          className="absolute top-2 right-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-2 hover:bg-hover hover:text-accent disabled:opacity-40"
        >
          {drafting ? <Spinner size={12} /> : <span className="text-[13px] leading-none">✨</span>}
        </button>
      </div>
      <Button variant="primary" onClick={onCommit} disabled={!canCommit} className="mt-2 w-full">
        {committing
          ? "Committing…"
          : `Commit${committable ? ` ${committable} file${committable === 1 ? "" : "s"}` : ""}`}
      </Button>
    </div>
  );
}
