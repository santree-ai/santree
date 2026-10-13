/** The per-repo Ticket tracker section: which connection — a Linear org, a Jira
 *  site or the TickTick account — supplies this repo's tickets; for Jira (which
 *  has no triage state of its own), the query that fills its triage queue; and
 *  for TickTick, which of the account's lists the repo reads.
 *
 *  A repo reads from exactly one connection, and several repos may share one.
 *  Picking a different one moves the repo; there is no default to fall back to, so
 *  a repo linked to none has no tickets. */

import { type ReactNode, useId, useMemo, useState } from "react";

import type { TicketProvider } from "../../../bindings";
import { Button, ChevronSelect } from "../../../components/primitives";
import {
  DEFAULT_JIRA_TRIAGE_JQL,
  JIRA_TRIAGE_JQL_KEY,
  TICKTICK_LISTS_KEY,
  useConnections,
  useJiraConnect,
  useLinearConnect,
  useRepos,
  useSetRepoConnection,
  useSetSetting,
  useSetting,
  useTickTickConnect,
  useTickTickLists,
  useTickTickStatus,
} from "../../../lib/queries";
import { TICKTICK_CONNECTION } from "../../../lib/tracker";
import { JIRA_BRAND, LINEAR_BRAND, TICKTICK_BRAND } from "../../../theme/colors";
import { Heading, SELECT_CLASS } from "../widgets";
import { jiraBadge } from "./Jira";
import { linearBadge } from "./Linear";
import { TickTickTokenForm, ticktickBadge } from "./TickTick";

export function RepoTrackerSection({ repo }: { repo: string }) {
  const connections = useConnections();
  const { data: repos } = useRepos();
  const current = repos?.find((r) => r.name === repo);
  const setConnection = useSetRepoConnection();
  const linearConnect = useLinearConnect();
  const jiraConnect = useJiraConnect();
  const ticktickConnect = useTickTickConnect();
  const { data: ticktick } = useTickTickStatus();
  const labelId = useId();

  // A provider with nothing connected can be connected from here: the picker
  // only lists what exists.
  const missing: TicketProvider[] = (["Linear", "Jira", "TickTick"] as const).filter(
    (p) => !connections.some((c) => c.provider === p),
  );

  return (
    <>
      <Heading
        title={`Ticket tracker · ${repo}`}
        subtitle="Choose where this repo's tickets come from. A repo reads from one tracker at a time, and several repos can share one."
      />
      {connections.length > 0 && (
        <PickerCard
          labelId={labelId}
          title="Connection"
          hint={
            current?.connection ? (
              <>
                Tickets for <span className="font-mono text-fg-3">{repo}</span> come from this
                connection.
              </>
            ) : (
              <>
                <span className="font-mono text-fg-3">{repo}</span> isn't linked to a tracker, so it
                has no tickets. Choose one.
              </>
            )
          }
        >
          <ChevronSelect
            value={current?.connection ?? ""}
            onChange={(connection) =>
              setConnection.mutate({ repo, connection: connection || null })
            }
            className={SELECT_CLASS}
            wrapperClassName="flex-1"
            aria-labelledby={labelId}
          >
            <option value="" className="bg-input">
              No tracker
            </option>
            {connections.map((c) => (
              <option key={c.id} value={c.id} className="bg-input">
                {c.label}
              </option>
            ))}
          </ChevronSelect>
        </PickerCard>
      )}
      {current?.provider === "Jira" && <TriageQueryCard repo={repo} />}
      {current?.connection === TICKTICK_CONNECTION && <TickTickListsCard repo={repo} />}
      {missing.map((provider) => (
        <div key={provider} className="mt-3">
          {provider === "Linear" ? (
            <ConnectCard
              badge={linearBadge}
              name="Linear"
              brand={LINEAR_BRAND}
              pending={linearConnect.isPending}
              onConnect={() => linearConnect.mutate()}
            />
          ) : provider === "Jira" ? (
            <ConnectCard
              badge={jiraBadge}
              name="Jira"
              brand={JIRA_BRAND}
              pending={jiraConnect.isPending}
              onConnect={() => jiraConnect.mutate()}
            />
          ) : (
            <ConnectCard
              badge={ticktickBadge}
              name="TickTick"
              brand={TICKTICK_BRAND}
              pending={ticktickConnect.isPending}
              // Sign-in only where this build carries TickTick's OAuth app; the
              // token works on every build.
              onConnect={ticktick?.oauthAvailable ? () => ticktickConnect.mutate() : undefined}
              connectLabel="Sign in"
              footer={
                <>
                  <span className="min-w-0 text-[11.5px] text-muted-3">
                    {ticktick?.oauthAvailable ? "Or use" : "Use"} a personal API token: TickTick →
                    Settings → Account → API Token.
                  </span>
                  <TickTickTokenForm />
                </>
              }
            />
          )}
        </div>
      ))}
    </>
  );
}

/** Jira has no triage state, so a Jira repo's triage queue is a JQL query of its
 *  own. Saved when the field loses focus (or on ⌘⏎); empty means the default. */
