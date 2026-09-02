/** Settings → Integrations → GitHub: how santree authenticates GitHub (PRs +
 *  Reviews). Today only the `gh` CLI method is live; the GitHub App (OAuth) and
 *  Personal Access Token methods are shown as work-in-progress.
 *
 *  One card per question, rather than one card holding all of them: signing in,
 *  what the session has left to spend, and the two preferences about how the
 *  sidebar's Reviews section is drawn are four separate decisions, and stacking
 *  them behind one border made the page read as a single long form. */

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  CliIcon,
  GlobeIcon,
  KeyIcon,
  PlayIcon,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { Badge, Button, ChevronSelect, Tabs } from "../../../components/primitives";
import {
  GITHUB_GROUP_BY_KEY,
  isOptedIn,
  type LinearGroupBy,
  parseGithubGroupBy,
  queryKeys,
  REVIEWS_SHOW_EMPTY_KEY,
  useGithubApiBudget,
  useGithubStatus,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { ApiBudgetMeters } from "../ApiBudget";
import { BinaryPathField } from "../BinaryPathField";
import { LoginTerminal } from "../LoginTerminal";
import { CardRow, Heading, KvRow, ToggleRow } from "../widgets";

/** The sign-in card's alternatives, of which only some are live. The `gh` CLI
 *  method borrows the CLI's own session and powers PR creation + Reviews. */
type GhMethod = "cli" | "app" | "pat";

/** The nestings the sidebar's Reviews section knows how to build, in increasing
 *  depth. The same four Linear offers for the worktree tree, since both nest on
 *  the same two Linear levels — but the default is None: a review inbox is short,
 *  and a heading per project on four PRs explains nothing. */
const GROUP_BY_OPTIONS: { value: LinearGroupBy; label: string }[] = [
  { value: "none", label: "None" },
  { value: "project", label: "Project" },
  { value: "milestone", label: "Milestone" },
  { value: "project_milestone", label: "Project → Milestone" },
];

/** The dropdown in the card's preference row — the same control the Linear card
 *  uses, so the two settings read as one kind of choice. */
const ROW_SELECT_CLASS =
  "rounded-lg border border-line-3 bg-input py-2 pr-8 pl-[11px] text-[12px] text-fg-3";

export function GitHubSection() {
  const { data: gh, refetch, isFetching } = useGithubStatus();
  const groupBy: LinearGroupBy = parseGithubGroupBy(useSetting("app", GITHUB_GROUP_BY_KEY).data);
  const showEmpty = isOptedIn(useSetting("app", REVIEWS_SHOW_EMPTY_KEY).data);
  const { mutate: setSetting } = useSetSetting();
  const [method, setMethod] = useState<GhMethod>("cli");
  const [loginOpen, setLoginOpen] = useState(false);
  const qc = useQueryClient();

  const badge = !gh ? null : !gh.installed ? (
    <Badge color="var(--color-status-amber)">not found</Badge>
  ) : gh.authenticated ? (
    <Badge color="var(--color-status-green)">connected</Badge>
  ) : (
    <Badge color="var(--color-status-amber)">signed out</Badge>
  );

  const wipBadge = <Badge color="var(--color-muted-2)">WIP</Badge>;

  return (
    <>
      <Heading
        title="GitHub"
        subtitle="Choose how santree authenticates GitHub operations on your machine. Pull requests, checks and the Reviews inbox all go through it."
      />

      <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
        <div className="flex items-center gap-3 px-4 pt-2.5">
          <Tabs<GhMethod>
            tabs={[
              { value: "cli", label: "gh CLI auth", icon: <CliIcon size={14} /> },
              {
                value: "app",
                label: "GitHub App",
                icon: <GlobeIcon size={14} />,
                dimmed: true,
                badge: wipBadge,
              },
              {
                value: "pat",
                label: "Access token",
                icon: <KeyIcon size={14} />,
                dimmed: true,
                badge: wipBadge,
              },
            ]}
            value={method}
            onChange={setMethod}
            className="min-w-0 flex-1"
          />
        </div>

        {method === "cli" ? (
          <div className="flex flex-col gap-3.5 px-4 py-4">
            <div className="flex items-center gap-3">
              <span className="flex-1 text-[12.5px] text-muted-3">
                santree runs the `gh` CLI as you. No separate sign-in.
              </span>
              {badge}
              <button
                type="button"
                onClick={() => refetch()}
                className="flex flex-none cursor-pointer items-center gap-1.5 text-[11.5px] text-muted-2 transition-colors hover:text-fg-2"
              >
                <RefreshIcon size={12} className={isFetching ? "animate-spin" : ""} />
                Refresh
              </button>
            </div>

            {gh && !gh.installed && (
              <div className="flex items-start gap-2 text-[11.5px]">
                <WarningIcon size={13} className="mt-px flex-none text-status-amber" />
                <div className="text-muted-3">
                  <span className="font-medium text-status-amber">
                    GitHub CLI not found on your PATH.
                  </span>{" "}
                  Install it (<span className="font-mono text-fg-3">brew install gh</span>) and run{" "}
                  <span className="font-mono text-fg-3">gh auth login</span>. Without it,
                  pull-request creation and the Reviews tab stay empty. Already installed? Point
                  santree at it below.
                </div>
              </div>
            )}

            {/* Offered in both states: not-found is when you need it most, but a
                second install (or the wrong one on PATH) is a real case too. */}
            <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
              <BinaryPathField name="gh" hint="only needed if santree can't find it itself" />
            </div>

            {gh?.installed && (
              <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
                {gh.authenticated && <KvRow label="Account" value={gh.account} />}
                {gh.authenticated && gh.name && <KvRow label="Name" value={gh.name} />}
                {gh.authenticated && <KvRow label="Host" value={gh.host} />}
                <KvRow label="CLI path" value={gh.detectedExec} />
                {gh.version && <KvRow label="Version" value={gh.version} />}
                {!gh.authenticated && (
                  <div className="flex items-start gap-2 border-t border-line px-3 py-2.5 text-[11.5px]">
                    <WarningIcon size={13} className="mt-px flex-none text-status-amber" />
                    <div className="text-muted-3">
                      <span className="font-medium text-status-amber">Not signed in.</span> Run{" "}
                      <span className="font-mono text-fg-3">gh auth login</span> below, or Refresh
                      if you just signed in elsewhere.
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Offered while signed in too, exactly like the agent panes' login:
                re-authenticating or switching account is the same command, and
                `gh` asks before it replaces a session. santree only seeds it —
                the CLI does the sign-in and keeps its own credentials. */}
            {gh?.installed &&
              (loginOpen ? (
                <LoginTerminal
                  refId="login:github"
                  command={ghLoginCommand(gh.detectedExec)}
                  onClose={() => {
                    setLoginOpen(false);
                    void qc.invalidateQueries({ queryKey: queryKeys.githubStatus });
                    void qc.invalidateQueries({ queryKey: queryKeys.githubApiBudget });
                  }}
                  className=""
                />
              ) : (
                <Button onClick={() => setLoginOpen(true)} className="self-start">
                  <PlayIcon size={11} />
                  Run <span className="font-mono">gh auth login</span>
                </Button>
              ))}
          </div>
        ) : (
          <div className="px-4 py-6 text-center text-[12px] text-muted-3">
            {method === "app"
              ? "Sign in to GitHub from inside santree, without the gh CLI."
              : "Paste a personal access token; santree keeps it in the OS keychain."}
            <div className="mt-1 text-[11.5px] text-muted-4">Not built yet.</div>
          </div>
        )}
      </div>

      {/* Its own card, beside the sign-in rather than inside it: the budget
          belongs to the session that signing in produced, and it is the same
          shape the Linear card shows for its workspace. */}
      {gh?.authenticated && <GithubBudget />}

      {/* How the inbox is *shown* has nothing to do with how santree signs in,
          and it applies whichever method is live. One selector rather than
          nested toggles, mirroring the Linear card — project and milestone are
          levels of the same nesting. */}
      <div className="mt-3 overflow-hidden rounded-xl border border-line-2 bg-raised">
        <CardRow
          label="Group reviews by"
          hint="How each project's Reviews section in the sidebar nests the pull requests inside Assigned to me and each team that asked. Needs a connected Linear workspace — the projects and milestones are Linear's."
        >
          {(labelId) => (
            <ChevronSelect
              value={groupBy}
              onChange={(value) => setSetting({ scope: "app", key: GITHUB_GROUP_BY_KEY, value })}
              className={`w-[186px] ${ROW_SELECT_CLASS}`}
              wrapperClassName="flex-none"
              aria-labelledby={labelId}
            >
              {GROUP_BY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-input">
                  {option.label}
                </option>
              ))}
            </ChevronSelect>
          )}
        </CardRow>
      </div>

      {/* Off by default, and about what the *sidebar's* Reviews section lists —
          which is why it sits here rather than in the view it affects: the
          section is on screen whatever view you are in. */}
      <div className="mt-3 rounded-xl border border-line-2 bg-raised px-4 py-1">
        <ToggleRow
          label="Show Reviews on quiet projects"
          hint="Off, a project with nothing waiting shows no Reviews section at all. On, every project with a GitHub remote keeps a folded one, so a quiet repo reads as quiet rather than as unsupported."
          on={showEmpty}
          onChange={(next) =>
            setSetting({ scope: "app", key: REVIEWS_SHOW_EMPTY_KEY, value: String(next) })
          }
        />
      </div>
    </>
  );
}

/** The command seeded into the login terminal.
 *
 *  Seeds the executable santree itself resolved rather than the bare word: the
 *  login shell spawned for the terminal can miss a Nix-installed `gh` (its PATH
 *  hook never runs there), and the user may have pointed santree at a specific
 *  one via `binary_path.gh`. Falls back to `gh` when nothing was detected.
 *  Single-quoted unless the path is a plain token, so a path with spaces still
 *  runs as one argument. Kept module-private so this file exports components
 *  only, which is what keeps Fast Refresh working on it. */
function ghLoginCommand(detectedExec: string): string {
  const bin = detectedExec.trim();
  if (!bin) return "gh auth login";
  const quoted = /^[\w@%+=:,./-]+$/.test(bin) ? bin : `'${bin.replace(/'/g, `'\\''`)}'`;
  return `${quoted} auth login`;
}

/** What is left of the GitHub budget the `gh` session spends.
 *
 *  The budget belongs to the token, not to santree — anything else signed in as
 *  the same `gh` account draws on the same pools, which is why the number has to
 *  come from GitHub's `/rate_limit` rather than from a local tally. That
 *  endpoint is free, so refreshing it never moves what it reports. */
function GithubBudget() {
  const { data: budget } = useGithubApiBudget();
  if (!budget) return null;
  return (
    <div className="mt-3 rounded-xl border border-line-2 bg-raised px-4 py-3.5">
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-fg-3">API budget</span>
        <span className="text-[11.5px] text-muted-3">
          Per hour, per pool. Throttling stops on whichever one runs out first.
        </span>
      </div>
      <ApiBudgetMeters
        windows={budget.windows}
        caption="GitHub's own /rate_limit for this gh session. Shared with everything else signed in as the same account."
      />
    </div>
  );
}
