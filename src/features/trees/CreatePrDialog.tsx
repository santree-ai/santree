/** The create-PR dialog: pushes the branch and opens a GitHub PR. Prefills the
 *  title (first commit subject) + body (repo PR template), with an AI-fill button
 *  that drafts both from the diff. On success it opens the new PR in the browser. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";

import { Spinner } from "../../components/primitives";
import { useCreatePr, usePrDraft } from "../../lib/queries";
import { toast } from "../../state/toast";
import { alpha } from "../../theme/colors";
import { useTrees } from "./model";

export function CreatePrDialog() {
  const { repo, prDialogFor, closePrDialog } = useTrees();
  // Rendered only when a worktree is targeted, so this is always set on mount.
  const id = prDialogFor ?? "";

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { mutate: draft, isPending: drafting } = usePrDraft(repo);
  const { mutate: create, isPending: creating } = useCreatePr(repo);

  // Prefill from a non-AI draft (template + first-commit title) on open.
  useEffect(() => {
    draft(
      { id, fill: false },
      {
        onSuccess: (d) => {
          setTitle(d.title);
          setBody(d.body);
          setBase(d.baseBranch);
          setLoaded(true);
        },
        onError: (e) => {
          setError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        },
      },
    );
    // `draft` (react-query mutate) is stable, so this runs once per opened worktree.
  }, [id, draft]);

  const onFill = () =>
    draft(
      { id, fill: true },
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
      { id, title: title.trim(), body },
      {
        onSuccess: (pr) => {
          void openUrl(pr.url);
          toast.success(`Opened PR #${pr.number}.`);
          closePrDialog();
        },
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  const canCreate = title.trim().length > 0 && !creating && loaded;

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
        role="dialog"
        aria-modal
        aria-label="Create pull request"
        className="relative flex w-[560px] max-w-full flex-col rounded-xl border border-line-3 bg-panel p-4 shadow-2xl"
        style={{ animation: "toastIn .16s ease-out" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-fg-bright">Create pull request</span>
          {base && (
            <span className="font-mono text-[10.5px] text-muted-3">
              {id} → {base}
            </span>
          )}
        </div>

        {!loaded ? (
          <div className="flex items-center gap-2 py-8 text-[12px] text-muted-2">
            <Spinner size={12} /> Preparing…
          </div>
        ) : (
          <>
            <label className="mt-3 mb-1 flex flex-col gap-1 text-[11px] font-medium text-muted-2">
              Title
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Pull request title"
                className="w-full rounded-lg border border-line-3 bg-input px-2.5 py-2 text-[12.5px] text-fg-2 outline-none placeholder:text-muted-4 focus:border-line-strong"
              />
            </label>

            <div className="mt-3 mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-2">Description</span>
              <button
                type="button"
                onClick={onFill}
                disabled={drafting}
                title="Draft title + description with AI (from the PR template & diff)"
                className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-2 hover:bg-hover hover:text-accent disabled:opacity-40"
              >
                {drafting ? (
                  <Spinner size={11} />
                ) : (
                  <span className="text-[12px] leading-none">✨</span>
                )}
                {drafting ? "Drafting…" : "AI fill"}
              </button>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Pull request description (Markdown)"
              rows={12}
              className="w-full resize-none rounded-lg border border-line-3 bg-input px-2.5 py-2 font-mono text-[11.5px] leading-[1.5] text-fg-3 outline-none placeholder:text-muted-4 focus:border-line-strong"
            />
          </>
        )}

        {error && (
          <div
            className="mt-2.5 rounded-md px-2.5 py-1.5 text-[11px] leading-[1.45]"
            style={{
              color: "var(--color-status-red)",
              background: alpha(10, "var(--color-status-red)"),
              border: `1px solid ${alpha(30, "var(--color-status-red)")}`,
            }}
          >
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={closePrDialog}
            disabled={creating}
            className="cursor-pointer rounded-md border border-line-2 bg-input px-3 py-1.5 text-[12px] text-muted-2 hover:text-fg-2 disabled:cursor-default disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={!canCreate}
            style={{ color: "var(--on-accent)" }}
            className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          >
            {creating ? (
              <>
                <Spinner size={12} /> Creating…
              </>
            ) : (
              "Create PR"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
