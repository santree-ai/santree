/**
 * The fixture world at the IPC boundary: one handler per command the views
 * read, each answering in the command's own return shape. Anything not listed
 * here reaches the real backend — settings, prompts, the agent catalog, the
 * keychain-backed statuses — so the fixture mode shows the app's real chrome
 * around invented work.
 */
import type { Channel } from "@tauri-apps/api/core";

import type {
  AgentAccount,
  AgentKind,
  AgentSession,
  ApiBudgetWindow,
  CheckLog,
  ClaudeAccountRateLimits,
  ClaudeAccountUsage,
  CodexAccountRateLimits,
  LinearApiBudget,
  LinearOrg,
  LinearStatus,
  ResourceUsage,
  ScriptInfo,
  SessionSubagent,
  SessionUsageLive,
  TerminalAnchor,
  TerminalInventory,
  TerminalOpenOpts,
  TriageSession,
  ViewedMarks,
  WorktreeTab,
} from "../../bindings";
import {
  mergeQueue,
  prDetail,
  prSummary,
  prTickets,
  reviewBrief,
  reviewDrafts,
  reviewInbox,
  reviewWorkItems,
} from "./prs";
import {
  attachFake,
  closeFake,
  detachFake,
  fakeAgentProcesses,
  fakeSessions,
  isFakePty,
  openFake,
  ownsLabel,
  resizeFake,
} from "./terminal";
import {
  AGENTS,
  BASE_ID,
  baseWorktree,
  branchChanges,
  DAY,
  fileDiff,
  fileSource,
  files,
  HOUR,
  LINEAR_ORG,
  linearTeams,
  ME_LOGIN,
  MIN,
  QUACK,
  REPO_PATH,
  repos,
  sessionDetail,
  sessionStates,
  sessions,
  TABS,
  tasks,
  ticketDetail,
  triageSchedule,
  triageTickets,
  workingChanges,
  worktreePrs,
  worktrees,
} from "./world";

export type Args = Record<string, unknown>;
export type Invoke = (cmd: string, args?: Args, options?: unknown) => Promise<unknown>;
type Handler = (args: Args) => unknown;

const str = (args: Args, key: string): string => String(args[key] ?? "");
const num = (args: Args, key: string): number => Number(args[key] ?? 0);

/** Settings that name a repo: the real rows point at the user's projects, and
 *  the fixture world has its own. Plus Settings → Experimental with every
 *  switch on, so the captures keep Daedalus and the English tutor in Settings
 *  and the Conversation view's switch on a Claude tab, whatever this machine
 *  has turned on. Those keys are `EXPERIMENTAL_KEYS` in `lib/queries`, spelled
 *  out: this module sits under the `invoke` alias, and `lib/queries` imports the
 *  bindings that alias serves. Everything else is answered by the real settings
 *  store, which is what keeps the chrome honest. */
const SETTING_OVERRIDES: Record<string, string> = {
  triage_default_repo: QUACK,
  work_default_repo: QUACK,
  experimental_daedalus: "true",
  experimental_english_tutor: "true",
  experimental_conversation: "true",
};

const tabs: WorktreeTab[] = [...TABS];

