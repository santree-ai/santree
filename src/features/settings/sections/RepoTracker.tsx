/** The per-repo Ticket tracker section: which connection — a Linear org or a Jira
 *  site — supplies this repo's tickets, and, for Jira (which has no triage state
 *  of its own), the query that fills its triage queue.
 *
 *  A repo reads from exactly one connection, and several repos may share one.
 *  Picking a different one moves the repo; there is no default to fall back to, so
 *  a repo linked to none has no tickets. */

import { type ReactNode, useId, useState } from "react";

import type { TicketProvider } from "../../../bindings";
import { Button, ChevronSelect } from "../../../components/primitives";
import {
  DEFAULT_JIRA_TRIAGE_JQL,
  JIRA_TRIAGE_JQL_KEY,
  useConnections,
  useJiraConnect,
  useLinearConnect,
  useRepos,
  useSetRepoConnection,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { JIRA_BRAND, LINEAR_BRAND } from "../../../theme/colors";
import { Heading, SELECT_CLASS } from "../widgets";
import { jiraBadge } from "./Jira";
import { linearBadge } from "./Linear";

export function RepoTrackerSection({ repo }: { repo: string }) {
  const connections = useConnections();
  const { data: repos } = useRepos();
  const current = repos?.find((r) => r.name === repo);
  const setConnection = useSetRepoConnection();
  const linearConnect = useLinearConnect();
  const jiraConnect = useJiraConnect();
  const labelId = useId();

  // A provider with nothing connected can be connected from here: the picker
  // only lists what exists.
  const missing: TicketProvider[] = (["Linear", "Jira"] as const).filter(
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
          ) : (
            <ConnectCard
              badge={jiraBadge}
              name="Jira"
              brand={JIRA_BRAND}
              pending={jiraConnect.isPending}
              onConnect={() => jiraConnect.mutate()}
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
}: {
  badge: ReactNode;
  name: string;
  brand: string;
  pending: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex items-center gap-[13px] rounded-xl border border-line-2 bg-raised p-4">
      {badge}
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-fg-3">{name} isn't connected</div>
        <div className="mt-[3px] text-[11.5px] text-muted-3">
          Connect it to pull assigned issues into your projects.
        </div>
      </div>
      {/* Brand-colored primary, as the Integrations cards do: the one deliberate
          exception to the accent fill (a "connect to this tracker" cue). */}
      <Button
        variant="primary"
        onClick={onConnect}
        disabled={pending}
        style={{ background: brand, color: "#ffffff" }}
      >
        {pending ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}
