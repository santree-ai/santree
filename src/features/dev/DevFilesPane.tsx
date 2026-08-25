/**
 * The Dev tab's **Files** pane: browse the santree checkout, read the diff of
 * what's changed, and commit — without leaving the tab you're building from.
 *
 * It reads the checkout through the shared `worktree_*` commands, addressed as
 * the repo root on its current branch ({@link BASE_ID}) — the same coordinates
 * the Trees sidebar's base entry uses. That's why it needs the checkout to be a
 * *registered* repo (those commands take a repo name, not a path), and why every
 * query hook, staging action and commit here is the one Trees already uses
 * rather than a Dev-only reimplementation.
 *
 * The list/diff chrome is Dev's own, though. Trees' file picker is welded to its
 * own context (panel geometry, tab state, PR suggestions) — reproducing that here
 * would mean unpicking it, and the Dev tab is deliberately deletable in one go.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { ChangedFile } from "../../bindings";
import { ClaudeSparkIcon, SearchIcon } from "../../components/icons";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ListSkeleton,
  Spinner,
  Tabs,
} from "../../components/primitives";
import {
  queryKeys,
  useAddRepo,
  useCommitMessage,
  useCommitWorktree,
  usePushWorktree,
  useStageAction,
  useWorktreeFileDiff,
  useWorktreeFileSource,
  useWorktreeFiles,
  useWorktreeStatus,
} from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { CodeView } from "../trees/CodeView";
import { STATUS_META } from "../trees/changeTree";
import { DiffViewer } from "../trees/DiffViewer";
import { fileIconUrl } from "../trees/fileIcons";
import { BASE_ID } from "../trees/model";

type FileTab = "changes" | "all";

/** How many "All files" rows to render at once. The list is flat and unvirtualized
 *  — enough for this repo, and the search box is the way past the cap. */
const ALL_FILES_CAP = 400;

export function DevFilesPane({
  repoPath,
  repoName,
}: {
  repoPath: string;
  /** `null` until the checkout is in the repo list — see the module note. */
  repoName: string | null;
}) {
  const { mutate: addRepo, isPending: adding } = useAddRepo();
  const qc = useQueryClient();

  if (!repoName) {
    return (
      <EmptyState
        title="This checkout isn't in your repo list"
        subtitle={
          <span className="flex flex-col items-center gap-3">
            <span>
              Files reads the working tree through the same commands Trees uses, which address a
              repo by name. Adding it here is the same as adding it in Settings.
            </span>
            <Button
              variant="primary"
              disabled={adding}
              onClick={() =>
                addRepo(repoPath, {
                  onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.devInfo(repoPath) }),
                })
              }
            >
              {adding ? "Adding…" : "Add this checkout"}
            </Button>
          </span>
        }
      />
    );
  }
  return <FilesPane repoName={repoName} />;
}

function FilesPane({ repoName }: { repoName: string }) {
  const [tab, setTab] = useState<FileTab>("changes");
  const [selected, setSelected] = useState<string | null>(null);
  const { accent } = useApp();
  // No `?? []`: `undefined` means "not loaded yet", which the list renders as a
  // skeleton. Defaulting here would assert "no changes" before we know.
  const { data: status } = useWorktreeStatus(repoName, BASE_ID);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[320px] flex-none flex-col border-r border-line bg-deep">
        <div className="flex h-9 flex-none items-stretch border-b border-line px-1">
          <Tabs<FileTab>
            tabs={[
              { value: "changes", label: `Changes${status?.length ? ` · ${status.length}` : ""}` },
              { value: "all", label: "All files" },
            ]}
            value={tab}
            onChange={setTab}
            variant="inset"
            accent={accent}
            className="h-full items-stretch"
            tabClassName="h-full"
          />
        </div>
        {tab === "changes" ? (
          <ChangesList
            repoName={repoName}
            files={status}
            selected={selected}
            onSelect={setSelected}
          />
        ) : (
          <AllFilesList repoName={repoName} selected={selected} onSelect={setSelected} />
        )}
        <CommitBar repoName={repoName} files={status ?? []} />
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <FileView repoName={repoName} path={selected} files={status ?? []} />
        ) : (
          <EmptyState
            title="No file selected"
            subtitle="Pick a file to read it, or a changed one to see its diff."
          />
        )}
      </div>
    </div>
  );
}

