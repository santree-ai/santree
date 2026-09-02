/** The History pane: every agent session that has run in this worktree, newest
 *  first — what it was asked, what it last said, who ran it and how long ago.
 *
 *  A row expands in place. The summary is what the list is scanned by; the
 *  expansion is where the session is *acted on* — resumed (or opened, when it is
 *  still running), copied as a resume line, its transcript revealed — and where
 *  the things too heavy for a list scan are read: the full first prompt, the tail
 *  of the conversation, the spawn tree of its subagents, what it cost. Those two
 *  reads are lazy and per-row, so a collapsed row costs nothing.
 *
 *  Several rows open at once, on purpose: comparing two sessions side by side is
 *  the reason to open one at all.
 *
 *  Both rails host it — sessions run on a branch, and a reviewer with the PR
 *  checked out has as much reason to read them as its author. Which worktree it
 *  is about comes in as props; resuming one, which needs a tab strip to put the
 *  new tab in, comes in as {@link SessionHistory.onResume}. */
import { type ReactNode, useCallback, useId, useState } from "react";

import type { SessionSubagent, WorktreeSession } from "../../bindings";
import {
  AgentIcon,
  AgentsIcon,
  BoltIcon,
  BranchIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  ListIcon,
  MessageSquareIcon,
  RefreshIcon,
} from "../../components/icons";
import { Badge, Button, Dot, EmptyState, ListSkeleton } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { formatCompact, formatCostPrecise } from "../../lib/format";
import {
  useRevealSessionTranscript,
  useWorktreeSessionDetail,
  useWorktreeSessionSubagents,
  useWorktreeSessions,
} from "../../lib/queries";
import { toast } from "../../state/toast";
import {
  agentBrandColor,
  agentLabel,
  modelMeta,
  sessionStateMeta,
  subagentStatusMeta,
} from "../../theme/colors";
import type { AgentEntry } from "../agents/registry";
import { useAgentEntries } from "../agents/useAgents";
import { useOpenAgent } from "../agents/useOpenAgent";
import { resumeInvocation } from "../terminal/agentSeed";
import {
  buildSubagentTree,
  compactPath,
  countSubagentNodes,
  type SubagentNode,
} from "./sessionDetail";

/** A model id as a badge: the vendor prefix says nothing next to the agent icon. */
function modelLabel(model: string): string {
  return model.replace(/^claude-/, "");
}

/** Why a row can't be resumed, or null when it can. `messageCount` is counted
 *  from the session's own record on disk, so zero is equally "it never got a
 *  turn" and "the transcript has since been pruned" — one honest sentence covers
 *  both, and it is the same predicate the backend refuses on. */
function resumeBlocker(s: WorktreeSession): string | null {
  return s.messageCount > 0 ? null : "Nothing to resume: this session recorded no conversation.";
}