export function buildHandlers(real: Invoke): Record<string, Handler> {
  const now = () => Date.now();

  const settingOverride = (key: string): string | undefined =>
    SETTING_OVERRIDES[key] ?? (key.startsWith("triage_repo:") ? QUACK : undefined);

  return {
    // ── Registry ───────────────────────────────────────────────────────────
    list_repos: () => repos(),
    watch_worktrees: () => null,
    repo_branches: (a) => [
      {
        name: "main",
        hasWorktree: true,
        remoteOnly: false,
        updatedAt: new Date(now() - HOUR).toISOString(),
      },
      ...worktrees(str(a, "repo"), now()).map((w) => ({
        name: w.branch,
        hasWorktree: true,
        remoteOnly: false,
        updatedAt: new Date(now() - 2 * HOUR).toISOString(),
      })),
      {
        name: "release/2.0",
        hasWorktree: false,
        remoteOnly: true,
        updatedAt: new Date(now() - 3 * DAY).toISOString(),
      },
    ],
    worktree_init_script: (a): ScriptInfo => ({
      path: `${REPO_PATH[str(a, "repo")] ?? "/tmp"}/.santree/init.sh`,
      exists: true,
      executable: true,
      content: "#!/bin/sh\nset -e\npnpm install --frozen-lockfile\npnpm db:reset --quiet\n",
    }),
    legacy_cli_probe: () => null,
    check_for_update: () => null,

    get_setting: (a) => {
      const key = str(a, "key");
      const override = str(a, "scope") === "app" ? settingOverride(key) : undefined;
      return override === undefined ? real("get_setting", a) : override;
    },
    resolve_setting: (a) => {
      const override = settingOverride(str(a, "key"));
      return override === undefined ? real("resolve_setting", a) : override;
    },
    // The switches above are answered on: turning one here would write this
    // machine's row (and start or stop its Daedalus link) for nothing.
    set_experimental: () => null,

    // ── Jira ──────────────────────────────────────────────────────────────
    // The fixture company is a Linear shop; answering here keeps a real
    // connected Jira site from leaking into a capture.
    jira_sites: () => [],
    jira_auth_status: () => ({
      authenticated: false,
      siteName: null,
      siteUrl: null,
      cloudId: null,
      canWrite: false,
    }),

    // ── TickTick ──────────────────────────────────────────────────────────
    // Same reason: a real connected TickTick account stays out of a capture.
    ticktick_status: () => ({
      connected: false,
      via: null,
      oauthAvailable: false,
      canWrite: false,
    }),
    ticktick_lists: () => [],

    // ── Daedalus ──────────────────────────────────────────────────────────
    // No agent, so a real home server's name never reaches a capture.
    daedalus_status: () => ({ kind: "AgentMissing" }),
    daedalus_health: () => ({
      link: { kind: "AgentMissing" },
      checkedAt: new Date(now()).toISOString(),
    }),
    daedalus_workspaces: () => ({
      link: { kind: "AgentMissing" },
      hostOutdated: false,
      generatedAt: null,
      workspaces: [],
    }),
    daedalus_icon: () => null,
    daedalus_settings: () => ({ kind: "AgentMissing" }),
    daedalus_set_setting: () => ({ kind: "Refused", reason: "No Daedalus agent in fixtures." }),

    // ── Linear ────────────────────────────────────────────────────────────
    linear_auth_status: (): LinearStatus => ({
      authenticated: true,
      orgSlug: LINEAR_ORG.slug,
      org: LINEAR_ORG.name,
      canWrite: true,
      via: "OAuth",
    }),
    linear_orgs: (): LinearOrg[] => [
      { slug: LINEAR_ORG.slug, name: LINEAR_ORG.name, canWrite: true, via: "OAuth" },
    ],
    linear_api_budget: (): LinearApiBudget[] => [
      {
        slug: LINEAR_ORG.slug,
        name: LINEAR_ORG.name,
        windows: [
          { kind: "Complexity", limit: 250_000, remaining: 231_400, resetsAtMs: now() + 42 * MIN },
          { kind: "Requests", limit: 1_500, remaining: 1_462, resetsAtMs: now() + 42 * MIN },
        ],
        observedAtMs: now() - 3 * MIN,
      },
    ],
    linear_list_issues: (a) => tasks(str(a, "repo"), now()),
    task_note: () => null,
    triage_detail: (a) => ticketDetail(str(a, "ticketId"), now()),
    list_triage_tickets: (a) => triageTickets(str(a, "repo"), now()),
    triage_schedule: (a) => triageSchedule(str(a, "repo"), now()),
    linear_teams: (a) => linearTeams(str(a, "repo")),
    triage_snooze: () => null,
    triage_set_state: () => null,
    triage_add_comment: () => null,
    started_investigations: (a): TriageSession[] =>
      str(a, "repo") === QUACK ? [{ refId: "QK-203", agentKind: "Claude" }] : [],

    // ── Worktrees ─────────────────────────────────────────────────────────
    worktrees: (a) => worktrees(str(a, "repo"), now()),
    base_worktree: (a) => baseWorktree(str(a, "repo")),
    worktree_prs: (a) => worktreePrs(str(a, "repo")),
    worktree_status: (a) => workingChanges(str(a, "issueId")),
    worktree_branch_changes: (a) => branchChanges(str(a, "issueId")),
    worktree_files: (a) => files(str(a, "repo")),
    worktree_file_diff: (a) => fileDiff(str(a, "path")),
    worktree_branch_file_diff: (a) => fileDiff(str(a, "path")),
    worktree_file_source: (a) => fileSource(str(a, "path")),
    worktree_sessions: (a) => sessions(str(a, "repo"), str(a, "issueId"), now()),
    worktree_session_detail: (a) => sessionDetail(str(a, "sessionId")),
    worktree_session_subagents: (a): SessionSubagent[] =>
      str(a, "sessionId") === "9b2e7f10-142z"
        ? [
            {
              agentId: "sub-1",
              parentAgentId: null,
              depth: 1,
              agentType: "Explore",
              description: "Find every caller of bearing()",
              messageCount: 11,
              status: "Completed",
              lastActivityMs: now() - 25 * HOUR,
              sampled: false,
            },
            {
              agentId: "sub-2",
              parentAgentId: null,
              depth: 1,
              agentType: "general-purpose",
              description: "Run the pond suite under Safari's WebKit build",
              messageCount: 18,
              status: "Completed",
              lastActivityMs: now() - 25 * HOUR,
              sampled: false,
            },
          ]
        : [],
    worktree_has_transcripts: () => true,
    commit_draft: () => null,
    pr_reviewers: () => [],
    session_providers: (a): AgentKind[] => {
      const agent = AGENTS.find((x) => x.termKey === str(a, "termKey"));
      return agent ? [agent.kind] : [];
    },
    agent_session: (a): AgentSession => {
      const kind = (a.agent as AgentKind) ?? "Claude";
      return {
        type: "fresh",
        agentKind: kind,
        executable: kind === "Codex" ? "codex" : "claude",
        sessionId: null,
        launchFlags: "",
        launchEnv: [],
        account: null,
      };
    },
    list_worktree_tabs: (a) => {
      const ids = new Set(worktrees(str(a, "repo"), now()).map((w) => w.id));
      ids.add(BASE_ID);
      return tabs.filter((t) => ids.has(t.worktreeId));
    },
    add_worktree_tab: (a) => {
      tabs.push({
        id: str(a, "id"),
        worktreeId: str(a, "worktreeId"),
        kind: a.kind as WorktreeTab["kind"],
        agentKind: (a.agentKind as AgentKind | null) ?? null,
        title: str(a, "title"),
        pr: null,
        account: null,
        url: null,
      });
      return null;
    },
    rename_worktree_tab: (a) => {
      const t = tabs.find((x) => x.id === str(a, "id"));
      if (t) t.title = str(a, "title");
      return null;
    },
    remove_worktree_tab: (a) => {
      const i = tabs.findIndex((x) => x.id === str(a, "id"));
      if (i !== -1) tabs.splice(i, 1);
      return null;
    },
    worktree_tab_launch: () => null,

    // ── GitHub ────────────────────────────────────────────────────────────
    reviews: () => reviewInbox(now()),
    pr_summary: (a) => prSummary(`${str(a, "owner")}/${str(a, "name")}`, num(a, "number"), now()),
    pr_detail: (a) => prDetail(`${str(a, "owner")}/${str(a, "name")}`, num(a, "number"), now()),
    pr_repo_labels: () => [
      { name: "bread-api", color: "d97706", description: "The crumb dispenser" },
      { name: "migration", color: "0ea5a4", description: null },
      { name: "needs-review", color: "5e6ad2", description: null },
      { name: "pond", color: "2563eb", description: null },
    ],
    pr_tickets: (a) => prTickets((a.ids as string[]) ?? [], now()),
    merge_queue: (a) => mergeQueue(str(a, "repo"), now()),
    review_drafts: (a) => reviewDrafts(str(a, "prRepo"), num(a, "number"), now()),
    review_work_items: (a) => reviewWorkItems(str(a, "prRepo"), num(a, "number"), now()),
    pr_review_brief: (a) => reviewBrief(str(a, "prRepo"), num(a, "number"), now()),
    reviewed_files: (): ViewedMarks => ({ source: "local", files: [] }),
    github_viewer_login: () => ME_LOGIN,
    review_checkout: () => null,
    review_workspace: () => null,
    pr_file_source: () => ({ oldText: "", newText: "" }),
    pr_check_log: (): CheckLog => ({
      blocks: [
        { kind: "line", text: "$ pnpm vitest run", level: "Command" },
        {
          kind: "group",
          title: "src/pond/events.test.ts",
          lines: [
            { text: " ✓ pond_v2 migration › creates the schema", level: "Normal" },
            { text: " ✓ pond_v2 migration › dual-writes new quacks", level: "Normal" },
            { text: " ✗ pond_v2 migration › backfills legacy ponds", level: "Error" },
            {
              text: "   AssertionError: expected 3 rows in pond_v2.quack_events, got 2",
              level: "Error",
            },
            { text: "   at src/pond/events.test.ts:142:31", level: "Error" },
          ],
        },
        { kind: "line", text: "Test Files  1 failed | 41 passed (42)", level: "Warning" },
        { kind: "line", text: "     Tests  1 failed | 212 passed (213)", level: "Warning" },
        {
          kind: "line",
          text: "ELIFECYCLE  Test failed. See above for more details.",
          level: "Error",
        },
      ],
      truncated: false,
    }),
    github_api_budget: (): { windows: ApiBudgetWindow[] } => ({
      windows: [
        { kind: "Rest", limit: 5_000, remaining: 4_871, resetsAtMs: now() + 38 * MIN },
        { kind: "GraphQl", limit: 5_000, remaining: 4_790, resetsAtMs: now() + 38 * MIN },
        { kind: "Search", limit: 30, remaining: 30, resetsAtMs: now() + MIN },
      ],
    }),

    // ── Agents and usage ──────────────────────────────────────────────────
    session_states: () => sessionStates(now()),
    agent_processes: () => fakeAgentProcesses(),
    session_usage_live: (): SessionUsageLive[] => [
      {
        agentKind: "Claude",
        sessionId: "3f1c9a2e-142a",
        usedPct: 42,
        inputTokens: 84_300,
        contextSize: 200_000,
        model: "claude-opus-5",
        costUsd: 1.87,
        updatedAtMs: now() - 40_000,
        outputStyle: null,
        vimMode: null,
      },
      {
        agentKind: "Claude",
        sessionId: "8a77d0b1-138a",
        usedPct: 61,
        inputTokens: 122_000,
        contextSize: 200_000,
        model: "claude-opus-5",
        costUsd: 3.4,
        updatedAtMs: now() - 3 * MIN,
        outputStyle: null,
        vimMode: null,
      },
      {
        agentKind: "Claude",
        sessionId: "c0ffee42-203",
        usedPct: 28,
        inputTokens: 56_000,
        contextSize: 200_000,
        model: "claude-opus-5",
        costUsd: 0.58,
        updatedAtMs: now() - 70_000,
        outputStyle: null,
        vimMode: null,
      },
      {
        agentKind: "Codex",
        sessionId: "01a0-127a-codex",
        usedPct: 35,
        inputTokens: 140_000,
        contextSize: 400_000,
        model: "gpt-5.6-sol",
        costUsd: null,
        updatedAtMs: now() - 2 * MIN,
        outputStyle: null,
        vimMode: null,
      },
    ],
    // A second Claude login beside the CLI's own, so the status bar and
    // Settings → Agents draw their multi-account rows.
    agent_accounts: (a): AgentAccount[] =>
      str(a, "agent") === "Claude"
        ? [
            {
              id: "personal",
              agent: "Claude",
              label: "Personal",
              dir: "/Users/sam/.config/santree/accounts/claude/personal",
              email: "sam@duckmail.com",
              signedIn: true,
            },
          ]
        : [],
    claude_rate_limits: (): ClaudeAccountRateLimits[] => [
      {
        account: null,
        windows: [
          {
            window: "five_hour",
            usedPct: 15,
            resetsAtMs: now() + 3 * HOUR + 32 * MIN,
            updatedAtMs: now() - MIN,
          },
          {
            window: "seven_day",
            usedPct: 31,
            resetsAtMs: now() + 5 * DAY + 14 * HOUR,
            updatedAtMs: now() - MIN,
          },
          {
            window: "seven_day_opus",
            usedPct: 39,
            resetsAtMs: now() + 5 * DAY + 14 * HOUR,
            updatedAtMs: now() - MIN,
          },
        ],
      },
      {
        account: "personal",
        windows: [
          {
            window: "five_hour",
            usedPct: 64,
            resetsAtMs: now() + HOUR + 12 * MIN,
            updatedAtMs: now() - 4 * MIN,
          },
          {
            window: "seven_day",
            usedPct: 22,
            resetsAtMs: now() + 2 * DAY + 3 * HOUR,
            updatedAtMs: now() - 4 * MIN,
          },
        ],
      },
    ],
    claude_fetch_usage: (): ClaudeAccountUsage[] => [
      {
        account: null,
        fetch: {
          windows: [
            {
              window: "five_hour",
              usedPct: 15,
              resetsAtMs: now() + 3 * HOUR + 32 * MIN,
              updatedAtMs: now(),
            },
            {
              window: "seven_day",
              usedPct: 31,
              resetsAtMs: now() + 5 * DAY + 14 * HOUR,
              updatedAtMs: now(),
            },
          ],
          status: "Ok",
          detail: null,
        },
      },
      {
        account: "personal",
        fetch: {
          windows: [
            {
              window: "five_hour",
              usedPct: 64,
              resetsAtMs: now() + HOUR + 12 * MIN,
              updatedAtMs: now(),
            },
            {
              window: "seven_day",
              usedPct: 22,
              resetsAtMs: now() + 2 * DAY + 3 * HOUR,
              updatedAtMs: now(),
            },
          ],
          status: "Ok",
          detail: null,
        },
      },
    ],
    codex_rate_limits: (): CodexAccountRateLimits[] => [
      {
        account: null,
        limits: {
          plan: "Pro",
          primary: {
            usedPercent: 22,
            windowMinutes: 300,
            resetsAt: Math.floor((now() + 2 * HOUR) / 1000),
          },
          secondary: {
            usedPercent: 48,
            windowMinutes: 10_080,
            resetsAt: Math.floor((now() + 4 * DAY) / 1000),
          },
        },
      },
    ],
    resource_usage: (): ResourceUsage => {
      const term = (label: string, pid: number, cpu: number, mb: number) => ({
        sessionId: null,
        label,
        pid,
        cpuPct: cpu,
        rssBytes: mb * 1024 * 1024,
        live: true,
      });
      const wt = (id: string, label: string, terminals: ReturnType<typeof term>[]) => ({
        id,
        label,
        cpuPct: terminals.reduce((s, t) => s + (t.cpuPct ?? 0), 0),
        rssBytes: terminals.reduce((s, t) => s + (t.rssBytes ?? 0), 0),
        terminals,
      });
      const quack = [
        wt("QK-142", "Ducks render upside down in Safari", [term("claude", 40_101, 8.4, 612)]),
        wt("QK-138", "Migrate quack events to the pond_v2 schema", [
          term("claude", 40_102, 0.3, 588),
        ]),
        wt("QK-127", "Pond dashboard: dark mode", [
          term("codex", 40_103, 4.1, 421),
          term("codex (subagent)", 40_104, 6.0, 310),
        ]),
        wt(BASE_ID, "main", [term("claude", 40_105, 2.2, 402), term("codex", 40_106, 1.1, 355)]),
      ];
      const repoUsage = {
        repo: QUACK,
        cpuPct: quack.reduce((s, w) => s + (w.cpuPct ?? 0), 0),
        rssBytes: quack.reduce((s, w) => s + (w.rssBytes ?? 0), 0),
        worktrees: quack,
      };
      return {
        sampledAtMs: now(),
        coreCount: 12,
        totalRssBytes: repoUsage.rssBytes,
        totalCpuPct: repoUsage.cpuPct,
        repos: [repoUsage],
      };
    },

    // ── Terminals ─────────────────────────────────────────────────────────
    terminal_open: (a) => {
      const opts = a.opts as TerminalOpenOpts;
      if (!ownsLabel(opts.label)) return real("terminal_open", a);
      return openFake(opts, a.onOutput as Channel<ArrayBuffer>);
    },
    terminal_attach: (a) =>
      isFakePty(a.id)
        ? attachFake(a.id, a.onOutput as Channel<ArrayBuffer>)
        : real("terminal_attach", a as { id: number; anchor: TerminalAnchor; onOutput: unknown }),
    terminal_resize: (a) => {
      if (!isFakePty(a.id)) return real("terminal_resize", a);
      resizeFake(a.id, num(a, "cols"), num(a, "rows"));
      return null;
    },
    terminal_detach: (a) => {
      if (!isFakePty(a.id)) return real("terminal_detach", a);
      detachFake(a.id);
      return null;
    },
    terminal_write: (a) => (isFakePty(a.id) ? null : real("terminal_write", a)),
    terminal_seed: (a) => (isFakePty(a.id) ? null : real("terminal_seed", a)),
    terminal_close: (a) => {
      if (!isFakePty(a.id)) return real("terminal_close", a);
      closeFake(a.id);
      return null;
    },
    // The santree server is not part of the world: a capture shows in-app
    // terminals, so no banner, no server controls, and nothing to confirm on
    // quit, whatever the dev machine's own mode is.
    server_status: () => ({ state: { kind: "Off" }, draining: [] }),
    quit_summary: () => ({ terminalsEnd: 0 }),
    // The fake panes beside this app's own, as the server card lists them; the
    // real list's completeness and orphans are the server's, which is off here.
    terminal_inventory: async (a) => {
      const own = (await real("terminal_inventory", a)) as TerminalInventory;
      return { sessions: [...own.sessions, ...fakeSessions()], complete: true, orphans: [] };
    },
  };
}
