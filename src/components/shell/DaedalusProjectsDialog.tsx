/**
 * "Add from Daedalus" — the checkouts on the user's home server, each addable
 * as a santree project (docs/remote.md).
 *
 * Not reaching Daedalus is a state this dialog shows, not an error: the list
 * read answers with a reach, and anything but reachable renders its hint and a
 * way to Settings → Daedalus. Rows already seen while reachable stay listed but
 * disabled, so a dropped connection mid-browse reads as "can't add right now"
 * rather than as the projects vanishing.
 *
 * Chrome matches {@link ProjectPickerDialog}: the same portal, scrim and card.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DaedalusReach, DaedalusWorkspace } from "../../bindings";
import { useAddDaedalusRepo, useDaedalusWorkspaces } from "../../lib/queries";
import { toast } from "../../state/toast";
import { BranchIcon, DaedalusLogo, RefreshIcon } from "../icons";
import { Badge, Button, ListSkeleton, useModalA11y } from "../primitives";

const TITLE_ID = "daedalus-projects-title";

export function DaedalusProjectsDialog({ onClose }: { onClose: () => void }) {
  const list = useDaedalusWorkspaces();
  const add = useAddDaedalusRepo();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  useModalA11y({ open: true, onClose, dialogRef, initialFocusRef: doneRef });

  const reach = list.data?.reach;
  const reachable = reach?.kind === "ApiReachable";
  // The last list Daedalus answered with, kept while it stops answering.
  const [seen, setSeen] = useState<DaedalusWorkspace[]>([]);
  useEffect(() => {
    if (list.data?.reach.kind === "ApiReachable") setSeen(list.data.workspaces);
  }, [list.data]);
  const rows = reachable ? (list.data?.workspaces ?? []) : seen;

  const openSettings = () => {
    onClose();
    navigate({ to: "/settings", search: { section: "daedalus" } });
  };

  const addOne = (name: string) =>
    add.mutate(name, { onSuccess: (repo) => toast.success(`Added ${repo.name}.`) });

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[3px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-labelledby={TITLE_ID}
        className="relative flex w-[480px] max-w-full flex-col gap-3 rounded-xl border border-line-3 bg-panel p-4 shadow-2xl"
        style={{ animation: "toastIn .16s ease-out" }}
      >
        <div className="flex items-center gap-2">
          <DaedalusLogo size={15} className="flex-none" />
          <h2 id={TITLE_ID} className="flex-1 text-[13px] font-medium text-fg">
            Add from Daedalus
          </h2>
          <button
            type="button"
            onClick={() => void list.refetch()}
            disabled={list.isFetching}
            aria-label="Refresh the Daedalus project list"
            title="Refresh"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2 disabled:cursor-default"
          >
            <RefreshIcon size={12} className={list.isFetching ? "animate-spin" : ""} />
          </button>
        </div>

        <p className="text-[12px] leading-[1.55] text-muted-2">
          The projects Daedalus keeps. Their shells, agents and git run on Daedalus.
        </p>

        {reach && !reachable && <ReachNotice reach={reach} onOpenSettings={openSettings} />}

        <div className="flex max-h-80 flex-col overflow-y-auto rounded-lg border border-hairline bg-raised">
          {list.data === undefined ? (
            <ListSkeleton rows={3} className="p-2" />
          ) : rows.length === 0 ? (
            reachable && (
              <div className="px-3 py-3 text-[11.5px] text-muted-3">
                Daedalus has no projects under its projects root.
              </div>
            )
          ) : (
            <ul aria-label="Daedalus projects">
              {rows.map((w) => (
                <WorkspaceRow
                  key={w.path}
                  workspace={w}
                  disabled={!reachable || (add.isPending && add.variables === w.name)}
                  onAdd={() => addOne(w.name)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-0.5">
          <Button ref={doneRef} size="sm" variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Why the list is empty (or stale), and where to fix it. */
function ReachNotice({
  reach,
  onOpenSettings,
}: {
  reach: DaedalusReach;
  onOpenSettings: () => void;
}) {
  const [lead, detail] =
    reach.kind === "NotConfigured"
      ? ["Daedalus isn't set up yet.", "Add its URL and API token in Settings."]
      : reach.kind === "Unauthorized"
        ? ["Daedalus refused the token.", "Paste a new one in Settings."]
        : reach.kind === "ApiUnreachable"
          ? ["Can't reach Daedalus.", `Connect to your home network or VPN. ${reach.reason}`]
          : ["", ""];
  return (
    <div className="flex items-start gap-2 rounded-lg border border-hairline bg-raised px-3 py-2.5 text-[11.5px]">
      <DaedalusLogo size={14} className="mt-px flex-none" />
      <div className="min-w-0 flex-1 text-muted-3">
        <span className="font-medium text-fg-3">{lead}</span> {detail}
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="flex-none cursor-pointer text-[11.5px] underline-offset-2 hover:underline"
        style={{ color: "var(--accent-text)" }}
      >
        Settings → Daedalus
      </button>
    </div>
  );
}

function WorkspaceRow({
  workspace: w,
  disabled,
  onAdd,
}: {
  workspace: DaedalusWorkspace;
  disabled: boolean;
  onAdd: () => void;
}) {
  return (
    <li className="flex items-center gap-2.5 border-t border-hairline px-3 py-2 first:border-t-0">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-fg-2">{w.name}</span>
        <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-4">
          {w.branch && (
            <span className="flex min-w-0 items-center gap-1">
              <BranchIcon size={10} className="flex-none" />
              <span className="truncate">{w.branch}</span>
            </span>
          )}
          {w.dirty && <span className="text-status-amber">modified</span>}
          {w.ahead > 0 && (
            <span>
              <span aria-hidden>↑</span>
              {w.ahead}
              <span className="sr-only"> ahead</span>
            </span>
          )}
          {w.behind > 0 && (
            <span>
              <span aria-hidden>↓</span>
              {w.behind}
              <span className="sr-only"> behind</span>
            </span>
          )}
        </span>
      </span>
      {w.registered ? (
        <Badge color="var(--color-muted-2)">added</Badge>
      ) : (
        <Button size="sm" onClick={onAdd} disabled={disabled} aria-label={`Add ${w.name}`}>
          Add
        </Button>
      )}
    </li>
  );
}