export function SessionHistory({
  repo,
  worktreeId,
  branch,
  onResume,
  resumingId = null,
}: {
  repo: string;
  worktreeId: string;
  /** The branch these sessions ran on, for the expansion's "Where it ran". */
  branch: string | null;
  /** Run one of them again in a fresh agent tab. Optional: the tab lands in the
   *  worktree's main-area strip, which only Trees has — the Reviews rail leaves
   *  it out rather than offering a button with nowhere to open. Everything else
   *  in the expansion (open a live session, copy the resume line, reveal the
   *  transcript) works in both. */
  onResume?: (session: WorktreeSession) => void;
  /** The session a resume is in flight for, so its button reads busy. Owned by
   *  whoever owns {@link SessionHistory.onResume}. */
  resumingId?: string | null;
}) {
  const { data: sessions, refetch, isFetching } = useWorktreeSessions(repo, worktreeId);
  const entries = useAgentEntries([repo], [repo]);
  const openAgent = useOpenAgent();
  // Every open row, not one: two sessions are compared side by side, which a
  // single `expandedId` makes impossible.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((sessionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
  }, []);
  // Keyed by the provider's session id, so only agents that have announced one
  // can match a history row — the history *is* the list of durable sessions.
  const liveById = new Map(
    (entries ?? []).flatMap((e) => (e.sessionId ? [[e.sessionId, e] as const] : [])),
  );

  return (
    <>
      <div className="flex flex-none items-start justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-fg">Session history</div>
          {/* No count until the read lands: "0 sessions" beside a skeleton is a claim. */}
          <div className="text-[11px] text-muted-4">
            {sessions === undefined
              ? "\u00a0"
              : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          aria-busy={isFetching}
          aria-label="Refresh session history"
          title="Refresh"
          className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
        >
          <RefreshIcon size={12} className={isFetching ? "animate-spin" : ""} />
        </button>
      </div>
      {sessions === undefined ? (
        <ListSkeleton rows={4} className="p-2" />
      ) : sessions.length === 0 ? (
        <EmptyState
          title="No sessions yet"
          subtitle="Every agent that runs in this worktree shows up here."
        />
      ) : (
        <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {sessions.map((s) => (
            <SessionRow
              key={s.sessionId}
              repo={repo}
              worktreeId={worktreeId}
              branch={branch}
              session={s}
              live={liveById.get(s.sessionId)}
              openAgent={openAgent}
              onResume={onResume}
              resumingId={resumingId}
              expanded={expanded.has(s.sessionId)}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SessionRow({
  repo,
  worktreeId,
  branch,
  session: s,
  live,
  openAgent,
  onResume,
  resumingId,
  expanded,
  onToggle,
}: {
  repo: string;
  worktreeId: string;
  branch: string | null;
  session: WorktreeSession;
  live: AgentEntry | undefined;
  openAgent: (entry: AgentEntry) => void;
  onResume?: (session: WorktreeSession) => void;
  resumingId: string | null;
  expanded: boolean;
  onToggle: (sessionId: string) => void;
}) {
  const detailsId = useId();
  const title = s.title ?? "Untitled session";
  const provider = agentLabel(s.agentKind);
  const cost = formatCostPrecise(s.spend?.costUsd);

  return (
    <div className="selection-row" data-active={expanded ? "true" : undefined}>
      <div className="flex items-start gap-1 pr-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${provider} session: ${title}. ${expanded ? "Hide" : "Show"} details`}
          onClick={() => onToggle(s.sessionId)}
          className="flex min-h-[72px] min-w-0 flex-1 cursor-pointer flex-col gap-1 py-3 pl-3 text-left"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg-2">
              {title}
            </span>
            {live?.state && (
              <span
                className="flex-none rounded-full"
                style={{
                  width: 6,
                  height: 6,
                  background: sessionStateMeta[live.state]?.color,
                }}
                title={sessionStateMeta[live.state]?.label}
              />
            )}
          </span>
          {s.lastMessage && (
            <span className="line-clamp-2 text-[11px] leading-[1.4] text-muted-3">
              {/* Who said it, because the latest line can be your own unanswered
                  prompt — the one case where the session is waiting on nobody. */}
              {s.lastMessageFrom && (
                <span className="font-medium text-fg-2">
                  {s.lastMessageFrom === "You" ? "You" : "Agent"}:{" "}
                </span>
              )}
              {s.lastMessage}
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-4">
            <span className="flex flex-none" style={{ color: agentBrandColor(s.agentKind) }}>
              <AgentIcon kind={s.agentKind} size={11} />
            </span>
            {s.spend && (s.spend.totalTokens ?? 0) > 0 && (
              <span className="tabular-nums">{formatCompact(s.spend.totalTokens)} ·</span>
            )}
            {/* No cost at all rather than "$0.00": the backend sends null when it
                has no price for the model, and a zero would read as free. */}
            {cost && <span className="tabular-nums">{cost} ·</span>}
            <span className="tabular-nums">{s.messageCount} msgs</span>
            {s.subagentCount > 0 && (
              <span className="tabular-nums">
                · {s.subagentCount} subagent{s.subagentCount === 1 ? "" : "s"}
              </span>
            )}
            <span>·</span>
            <RelativeTime ms={s.lastActivityMs} />
            {s.model && (
              <span className="ml-auto min-w-0 truncate" title={s.model}>
                {modelLabel(s.model)}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${provider} session: ${title}`}
          title={expanded ? "Collapse" : "Expand"}
          onClick={() => onToggle(s.sessionId)}
          className="mt-3 flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
        >
          <ChevronDownIcon
            size={12}
            className={`transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {expanded && (
        <SessionDetails
          id={detailsId}
          repo={repo}
          worktreeId={worktreeId}
          branch={branch}
          session={s}
          live={live}
          openAgent={openAgent}
          onResume={onResume}
          resumingId={resumingId}
        />
      )}
    </div>
  );
}

/** Section chrome — one header vocabulary for every block in the expansion, so
 *  the classes live in one place rather than being retyped six times. */
function Section({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.05em] text-muted-4">
        <span className="flex flex-none">{icon}</span>
        <span className="font-medium">{title}</span>
        {action && <span className="ml-auto flex items-center">{action}</span>}
      </div>
      {children}
    </div>
  );
}

/** A small header-level copy button — the affordance repeats, the toast doesn't. */
function CopyButton({ text, label, what }: { text: string; label: string; what: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        toast.success(`${what} copied.`);
      }}
      className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
    >
      <CopyIcon size={11} />
    </button>
  );
}

function SessionDetails({
  id,
  repo,
  worktreeId,
  branch,
  session: s,
  live,
  openAgent,
  onResume,
  resumingId,
}: {
  id: string;
  repo: string;
  worktreeId: string;
  branch: string | null;
  session: WorktreeSession;
  live: AgentEntry | undefined;
  openAgent: (entry: AgentEntry) => void;
  onResume?: (session: WorktreeSession) => void;
  resumingId: string | null;
}) {
  const detail = useWorktreeSessionDetail(repo, worktreeId, s.sessionId, true);
  // A session with no subagents reads nothing from disk at all.
  const subagents = useWorktreeSessionSubagents(repo, worktreeId, s.sessionId, s.subagentCount > 0);
  const reveal = useRevealSessionTranscript(repo, worktreeId);

  const openable = !!live?.openable;
  const blocked = openable
    ? null
    : // A PTY is open on this conversation right now; a second `--resume` would
      // put two terminals on one session.
      live?.live
      ? "This session is already running in a terminal."
      : resumeBlocker(s);
  const busy = resumingId === s.sessionId;
  // The list already carries the trimmed first line; the lazy read replaces it
  // with the whole prompt when it lands, so nothing flashes empty on the way.
  const promptBody = detail.data?.firstPrompt ?? s.title ?? null;
  const turns = detail.data?.recentTurns ?? [];
  const cwd = detail.data?.cwd ?? null;
  // The same invocation the tab's own launch runs, wrapped for someone else's
  // terminal: a PTY session is spawned in its directory, a pasted line has to
  // `cd` there first — and it matters, since Claude looks a conversation up
  // under the directory it ran in.
  const command = resumeInvocation(s.agentKind, s.sessionId, cwd);

  return (
    // A containment boundary, not an interaction: every handler here only
    // *stops* an event, so pressing, double-clicking or selecting text inside
    // the details is an interaction with the details and can never be read as
    // one with the row that toggles them. `onDragStart` is the one with a
    // visible effect today — without it, dragging across the prompt to select
    // it starts an HTML5 drag and drops the selection on the first pixel of
    // movement, which is exactly what makes the text feel unselectable.
    // biome-ignore lint/a11y/noStaticElementInteractions: adds no interaction — the handlers only stop events; every action inside is its own button.
    // biome-ignore lint/a11y/useKeyWithClickEvents: nothing is triggered by the click, so there is no keyboard equivalent to provide.
    <div
      id={id}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      className="flex flex-col gap-3.5 border-t border-line bg-well px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {openable && live ? (
          <Button variant="primary" size="sm" onClick={() => openAgent(live)}>
            Open session
          </Button>
        ) : (
          onResume && (
            <Button
              variant="primary"
              size="sm"
              // Focusable rather than `disabled`, so the reason stays reachable:
              // a disabled button takes neither the keyboard nor a hover tooltip.
              aria-disabled={blocked !== null}
              aria-busy={busy}
              title={blocked ?? "Resume this session in a new agent tab"}
              onClick={() => {
                if (!blocked && !resumingId) onResume(s);
              }}
              className="aria-disabled:cursor-default aria-disabled:opacity-50"
            >
              {busy ? "Resuming…" : "Resume"}
            </Button>
          )
        )}
        {command && (
          <Button
            variant="outline"
            size="sm"
            title={command}
            onClick={() => {
              void navigator.clipboard.writeText(command);
              toast.success("Resume command copied.");
            }}
          >
            <CopyIcon size={11} /> Copy resume command
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          title="Reveal this session's transcript in the file browser"
          onClick={() => reveal.mutate(s.sessionId)}
        >
          <ExternalLinkIcon size={11} /> Open transcript
        </Button>
      </div>
      {/* Only where the button it explains is on offer — a reason you can't press
          something that isn't there reads as a missing control. */}
      {blocked && !openable && onResume && <p className="text-[11px] text-muted-3">{blocked}</p>}

      {s.messageCount === 0 ? (
        <div className="rounded border border-dashed border-line-2 px-2.5 py-2 text-[11px] leading-[1.5] text-muted-3">
          <span className="font-medium text-fg-3">Conversation not saved.</span> Nothing of this
          session's messages survives on disk
          {s.subagentCount > 0
            ? `, but ${s.subagentCount} subagent transcript${
                s.subagentCount === 1 ? "" : "s"
              } remain — listed below.`
            : "."}
        </div>
      ) : (
        <>
          <Section
            icon={<MessageSquareIcon size={11} />}
            title="First prompt"
            action={
              promptBody && (
                <CopyButton text={promptBody} label="Copy the first prompt" what="First prompt" />
              )
            }
          >
            {promptBody ? (
              <p className="max-h-48 selectable overflow-y-auto whitespace-pre-wrap break-words rounded bg-input px-2.5 py-2 text-[11.5px] leading-[1.55] text-fg-3">
                {promptBody}
                {detail.data?.firstPromptTruncated && (
                  <span className="text-muted-4"> … (truncated)</span>
                )}
              </p>
            ) : (
              <p className="text-[11px] text-muted-4">No prompt recorded.</p>
            )}
          </Section>

          {turns.length > 0 && (
            <Section icon={<ListIcon size={11} />} title="Latest turns">
              <div className="flex flex-col gap-1.5">
                {turns.map((turn, i) => (
                  <div
                    key={`${turn.from}-${i}`}
                    className="rounded border-l-2 py-0.5 pl-2"
                    style={{
                      borderColor:
                        turn.from === "You" ? "var(--accent)" : "var(--color-line-strong)",
                    }}
                  >
                    <div className="text-[10px] uppercase tracking-[0.05em] text-muted-4">
                      {turn.from === "You" ? "You" : "Agent"}
                    </div>
                    <div className="line-clamp-3 selectable text-[11.5px] leading-[1.5] text-fg-3">
                      {turn.text}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {s.subagentCount > 0 && <SubagentSection count={s.subagentCount} rows={subagents.data} />}

      {s.spend && s.spend.models.length > 0 && (
        <Section icon={<BoltIcon size={11} />} title="Usage">
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5 font-mono text-[11.5px] text-fg-3">
              <span className="tabular-nums">{formatCompact(s.spend.totalTokens)}</span>
              <span className="text-muted-4">tokens</span>
              {formatCostPrecise(s.spend.costUsd) && (
                <span className="ml-auto tabular-nums">{formatCostPrecise(s.spend.costUsd)}</span>
              )}
            </div>
            {s.spend.models.map((m) => (
              <ModelSpendRow
                key={m.model}
                model={m.model}
                tokens={m.totalTokens}
                cost={m.costUsd}
              />
            ))}
          </div>
        </Section>
      )}

      <Section icon={<BranchIcon size={11} />} title="Where it ran">
        <div className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-3">
          {cwd && (
            <span className="truncate" title={cwd}>
              {compactPath(cwd)}
            </span>
          )}
          {branch && (
            <span className="truncate" title={branch}>
              {branch}
            </span>
          )}
          {!cwd && !branch && <span className="text-muted-4">Not recorded.</span>}
        </div>
      </Section>
    </div>
  );
}

function ModelSpendRow({
  model,
  tokens,
  cost,
}: {
  model: string;
  tokens: number | null;
  cost: number | null;
}) {
  const meta = modelMeta(model);
  const label = formatCostPrecise(cost);
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-3">
      <Dot color={meta.color} size={6} />
      <span className="min-w-0 truncate" title={model}>
        {meta.label}
      </span>
      <span className="ml-auto tabular-nums">{formatCompact(tokens)}</span>
      {/* An unpriced model gets no column at all — see `formatCostPrecise`. */}
      <span className="w-16 text-right tabular-nums">{label ?? "—"}</span>
    </div>
  );
}

/** The session's Task subagents as the spawn tree their sidecars describe.
 *
 *  The heading counts the rows actually rendered once they load, not the badge's
 *  number, so the heading can never claim a subagent the tree doesn't show. The
 *  two are the same file listing on the backend, which is what makes them agree
 *  — this is where that would become visible if it ever stopped being true. */
function SubagentSection({ count, rows }: { count: number; rows: SessionSubagent[] | undefined }) {
  const tree = rows ? buildSubagentTree(rows) : null;
  return (
    <Section
      icon={<AgentsIcon size={11} />}
      title={`Subagents (${tree ? countSubagentNodes(tree) : count})`}
    >
      {tree === null ? (
        <ListSkeleton rows={2} />
      ) : tree.length === 0 ? (
        <p className="text-[11px] text-muted-4">No subagent transcripts on disk.</p>
      ) : (
        <div className="flex flex-col gap-px">
          {tree.map((node) => (
            <SubagentRows key={node.agent.agentId} node={node} level={0} />
          ))}
        </div>
      )}
    </Section>
  );
}

/** One subagent and everything it spawned. View-only: a subagent shares its
 *  parent's session id, so there is nothing here to resume. */
function SubagentRows({ node, level }: { node: SubagentNode; level: number }) {
  const { agent } = node;
  return (
    <>
      <SubagentRow agent={agent} level={level} />
      {node.children.map((child) => (
        <SubagentRows key={child.agent.agentId} node={child} level={level + 1} />
      ))}
    </>
  );
}

function SubagentRow({ agent, level }: { agent: SessionSubagent; level: number }) {
  const status = subagentStatusMeta[agent.status];
  const title = agent.description ?? agent.agentType ?? agent.agentId;
  return (
    <div
      className="flex items-center gap-1.5 py-0.5 text-[11px]"
      style={{ paddingLeft: level * 12 }}
    >
      {/* An unrecorded outcome shows no dot — a dot would assert one. The slot
          is still reserved, so the titles line up down the tree. */}
      <span className="flex h-[7px] w-[7px] flex-none items-center justify-center">
        {status.color && <Dot color={status.color} size={7} glow={status.glow} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-3" title={`${title} — ${status.label}`}>
        {title}
      </span>
      {agent.agentType && <Badge>{agent.agentType}</Badge>}
      <span className="flex-none font-mono text-[10px] tabular-nums text-muted-4">
        {agent.messageCount} msgs
      </span>
    </div>
  );
}