function Row({
  path,
  selected,
  onSelect,
  children,
}: {
  path: string;
  selected: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dir = path.slice(0, path.lastIndexOf("/"));
  const icon = fileIconUrl(name);
  // The row is a container, not itself a button: the trailing actions are buttons
  // of their own, and nesting those inside one is invalid HTML (and unreachable
  // by keyboard).
  return (
    <div data-active={selected} className="selection-row flex w-full items-center pr-1">
      <button
        type="button"
        onClick={onSelect}
        title={path}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 py-1 text-left"
      >
        {icon ? (
          <img src={icon} alt="" className="h-3.5 w-3.5 flex-none" />
        ) : (
          <span className="w-3.5 flex-none" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-3">
          {name}
          {dir && <span className="ml-1.5 text-[10px] text-muted-4">{dir}</span>}
        </span>
      </button>
      {children}
    </div>
  );
}

function ChangesList({
  repoName,
  files,
  selected,
  onSelect,
}: {
  repoName: string;
  /** `undefined` until the status loads — distinct from `[]` ("nothing to commit"). */
  files: ChangedFile[] | undefined;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { mutateAsync: actAsync } = useStageAction(repoName, BASE_ID);
  const [discarding, setDiscarding] = useState<string | null>(null);

  if (files === undefined) return <ListSkeleton rows={6} />;
  if (files.length === 0) {
    return <EmptyState title="Nothing to commit" subtitle="The checkout is clean." />;
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {files.map((f) => {
          const meta = STATUS_META[f.status];
          return (
            <Row
              key={f.path}
              path={f.path}
              selected={selected === f.path}
              onSelect={() => onSelect(f.path)}
            >
              <span
                className="flex-none font-mono text-[10px]"
                style={{ color: meta.color }}
                title={f.status}
              >
                {meta.letter}
              </span>
              <button
                type="button"
                aria-label={`Discard changes to ${f.path}`}
                title="Discard changes"
                onClick={() => setDiscarding(f.path)}
                className="flex-none cursor-pointer px-1 text-[13px] leading-none text-muted-4 hover:text-status-red"
              >
                ×
              </button>
            </Row>
          );
        })}
      </div>
      <ConfirmDialog
        open={discarding !== null}
        title="Discard changes?"
        // Uncommitted work is unrecoverable, so this asks first — the same rule
        // the Trees changes list follows.
        message={`${discarding} goes back to its committed state. This can't be undone.`}
        confirmLabel="Discard"
        busyLabel="Discarding…"
        danger
        onConfirm={async () => {
          if (discarding) await actAsync({ action: "discard", path: discarding });
        }}
        onClose={() => setDiscarding(null)}
      />
    </>
  );
}

function AllFilesList({
  repoName,
  selected,
  onSelect,
}: {
  repoName: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { data: files } = useWorktreeFiles(repoName, BASE_ID);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = files ?? [];
    return q ? all.filter((p) => p.toLowerCase().includes(q)) : all;
  }, [files, query]);

  const shown = matches.slice(0, ALL_FILES_CAP);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-none border-b border-line px-2 py-1.5">
        <SearchIcon size={12} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-4" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter files…"
          className="w-full rounded-md border border-line-2 bg-input py-1 pr-2 pl-6 text-[11.5px] text-fg-3 outline-none placeholder:text-muted-4 focus:border-line-strong"
        />
      </div>
      {files === undefined ? (
        <ListSkeleton rows={8} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.map((p) => (
            <Row key={p} path={p} selected={selected === p} onSelect={() => onSelect(p)} />
          ))}
          {matches.length > shown.length && (
            <div className="px-2 py-1.5 text-[10.5px] text-muted-4">
              {matches.length - shown.length} more. Narrow the filter to reach them.
            </div>
          )}
          {matches.length === 0 && (
            <div className="px-2 py-1.5 text-[10.5px] text-muted-4">No file matches.</div>
          )}
        </div>
      )}
    </div>
  );
}

function FileView({
  repoName,
  path,
  files,
}: {
  repoName: string;
  path: string;
  files: ChangedFile[];
}) {
  const changed = files.find((f) => f.path === path);
  const untracked = changed?.status === "Untracked";
  // Only fetch a diff for a file that has one; an unchanged file reads as its
  // contents instead.
  const { data: diff } = useWorktreeFileDiff(repoName, BASE_ID, path, untracked, !!changed);
  const { data: source } = useWorktreeFileSource(repoName, BASE_ID, path);

  if (changed?.binary) {
    return <EmptyState title="Binary file" subtitle="There's no text diff to show." />;
  }
  if (changed) {
    if (diff === undefined) {
      return (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      );
    }
    return (
      <div className="h-full overflow-auto">
        <DiffViewer
          path={path}
          diff={diff}
          oldText={source?.oldText ?? ""}
          newText={source?.newText ?? ""}
          mode="unified"
        />
      </div>
    );
  }
  if (source === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto">
      <CodeView path={path} content={source.newText} />
    </div>
  );
}

/** Message + commit, with the same AI drafting the Trees commit box offers. No
 *  auto-push/auto-PR settings here: those are per-repo Trees behavior, and a push
 *  from the Dev tab is an explicit button. */
function CommitBar({ repoName, files }: { repoName: string; files: ChangedFile[] }) {
  const [message, setMessage] = useState("");
  const { mutate: draft, isPending: drafting } = useCommitMessage(repoName);
  const { mutate: commit, isPending: committing } = useCommitWorktree(repoName, BASE_ID);
  const { mutate: push, isPending: pushing } = usePushWorktree(repoName);

  const staged = files.filter((f) => f.staged).length;
  // Nothing staged means "commit everything", which is how the base entry is
  // usually used — the button says which it's about to do.
  const stageAll = staged === 0;
  const committable = stageAll ? files.length : staged;
  const canCommit = committable > 0 && message.trim().length > 0 && !committing;

  return (
    <div className="flex-none border-t border-line bg-panel p-2.5">
      <div className="relative">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            stageAll ? "Commit message (stages all)" : `Commit message (${staged} staged)`
          }
          rows={3}
          className="w-full resize-none rounded-lg border border-line-3 bg-input px-2.5 py-2 pr-8 font-mono text-[11.5px] text-fg-3 outline-none placeholder:text-muted-4 focus:border-line-strong"
        />
        <button
          type="button"
          onClick={() => draft(BASE_ID, { onSuccess: setMessage })}
          disabled={drafting || committable === 0}
          title="Draft a message with AI"
          className="absolute top-2 right-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-2 hover:bg-hover hover:text-accent disabled:opacity-40"
        >
          {drafting ? <Spinner size={12} /> : <ClaudeSparkIcon size={12} />}
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          variant="primary"
          className="flex-1"
          disabled={!canCommit}
          onClick={() =>
            commit({ message: message.trim(), stageAll }, { onSuccess: () => setMessage("") })
          }
        >
          {committing ? "Committing…" : `Commit ${committable || ""}`.trim()}
        </Button>
        <Button variant="outline" disabled={pushing} onClick={() => push(BASE_ID)}>
          {pushing ? "Pushing…" : "Push"}
        </Button>
      </div>
    </div>
  );
}
