/** The create-PR dialog: pushes the branch and opens a GitHub PR. Prefills the
 *  title (first commit subject) + body (repo PR template), with an AI-fill button
 *  that drafts both from the diff. On success it opens the new PR in the browser. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";

import type { Reviewer } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { AgentIcon, CloseIcon } from "../../components/icons";
import { Button, Spinner, useModalA11y } from "../../components/primitives";
import {
  PR_BODY_AGENT_KEY,
  useCreatePr,
  usePrDraft,
  usePrReviewers,
  useResolvedHelperAgent,
  useWorktreeHasTranscripts,
} from "../../lib/queries";
import { toast } from "../../state/toast";
import { alpha } from "../../theme/colors";
import { useTrees } from "./model";

export function CreatePrDialog() {
  const { repo, prDialogFor, closePrDialog, prsByWorktree } = useTrees();
  // Rendered only when a worktree is targeted, so this is always set on mount.
  const id = prDialogFor ?? "";

  // An already-open PR for this branch blocks a new one (GitHub rejects duplicates).
  // Merged/closed PRs don't — the branch can have new commits to open a fresh PR for.
  const openPr = (prsByWorktree.get(id) ?? []).find((p) => p.state === "Open");

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [draftPr, setDraftPr] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  // Opt-in: feed this worktree's Claude session transcript(s) to the AI fill for
  // extra context (decisions/rationale the diff doesn't show). Only affects the ✨
  // draft; the checkbox is shown only when there's transcript history to send.
  const [sendTranscripts, setSendTranscripts] = useState(false);
  // The prefill is a round-trip (git + the repo's PR template); the form is usable
  // from the first frame and adopts the prefill when it lands — per field, and only
  // if that field is still untouched, so it can never overwrite what's being typed
  // (the same seed-if-untouched rule CommitBox uses for its saved draft).
  const [prefilling, setPrefilling] = useState(true);
  const titleTouched = useRef(false);
  const bodyTouched = useRef(false);

  const { mutate: draft, isPending: drafting } = usePrDraft(repo);
  const draftAgent = useResolvedHelperAgent(repo, PR_BODY_AGENT_KEY);
  const { mutate: create, isPending: creating } = useCreatePr(repo);
  const { data: candidates = [] } = usePrReviewers(repo, id);
  const { data: hasTranscripts } = useWorktreeHasTranscripts(repo, id);

  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Same focus-trap/Escape/restore-focus pattern as ConfirmDialog — shared via
  // useModalA11y so the two dialogs' modal a11y can't drift apart.
  useModalA11y({
    open: true,
    busy: creating,
    onClose: closePrDialog,
    dialogRef,
    initialFocusRef: cancelRef,
  });

  // Prefill from a non-AI draft (template + first-commit title) on open.
  useEffect(() => {
    draft(
      { id, fill: false, sendTranscripts: false },
      {
        onSuccess: (d) => {
          if (!titleTouched.current) setTitle(d.title);
          if (!bodyTouched.current) setBody(d.body);
          setBase(d.baseBranch);
          setPrefilling(false);
        },
        onError: (e) => {
          setError(e instanceof Error ? e.message : String(e));
          setPrefilling(false);
        },
      },
    );
    // `draft` (react-query mutate) is stable, so this runs once per opened worktree.
  }, [id, draft]);

  // The AI fill shares the draft mutation with the prefill above — only the former
  // is the user waiting on a "Drafting…" button for.
  const aiDrafting = drafting && !prefilling;

  const onFill = () =>
    draft(
      { id, fill: true, sendTranscripts },
      {
        onSuccess: (d) => {
          setTitle(d.title);
          setBody(d.body);
        },
      },
    );

  const onCreate = () => {
    setError(null);
    create(
      { id, title: title.trim(), body, draft: draftPr, reviewers },
      {
        onSuccess: (pr) => {
          void openUrl(pr.url);
          toast.success(`Opened ${draftPr ? "draft " : ""}PR #${pr.number}.`);
          closePrDialog();
        },
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  const canCreate = title.trim().length > 0 && !creating && !openPr;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => !creating && closePrDialog()}
        className="absolute inset-0 cursor-default bg-black/50"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-label="Create pull request"
        className="relative flex w-[560px] max-w-full flex-col rounded-xl border border-line-3 bg-panel p-4 shadow-2xl"
        style={{ animation: "toastIn .16s ease-out" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-fg-bright">Create pull request</span>
          {base ? (
            <span className="font-mono text-[10.5px] text-muted-3">
              {id} → {base}
            </span>
          ) : (
            prefilling && <Spinner size={11} />
          )}
        </div>

        <label className="mt-3 mb-1 flex flex-col gap-1 text-[11px] font-medium text-muted-2">
          Title
          <input
            value={title}
            onChange={(e) => {
              titleTouched.current = true;
              setTitle(e.target.value);
            }}
            placeholder="Pull request title"
            className="w-full rounded-lg border border-line-3 bg-input px-2.5 py-2 text-[12.5px] text-fg-2 outline-none placeholder:text-muted-4 focus:border-line-strong"
          />
        </label>

        <div className="mt-3 mb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-2">Description</span>
          <div className="flex items-center gap-2.5">
            {hasTranscripts && (
              <label
                title="Let AI read this worktree's Claude session(s) for the decisions and rationale the diff doesn't show"
                className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-2 hover:text-fg-2"
              >
                <input
                  type="checkbox"
                  checked={sendTranscripts}
                  onChange={(e) => setSendTranscripts(e.target.checked)}
                  disabled={drafting}
                  className="h-3 w-3 cursor-pointer accent-[var(--accent)]"
                />
                Use transcripts
              </label>
            )}
            <button
              type="button"
              onClick={onFill}
              disabled={drafting}
              title="Draft title + description with AI (from the PR template & diff)"
              className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-2 hover:bg-hover hover:text-accent disabled:opacity-40"
            >
              {aiDrafting ? <Spinner size={11} /> : <AgentIcon kind={draftAgent} size={11} />}
              {aiDrafting ? "Drafting…" : "AI fill"}
            </button>
          </div>
        </div>
        <textarea
          value={body}
          onChange={(e) => {
            bodyTouched.current = true;
            setBody(e.target.value);
          }}
          placeholder="Pull request description (Markdown)"
          rows={10}
          className="w-full resize-none rounded-lg border border-line-3 bg-input px-2.5 py-2 font-mono text-[11.5px] leading-[1.5] text-fg-3 outline-none placeholder:text-muted-4 focus:border-line-strong"
        />

        {candidates.length > 0 && (
          <div className="mt-3">
            <span className="text-[11px] font-medium text-muted-2">Reviewers</span>
            <ReviewerPicker candidates={candidates} selected={reviewers} onChange={setReviewers} />
          </div>
        )}

        {openPr && (
          <div className="mt-2.5 flex items-center gap-2 rounded-md border border-line-2 bg-raised px-2.5 py-1.5 text-[11.5px] text-muted-2">
            <span>A pull request is already open for this branch (#{openPr.number}).</span>
            <button
              type="button"
              onClick={() => void openUrl(openPr.url)}
              className="ml-auto cursor-pointer font-medium text-accent hover:underline"
            >
              View PR
            </button>
          </div>
        )}

        {error && (
          <div
            className="selectable mt-2.5 rounded-md px-2.5 py-1.5 text-[11px] leading-[1.45]"
            style={{
              color: "var(--color-status-red)",
              background: alpha(10, "var(--color-status-red)"),
              border: `1px solid ${alpha(30, "var(--color-status-red)")}`,
            }}
          >
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-muted-2 hover:text-fg-2">
            <input
              type="checkbox"
              checked={draftPr}
              onChange={(e) => setDraftPr(e.target.checked)}
              disabled={creating}
              className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
            />
            Create as draft
          </label>
          <div className="flex-1" />
          <Button ref={cancelRef} onClick={closePrDialog} disabled={creating}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onCreate} disabled={!canCreate}>
            {creating ? (
              <>
                <Spinner size={12} /> Creating…
              </>
            ) : draftPr ? (
              "Create draft"
            ) : (
              "Create PR"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A compact multi-select for requesting PR reviewers: selected reviewers show as
 *  removable chips, and a search field reveals a filtered list of the repo's
 *  collaborators to add. Selection is by login (what the GitHub API expects). */