function TriageQueryCard({ repo }: { repo: string }) {
  const scope = `repo:${repo}`;
  const { data: stored } = useSetting(scope, JIRA_TRIAGE_JQL_KEY);
  const { mutate: setSetting } = useSetSetting();
  const labelId = useId();
  // `null` while untouched, so a query saved elsewhere shows through rather than
  // an edit nobody made.
  const [draft, setDraft] = useState<string | null>(null);

  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next !== (stored ?? "")) {
      setSetting({ scope, key: JIRA_TRIAGE_JQL_KEY, value: next === "" ? null : next });
    }
    setDraft(null);
  };

  return (
    <div className="mt-3 rounded-xl border border-line-2 bg-raised p-4">
      <div id={labelId} className="mb-[3px] text-[12.5px] font-medium text-fg-3">
        Triage query
      </div>
      <div className="mb-3 text-[11.5px] text-muted-3">
        The JQL that fills the Triage section while this repo is the one Triage reads. Left empty,
        it is your assigned issues that haven't started. Mine and All still apply: Mine shows the
        matches assigned to you.
      </div>
      <textarea
        value={draft ?? stored ?? ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            setDraft(null);
          }
        }}
        placeholder={DEFAULT_JIRA_TRIAGE_JQL}
        rows={3}
        spellCheck={false}
        aria-labelledby={labelId}
        className="w-full resize-y rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3 placeholder:text-muted-4"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10.5px] text-muted-4">
          Saved when you leave the field (<span className="font-mono">⌘⏎</span>).
        </span>
        <Button
          disabled={!stored}
          onClick={() => {
            setDraft(null);
            setSetting({ scope, key: JIRA_TRIAGE_JQL_KEY, value: null });
          }}
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
}

/** Which of the TickTick account's lists this repo reads. Stored as the ids
 *  checked; none checked is every open list (the backend's reading of an unset
 *  or empty `ticktick_lists`), which is what the "All lists" row says. Closed
 *  lists are left out: the backend never reads them. */
function TickTickListsCard({ repo }: { repo: string }) {
  const scope = `repo:${repo}`;
  const { data: lists, isLoading } = useTickTickLists();
  const { data: stored } = useSetting(scope, TICKTICK_LISTS_KEY);
  const { mutate: setSetting } = useSetSetting();
  const labelId = useId();

  const open = useMemo(() => (lists ?? []).filter((l) => !l.closed), [lists]);
  const selected = useMemo(() => parseListIds(stored), [stored]);
  const all = selected.length === 0;

  const write = (ids: string[]) =>
    setSetting({ scope, key: TICKTICK_LISTS_KEY, value: ids.length ? JSON.stringify(ids) : null });

  const toggle = (id: string) => {
    // A list since closed or deleted can't be unchecked from here, so it is
    // dropped on the next change rather than kept forever.
    const known = selected.filter((s) => open.some((l) => l.id === s));
    write(known.includes(id) ? known.filter((s) => s !== id) : [...known, id]);
  };

  return (
    <div className="mt-3 rounded-xl border border-line-2 bg-raised p-4">
      <div id={labelId} className="mb-[3px] text-[12.5px] font-medium text-fg-3">
        Lists
      </div>
      <div className="mb-3 text-[11.5px] text-muted-3">
        The TickTick lists this repo's tickets come from. With none picked, it reads every open
        list.
      </div>
      {isLoading ? (
        <div className="text-[11.5px] text-muted-4">Loading lists…</div>
      ) : open.length === 0 ? (
        <div className="text-[11.5px] text-muted-4">TickTick returned no open lists.</div>
      ) : (
        <fieldset aria-labelledby={labelId} className="flex flex-col gap-0.5">
          <ListCheck checked={all} onChange={() => !all && write([])} label="All lists" />
          {open.map((list) => (
            <ListCheck
              key={list.id}
              checked={selected.includes(list.id)}
              onChange={() => toggle(list.id)}
              label={list.name}
              color={list.color}
            />
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** The stored `ticktick_lists`, or none for anything unset or unreadable — the
 *  same fallback the backend takes, so a bad value reads as every list there
 *  and here alike. */
const parseListIds = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

function ListCheck({
  checked,
  onChange,
  label,
  color,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  /** The list's own colour in TickTick, when it has one — data, not a theme. */
  color?: string | null;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-[12px] text-fg-3 hover:bg-hover">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
      />
      {color !== undefined && (
        <span
          className="h-2 w-2 flex-none rounded-full border border-line-3"
          style={color ? { background: color, borderColor: color } : undefined}
        />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );
}

function PickerCard({
  labelId,
  title,
  hint,
  children,
}: {
  labelId: string;
  title: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line-2 bg-raised p-4">
      <div id={labelId} className="mb-[3px] text-[12.5px] font-medium text-fg-3">
        {title}
      </div>
      <div className="mb-3 text-[11.5px] text-muted-3">{hint}</div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function ConnectCard({
  badge,
  name,
  brand,
  pending,
  onConnect,
  connectLabel = "Connect",
  footer,
}: {
  badge: ReactNode;
  name: string;
  brand: string;
  pending: boolean;
  /** Absent when this build can't connect the tracker by button. */
  onConnect?: () => void;
  connectLabel?: string;
  /** Another way to connect, under the card's row. */
  footer?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line-2 bg-raised p-4">
      <div className="flex items-center gap-[13px]">
        {badge}
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-fg-3">{name} isn't connected</div>
          <div className="mt-[3px] text-[11.5px] text-muted-3">
            Connect it to pull assigned issues into your projects.
          </div>
        </div>
        {/* Brand-colored primary, as the Integrations cards do: the one deliberate
            exception to the accent fill (a "connect to this tracker" cue). */}
        {onConnect && (
          <Button
            variant="primary"
            onClick={onConnect}
            disabled={pending}
            style={{ background: brand, color: "#ffffff" }}
          >
            {pending ? "Connecting…" : connectLabel}
          </Button>
        )}
      </div>
      {footer && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
          {footer}
        </div>
      )}
    </div>
  );
}
