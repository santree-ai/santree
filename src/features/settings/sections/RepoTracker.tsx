/** The per-repo Ticket tracker section: which tracker supplies this repo's
 *  tickets, which of its connected orgs or sites, and — for Jira, which has no
 *  triage state of its own — the query that fills its triage queue.
 *
 *  A repo reads from one tracker. The switch at the top picks which tracker's
 *  options you are looking at; binding an org or a site in them is what moves the
 *  repo — the backend clears the other tracker's link in the same write, so the
 *  two can never both claim it. */

import { type ReactNode, useId, useState } from "react";

import type { TicketProvider } from "../../../bindings";
import { TrackerLogo } from "../../../components/icons";
import { Button, ChevronSelect, Segmented } from "../../../components/primitives";
import {
  DEFAULT_JIRA_TRIAGE_JQL,
  JIRA_TRIAGE_JQL_KEY,
  useJiraConnect,
  useJiraSites,
  useJiraStatus,
  useLinearConnect,
  useLinearOrgs,
  useLinearStatus,
  useSetRepoJiraSite,
  useSetRepoLinearOrg,
  useSetSetting,
  useSetting,
  useTicketProvider,
} from "../../../lib/queries";
import { JIRA_BRAND, LINEAR_BRAND } from "../../../theme/colors";
import { Heading, SELECT_CLASS } from "../widgets";
import { jiraBadge } from "./Jira";
import { linearBadge } from "./Linear";

export function RepoTrackerSection({ repo }: { repo: string }) {
  const active = useTicketProvider(repo);
  // A pick only holds for the repo it was made on: switching the repo being
  // edited lands on that repo's own tracker.
  const [picked, setPicked] = useState<{ repo: string; provider: TicketProvider } | null>(null);
  const shown = picked?.repo === repo ? picked.provider : active;
  const setShown = (provider: TicketProvider) => setPicked({ repo, provider });

  return (
    <>
      <Heading
        title={`Ticket tracker · ${repo}`}
        subtitle="Choose where this repo's tickets come from. A repo reads from one tracker at a time."
      />
      <Segmented<TicketProvider>
        className="mb-3 w-[200px]"
        value={shown}
        onChange={setShown}
        options={[
          { value: "Linear", label: "Linear", icon: <TrackerLogo provider="Linear" size={11} /> },
          { value: "Jira", label: "Jira", icon: <TrackerLogo provider="Jira" size={11} /> },
        ]}
      />
      {shown === "Linear" ? (
        <LinearPicker repo={repo} active={active === "Linear"} />
      ) : (
        <JiraPicker repo={repo} active={active === "Jira"} />
      )}
    </>
  );
}

function LinearPicker({ repo, active }: { repo: string; active: boolean }) {
  const { data: orgs = [] } = useLinearOrgs();
  const { data: status } = useLinearStatus(repo);
  const setOrg = useSetRepoLinearOrg();
  const connect = useLinearConnect();
  const labelId = useId();

  if (orgs.length === 0) {
    return (
      <ConnectCard
        badge={linearBadge}
        name="Linear"
        brand={LINEAR_BRAND}
        pending={connect.isPending}
        onConnect={() => connect.mutate()}
      />
    );
  }
  return (
    <PickerCard
      labelId={labelId}
      title="Linear organization"
      hint={
        active ? (
          <>
            Tickets for <span className="font-mono text-fg-3">{repo}</span> come from this org.
          </>
        ) : (
          "This repo reads from Jira. Choose an org to move it to Linear."
        )
      }
    >
      <ChevronSelect
        value={active ? (status?.orgSlug ?? "") : ""}
        onChange={(slug) => setOrg.mutate({ repo, slug })}
        className={SELECT_CLASS}
        wrapperClassName="flex-1"
        aria-labelledby={labelId}
      >
        {!active && (
          <option value="" disabled className="bg-input">
            Choose an org…
          </option>
        )}
        {orgs.map((org) => (
          <option key={org.slug} value={org.slug} className="bg-input">
            {org.name} ({org.slug})
          </option>
        ))}
      </ChevronSelect>
      {/* Only while Linear is the tracker: clearing the link goes back to the
          default org, which from Jira would be a move rather than a reset. */}
      {active && (
        <Button onClick={() => setOrg.mutate({ repo, slug: null })}>Reset to default</Button>
      )}
    </PickerCard>
  );
}

function JiraPicker({ repo, active }: { repo: string; active: boolean }) {
  const { data: sites = [] } = useJiraSites();
  const { data: status } = useJiraStatus(repo);
  const setSite = useSetRepoJiraSite();
  const connect = useJiraConnect();
  const labelId = useId();

  if (sites.length === 0) {
    return (
      <ConnectCard
        badge={jiraBadge}
        name="Jira"
        brand={JIRA_BRAND}
        pending={connect.isPending}
        onConnect={() => connect.mutate()}
      />
    );
  }
  return (
    <>
      <PickerCard
        labelId={labelId}
        title="Jira site"
        hint={
          active ? (
            <>
              Tickets for <span className="font-mono text-fg-3">{repo}</span> come from this site.
            </>
          ) : (
            "This repo reads from Linear. Choose a site to move it to Jira."
          )
        }
      >
        <ChevronSelect
          value={active ? (status?.cloudId ?? "") : ""}
          onChange={(cloudId) => setSite.mutate({ repo, cloudId })}
          className={SELECT_CLASS}
          wrapperClassName="flex-1"
          aria-labelledby={labelId}
        >
          {!active && (
            <option value="" disabled className="bg-input">
              Choose a site…
            </option>
          )}
          {sites.map((site) => (
            <option key={site.cloudId} value={site.cloudId} className="bg-input">
              {site.siteName}
            </option>
          ))}
        </ChevronSelect>
      </PickerCard>
      {active && <TriageQueryCard repo={repo} />}
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
          Connect it to pull this repo's assigned issues.
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