function ReviewerPicker({
  candidates,
  selected,
  onChange,
}: {
  candidates: Reviewer[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Close the suggestion list when focus leaves the whole control.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const add = (login: string) => {
    if (!selected.includes(login)) onChange([...selected, login]);
    setQuery("");
  };
  const remove = (login: string) => onChange(selected.filter((l) => l !== login));

  const q = query.trim().toLowerCase();
  const matches = candidates.filter(
    (c) => !selected.includes(c.name) && c.name.toLowerCase().includes(q),
  );

  return (
    <div ref={boxRef} className="relative mt-1">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line-3 bg-input px-2 py-1.5 focus-within:border-line-strong">
        {selected.map((login) => {
          const c = candidates.find((x) => x.name === login);
          return (
            <span
              key={login}
              className="flex items-center gap-1.5 rounded-full border border-line-2 bg-raised py-0.5 pr-1 pl-1 text-[11.5px] text-fg-2"
            >
              <Avatar name={login} src={c?.avatarUrl} size={16} />
              {login}
              <button
                type="button"
                onClick={() => remove(login)}
                title="Remove reviewer"
                className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-full text-muted-3 hover:bg-hover hover:text-fg-2"
              >
                <CloseIcon size={9} />
              </button>
            </span>
          );
        })}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={selected.length ? "" : "Add reviewers…"}
          className="min-w-[100px] flex-1 bg-transparent py-0.5 text-[12px] text-fg-2 outline-none placeholder:text-muted-4"
        />
      </div>

      {open && matches.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-44 w-full overflow-auto rounded-lg border border-line-3 bg-panel py-1 shadow-xl">
          {matches.slice(0, 30).map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => add(c.name)}
              className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-fg-2 hover:bg-hover"
            >
              <Avatar name={c.name} src={c.avatarUrl} size={18} />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
