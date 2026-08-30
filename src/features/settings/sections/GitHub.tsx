/** Settings → Integrations → GitHub: how santree authenticates GitHub (PRs +
 *  Reviews). Today only the `gh` CLI method is live; the GitHub App (OAuth) and
 *  Personal Access Token methods are shown as work-in-progress. */

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
import { Badge, Button, Tabs } from "../../../components/primitives";
import { queryKeys, useGithubApiBudget, useGithubStatus } from "../../../lib/queries";
import { ApiBudgetMeters } from "../ApiBudget";
import { BinaryPathField } from "../BinaryPathField";
import { LoginTerminal } from "../LoginTerminal";
import { Heading, KvRow } from "../widgets";

/** One card, one tab strip, one panel — the set of alternatives of which only
 *  some are live. The `gh` CLI method borrows the CLI's own session and powers
 *  PR creation + Reviews. */
type GhMethod = "cli" | "app" | "pat";

export function GitHubSection() {
  const { data: gh, refetch, isFetching } = useGithubStatus();
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

            {gh?.authenticated && <GithubBudget />}

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
    <ApiBudgetMeters
      windows={budget.windows}
      caption="GitHub's own /rate_limit for this gh session. Shared with everything else signed in as the same account."
    />
  );
}
