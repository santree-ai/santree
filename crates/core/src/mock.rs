//! Mocked data source for santree.
//!
//! This is the *only* place that knows the data is fake. The command layer and
//! the entire frontend treat these functions as the real backend; swapping in
//! Linear/GitHub/git later means reimplementing these functions, nothing else.

// The local builder helpers below take many positional args by design — they
// keep the seed data declarations compact and readable.
#![allow(clippy::too_many_arguments)]

use crate::domain::*;

fn task(
    id: &str,
    title: &str,
    project: &str,
    status: TaskStatus,
    ready: bool,
    blocked_by: &[&str],
    x: i32,
    y: i32,
    add: u32,
    del: u32,
) -> Task {
    Task {
        id: id.into(),
        title: title.into(),
        project: project.into(),
        status,
        ready,
        blocked_by: blocked_by.iter().map(|s| (*s).into()).collect(),
        x,
        y,
        add_lines: add,
        del_lines: del,
    }
}

const BOOKING: &str = "Booking agent onboarding";
const KNOWLEDGE: &str = "Agent Knowledge: Config (VOX+MSG)";
const NO_PROJECT: &str = "No Project";

/// All tickets across projects, positioned for the dependency graph.
pub fn tasks() -> Vec<Task> {
    use TaskStatus::*;
    vec![
        task(
            "AK-159",
            "Booking Agent Onboarding Design",
            BOOKING,
            InReview,
            true,
            &[],
            34,
            54,
            312,
            47,
        ),
        task(
            "AK-170",
            "Remove the rollout-booking-agent GrowthBook flag",
            BOOKING,
            Todo,
            false,
            &["AK-159"],
            270,
            54,
            64,
            9,
        ),
        task(
            "AK-201",
            "Booking confirmation webhook + retries",
            BOOKING,
            Todo,
            true,
            &[],
            34,
            210,
            186,
            12,
        ),
        task(
            "AK-150",
            "Booking analytics events instrumentation",
            BOOKING,
            Todo,
            false,
            &["AK-159"],
            270,
            210,
            120,
            18,
        ),
        task(
            "AK-202",
            "E2E tests for end-to-end booking flow",
            BOOKING,
            Backlog,
            false,
            &["AK-170", "AK-201", "AK-64"],
            506,
            132,
            210,
            30,
        ),
        task(
            "AK-84",
            "Mark deprecated webchat columns on chat.Config",
            KNOWLEDGE,
            Todo,
            true,
            &[],
            34,
            392,
            94,
            8,
        ),
        task(
            "AK-64",
            "Drop deprecated webchat columns from chat.Config",
            KNOWLEDGE,
            Todo,
            false,
            &["AK-84"],
            270,
            392,
            120,
            40,
        ),
        task(
            "AK-65",
            "Inject per-action guidelines into LiveKit abilities",
            KNOWLEDGE,
            Backlog,
            false,
            &["AK-64", "AK-84"],
            506,
            392,
            80,
            5,
        ),
        task(
            "AK-165",
            "Spike: Auto learn from PCA",
            NO_PROJECT,
            InProgress,
            true,
            &[],
            34,
            544,
            540,
            121,
        ),
    ]
}

/// The agents available in the launch tray and settings.
pub fn agents() -> Vec<AgentDef> {
    let def = |key, label: &str, short: &str, models: &[&str]| AgentDef {
        key,
        label: label.into(),
        short: short.into(),
        models: models.iter().map(|s| (*s).into()).collect(),
    };
    vec![
        def(
            AgentKind::Claude,
            "Claude Code",
            "Claude",
            &["claude-opus-4.1", "claude-sonnet-4.5", "claude-haiku-4.5"],
        ),
        def(
            AgentKind::Codex,
            "Codex",
            "Codex",
            &["gpt-5-codex", "gpt-5", "o4-mini"],
        ),
        def(
            AgentKind::Cursor,
            "Cursor",
            "Cursor",
            &["claude-sonnet-4.5", "gpt-5", "auto"],
        ),
        def(
            AgentKind::Opencode,
            "OpenCode",
            "OpenCode",
            &[
                "claude-sonnet-4.5",
                "gpt-5",
                "qwen2.5-coder:32b",
                "llama3.3:70b",
            ],
        ),
    ]
}

/// Connected repositories.
pub fn repos() -> Vec<Repo> {
    let repo = |name: &str, tracker: &str, agents| Repo {
        name: name.into(),
        tracker: tracker.into(),
        agents,
        path: None,
    };
    vec![
        repo("akamai/agent", "Linear · Akamai workspace", 3),
        repo("akamai/web-dashboard", "Linear · Web workspace", 1),
        repo("akamai/infra", "GitHub Issues · platform", 0),
    ]
}

/// Active agent worktrees.
pub fn worktrees() -> Vec<Worktree> {
    use Activity::*;
    use TaskStatus::*;
    let wt =
        |id: &str, title: &str, status, add, del, dirty, ahead, agent, activity, pr| Worktree {
            id: id.into(),
            title: title.into(),
            status,
            add_lines: add,
            del_lines: del,
            dirty,
            ahead,
            agent,
            activity,
            pr,
        };
    vec![
        wt(
            "AK-165",
            "Spike: Auto learn from PCA",
            InProgress,
            540,
            121,
            true,
            7,
            AgentKind::Claude,
            Running,
            None,
        ),
        wt(
            "AK-201",
            "Booking confirmation webhook + retries",
            InReview,
            186,
            12,
            false,
            2,
            AgentKind::Codex,
            Running,
            Some(PullRequest {
                number: 483,
                checks: CheckState::Running,
            }),
        ),
        wt(
            "AK-159",
            "Booking Agent Onboarding Design",
            InReview,
            312,
            47,
            false,
            3,
            AgentKind::Claude,
            Idle,
            Some(PullRequest {
                number: 482,
                checks: CheckState::Passing,
            }),
        ),
        wt(
            "AK-84",
            "Mark deprecated webchat columns on chat.Config",
            Todo,
            94,
            8,
            true,
            1,
            AgentKind::Claude,
            Awaiting,
            None,
        ),
    ]
}

/// Stages an agent run progresses through.
pub fn stage_meta() -> Vec<Stage> {
    let stage = |label: &str, pct| Stage {
        label: label.into(),
        pct,
    };
    vec![
        stage("queued", 6),
        stage("creating worktree", 26),
        stage("working", 62),
        stage("review", 86),
        stage("PR open", 100),
    ]
}

/// The file browser tree shown in the Trees tab.
pub fn file_tree() -> Vec<FileEntry> {
    let f = |name: &str, icon: &str, depth, dir, modified| FileEntry {
        name: name.into(),
        icon: icon.into(),
        depth,
        dir,
        modified,
    };
    vec![
        f("akamai-agent", "▾", 0, true, false),
        f("apps", "▾", 1, true, false),
        f("booking-agent", "▾", 2, true, false),
        f("src", "▾", 3, true, false),
        f("onboarding.ts", "·", 4, false, false),
        f("webhook.ts", "·", 4, false, true),
        f("retries.ts", "·", 4, false, true),
        f("tests", "▸", 3, true, false),
        f("vox-agent", "▸", 2, true, false),
        f("packages", "▾", 1, true, false),
        f("agent-knowledge", "▾", 2, true, false),
        f("chat.Config.ts", "·", 3, false, false),
        f("pca.ts", "·", 3, false, true),
        f("livekit-abilities", "▸", 2, true, false),
        f("package.json", "·", 1, false, false),
    ]
}

/// Default user settings.
pub fn settings() -> Settings {
    let agent = |key, exec: &str, model: &str| AgentSetting {
        key,
        exec: exec.into(),
        model: model.into(),
    };
    Settings {
        default_agent: AgentKind::Claude,
        integrations: Integrations {
            linear: true,
            triage: true,
            github: true,
        },
        // `exec` is the user's override path (empty ⇒ use the one detected on
        // PATH, reported by `agent_auth`). Model is the per-agent default.
        agents: vec![
            agent(AgentKind::Claude, "", "claude-sonnet-4.5"),
            agent(AgentKind::Codex, "", "gpt-5-codex"),
            agent(AgentKind::Cursor, "", "auto"),
            agent(AgentKind::Opencode, "", "claude-sonnet-4.5"),
        ],
    }
}

/// Tickets awaiting triage.
pub fn triage_tickets() -> Vec<TriageTicket> {
    use Priority::*;
    let t = |id: &str,
             title: &str,
             priority,
             age: &str,
             meta: &str,
             sla: Option<&str>,
             snoozed_until: Option<&str>| TriageTicket {
        id: id.into(),
        title: title.into(),
        priority,
        age: age.into(),
        meta: meta.into(),
        team: None,
        sla: sla.map(Into::into),
        snoozed_until: snoozed_until.map(Into::into),
    };
    vec![
        t(
            "AK-211",
            "Customers report double-charge on booking retry",
            Urgent,
            "2h",
            "Booking agent · reported by support · 4 linked tickets",
            Some("SLA in 3h"),
            None,
        ),
        t(
            "AK-209",
            "VOX agent ignores per-action guidelines intermittently",
            High,
            "5h",
            "Agent Knowledge · reported by QA · 2 linked tickets",
            Some("SLA in 1d"),
            None,
        ),
        t(
            "AK-207",
            "Spike: auto-detect deprecated webchat usage",
            Medium,
            "1d",
            "Agent Knowledge · reported by eng",
            None,
            None,
        ),
        t(
            "AK-198",
            "Dashboard chart legend overflows on narrow viewports",
            Low,
            "3d",
            "Web · reported by design",
            None,
            Some("Mon"),
        ),
    ]
}

/// A 1×1 transparent-ish PNG used as a stand-in for an embedded Linear
/// screenshot, so the markdown image path renders without a network fetch.
/// (Real images are downloaded from Linear's CDN; here the data is mocked.)
const MOCK_SCREENSHOT: &str = "data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' width='520' height='180'>\
<rect width='520' height='180' rx='8' fill='%231b2330'/>\
<rect x='16' y='16' width='200' height='12' rx='3' fill='%233b4a63'/>\
<rect x='16' y='40' width='488' height='1' fill='%232a3850'/>\
<rect x='16' y='58' width='150' height='40' rx='4' fill='%23f8514922'/>\
<rect x='176' y='58' width='150' height='40' rx='4' fill='%233b4a63'/>\
<rect x='16' y='112' width='420' height='10' rx='3' fill='%232f3e57'/>\
<rect x='16' y='132' width='360' height='10' rx='3' fill='%232f3e57'/>\
<text x='16' y='168' fill='%236a8' font-family='monospace' font-size='11'>support-screenshot.png</text>\
</svg>";

/// The full triage issue (description markdown + comments) for the discussion
/// pane. Mirrors the shape of a Linear issue fetch.
/// A representative set of workflow states for the mock issue's status picker.
fn mock_states() -> Vec<WorkflowState> {
    let st = |id: &str, name: &str, type_: &str, color: &str| WorkflowState {
        id: id.into(),
        name: name.into(),
        type_: type_.into(),
        color: color.into(),
    };
    vec![
        st("mock-triage", "Triage", "triage", "#e2a336"),
        st("mock-backlog", "Backlog", "backlog", "#bec2c8"),
        st("mock-todo", "Todo", "unstarted", "#e2e2e2"),
        st("mock-progress", "In Progress", "started", "#f2c94c"),
        st("mock-done", "Done", "completed", "#5e6ad2"),
        st("mock-canceled", "Canceled", "canceled", "#95a2b3"),
    ]
}

pub fn triage_detail(ticket_id: &str) -> TriageDetail {
    let detail = |id: &str,
                  title: &str,
                  priority,
                  state: &str,
                  author: &str,
                  created: &str,
                  labels: &[&str],
                  project: Option<&str>,
                  sla: Option<&str>,
                  snoozed_until: Option<&str>,
                  description: String,
                  comments: Vec<TriageComment>| TriageDetail {
        id: id.into(),
        title: title.into(),
        priority,
        state: state.into(),
        state_id: Some("mock-triage".into()),
        states: mock_states(),
        url: format!("https://linear.app/akamai/issue/{id}"),
        author: author.into(),
        author_avatar_url: None,
        created: created.into(),
        labels: labels.iter().map(|s| (*s).into()).collect(),
        project: project.map(Into::into),
        sla: sla.map(Into::into),
        snoozed_until: snoozed_until.map(Into::into),
        description,
        comments,
    };
    let comment = |author: &str, created: &str, body: &str| TriageComment {
        author: author.into(),
        avatar_url: None,
        created: created.into(),
        body: body.into(),
        children: vec![],
    };
    use Priority::*;
    match ticket_id {
        "AK-209" => detail(
            "AK-209",
            "VOX agent ignores per-action guidelines intermittently",
            High,
            "Triage",
            "Priya Sharma (QA)",
            "5h ago",
            &["bug", "vox-agent", "intermittent"],
            Some("Agent Knowledge: Config (VOX+MSG)"),
            Some("SLA in 1d"),
            None,
            "During regression we saw the VOX agent **skip per-action guidelines** \
on roughly 1 in 8 sessions. It only happens for sessions that were already \
open when we pushed a guidelines change.\n\n\
- Repro rate: ~12% after a config push\n\
- Always recovers on a fresh session\n\
- No errors in the agent logs\n\n\
Looks like a caching issue rather than a prompt regression."
                .into(),
            vec![
                comment(
                    "Marco Díaz (eng)",
                    "3h ago",
                    "Confirmed locally — guidelines are read once at boot and cached \
in memory. Sessions started before the push keep the stale copy.",
                ),
                comment(
                    "Priya Sharma (QA)",
                    "2h ago",
                    "That matches what we saw. Bumping to High — it affects live calls.",
                ),
            ],
        ),
        "AK-207" => detail(
            "AK-207",
            "Spike: auto-detect deprecated webchat usage",
            Medium,
            "Triage",
            "Sam Okafor (eng)",
            "1d ago",
            &["spike", "tech-debt"],
            Some("Agent Knowledge: Config (VOX+MSG)"),
            None,
            None,
            "Can we statically detect remaining `webchat*` column reads so we can \
plan the VOX+MSG migration?\n\n\
A static scan plus a codemod could flag the deprecated columns and rewrite the \
easy call sites automatically.".into(),
            vec![comment(
                "Sam Okafor (eng)",
                "20h ago",
                "`chat.Config` is referenced at 18 call sites across 6 packages — \
worth a half-day spike.",
            )],
        ),
        "AK-198" => detail(
            "AK-198",
            "Dashboard chart legend overflows on narrow viewports",
            Low,
            "Triage",
            "Lena Park (design)",
            "3d ago",
            &["ui", "dashboard", "polish"],
            None,
            None,
            Some("Mon"),
            "On viewports below ~720px the chart legend wraps and pushes the axis \
labels off-screen.\n\n\
Snoozed until Monday — not urgent, but we should fold it into the next \
dashboard polish pass.".into(),
            vec![],
        ),
        // Default / AK-211 — the flagship urgent ticket, with an embedded image.
        _ => detail(
            "AK-211",
            "Customers report double-charge on booking retry",
            Urgent,
            "Triage",
            "Dana Klein (support)",
            "2h ago",
            &["bug", "payments", "booking-agent", "customer-impact"],
            Some("Booking agent onboarding"),
            Some("SLA in 3h"),
            None,
            format!(
                "Multiple customers report being **charged twice** when a booking \
confirmation is retried after a network blip.\n\n\
### Impact\n\
- 4 linked support tickets in the last 2h\n\
- All on the booking-agent confirmation flow\n\n\
### From a customer's statement\n\
![support screenshot]({MOCK_SCREENSHOT})\n\n\
The retry happens automatically, so the customer doesn't trigger it. Looks like \
the retry path calls `charge()` without an idempotency key.\n\n\
```ts\n\
// apps/booking-agent/src/retries.ts\n\
await charge(amount) // ⚠ no idempotency key on retry\n\
```\n\n\
Needs triage urgently — this is real money."
            ),
            vec![
                comment(
                    "Dana Klein (support)",
                    "90m ago",
                    "Refunds issued for the 4 affected customers. Flagging here so \
the underlying bug gets fixed before it spreads.",
                ),
                comment(
                    "Alex Romano (payments)",
                    "40m ago",
                    "The booking flow shares an idempotency helper with subscriptions \
(`packages/payments/idempotency.ts`). The fix is to thread a key through \
`retries()`. Happy to co-review.",
                ),
            ],
        ),
    }
}

/// The team triage rotation (who is on-call), surfaced from Linear's triage
/// responsibility schedule. `current_is_me` answers "am I on triage right now".
pub fn triage_schedule() -> TriageSchedule {
    let shift = |name: &str, range: &str, is_current: bool, is_me: bool| TriageShift {
        name: name.into(),
        range: range.into(),
        is_current,
        is_me,
    };
    TriageSchedule {
        team: "Akamai".into(),
        schedule_name: "Booking on-call".into(),
        current_name: Some("You".into()),
        current_is_me: true,
        shifts: vec![
            shift("You", "Mon–Wed", true, true),
            shift("Marco Díaz", "Thu–Fri", false, false),
            shift("Priya Sharma", "Sat–Sun", false, false),
            shift("Sam Okafor", "Next Mon–Wed", false, false),
        ],
    }
}

fn agent_msg(text: &str, refs: &[&str]) -> TriageMessage {
    TriageMessage {
        role: MessageRole::Agent,
        text: text.into(),
        refs: refs.iter().map(|p| CodeRef { path: (*p).into() }).collect(),
    }
}

/// The seed investigation thread for a triage ticket.
pub fn triage_thread(ticket_id: &str) -> Vec<TriageMessage> {
    match ticket_id {
        "AK-211" => vec![agent_msg(
            "Reproduced. The retry path in the booking webhook calls charge() without an idempotency key, so a network-level retry charges the card twice. The bug looks isolated to the handler — not the payments SDK.",
            &["apps/booking-agent/src/webhook.ts:142", "apps/booking-agent/src/retries.ts:31"],
        )],
        "AK-209" => vec![agent_msg(
            "The per-action guidelines are loaded once at boot and cached in memory. Sessions started before a config push keep stale guidelines, so it presents as intermittent. This is a cache-invalidation gap, not a prompt regression.",
            &["packages/livekit-abilities/guidelines.ts:54"],
        )],
        "AK-207" => vec![agent_msg(
            "Feasible. chat.Config is referenced at 18 call sites across 6 packages. A static scan plus a codemod could flag deprecated columns and rewrite the easy cases automatically.",
            &["packages/agent-knowledge/chat.Config.ts"],
        )],
        _ => vec![],
    }
}

/// A mocked triage answer to a free-text question (keyword-matched).
pub fn triage_answer(question: &str) -> TriageMessage {
    let q = question.to_lowercase();
    let has = |k: &str| q.contains(k);
    if has("related") {
        agent_msg(
            "Related code paths: the booking charge flow shares an idempotency helper with subscriptions, so a fix here also de-risks AK-188. The retry wrapper is used in 3 other handlers.",
            &["apps/booking-agent/src/retries.ts", "packages/payments/idempotency.ts:18"],
        )
    } else if has("estimate") || has("complexity") {
        agent_msg(
            "Low-to-medium. The fix is a localized change — thread an idempotency key through retries() and add a regression test. ~1 worktree, half a day for an agent. Risk is mostly around the existing payment tests.",
            &[],
        )
    } else if has("fix") || has("plan") {
        agent_msg(
            "Plan: (1) generate an idempotency key per booking attempt, (2) pass it into charge() in webhook.ts, (3) make retries() reuse the same key, (4) add a test that simulates a network retry and asserts a single charge. I can open a worktree and start this.",
            &["apps/booking-agent/src/webhook.ts:142"],
        )
    } else if has("own") || has("who") || has("assign") {
        agent_msg(
            "Suggested owner: the Payments pod — this touches the shared idempotency helper. Last 3 commits to webhook.ts were by the booking team, so a co-review makes sense.",
            &[],
        )
    } else {
        agent_msg(
            "I searched the repo for context on that. The relevant logic lives in the booking webhook handler and its retry wrapper; let me know if you want a fix plan or an estimate.",
            &["apps/booking-agent/src/webhook.ts"],
        )
    }
}

// ---- Diffs --------------------------------------------------------------

fn diff_line(kind: DiffLineKind, text: &str) -> DiffLine {
    DiffLine {
        kind,
        text: text.into(),
    }
}

fn diff_file(
    path: &str,
    add: u32,
    del: u32,
    tag: DiffTag,
    header: &str,
    lines: Vec<DiffLine>,
) -> DiffFile {
    DiffFile {
        path: path.into(),
        add_lines: add,
        del_lines: del,
        tag,
        hunks: vec![DiffHunk {
            header: header.into(),
            lines,
        }],
    }
}

/// The working-tree diff for a worktree.
pub fn worktree_diff(worktree_id: &str) -> WorktreeDiff {
    use DiffLineKind::*;
    match worktree_id {
        "AK-165" => WorktreeDiff {
            clean: false,
            pr_note: None,
            files: vec![
                diff_file(
                    "packages/agent-knowledge/pca.ts",
                    64,
                    0,
                    DiffTag::New,
                    "@@ -0,0 +1,9 @@",
                    vec![
                        diff_line(Add, "export function samplePCA(rows, { dims }) {"),
                        diff_line(Add, "  const centered = center(rows)"),
                        diff_line(Add, "  return eigen(centered).slice(0, dims)"),
                        diff_line(Add, "}"),
                    ],
                ),
                diff_file(
                    "packages/agent-knowledge/chat.Config.ts",
                    7,
                    2,
                    DiffTag::Modified,
                    "@@ -41,6 +41,9 @@",
                    vec![
                        diff_line(Context, "  webchatColumns: defineConfig({"),
                        diff_line(Del, "    learn: false,"),
                        diff_line(Add, "    learn: true,"),
                        diff_line(Add, "    sampler: samplePCA,"),
                        diff_line(Context, "  }),"),
                    ],
                ),
            ],
        },
        "AK-84" => WorktreeDiff {
            clean: false,
            pr_note: None,
            files: vec![diff_file(
                "packages/agent-knowledge/chat.Config.ts",
                9,
                3,
                DiffTag::Modified,
                "@@ -18,7 +18,9 @@",
                vec![
                    diff_line(Del, "  webchatLegacyId: column(),"),
                    diff_line(Add, "  /** @deprecated removed after VOX+MSG migration */"),
                    diff_line(Add, "  webchatLegacyId: column().deprecated(),"),
                    diff_line(Context, "  threadId: column(),"),
                ],
            )],
        },
        "AK-201" => WorktreeDiff {
            clean: true,
            files: vec![],
            pr_note: Some("PR #483 open · checks running".into()),
        },
        "AK-159" => WorktreeDiff {
            clean: true,
            files: vec![],
            pr_note: Some("PR #482 open · checks passing".into()),
        },
        _ => WorktreeDiff {
            clean: true,
            files: vec![],
            pr_note: None,
        },
    }
}

/// A seed commit message suggestion for a worktree.
pub fn commit_seed(worktree_id: &str) -> String {
    match worktree_id {
        "AK-165" => "feat(agent-knowledge): add PCA sampler for auto-learn".into(),
        "AK-84" => "refactor(agent-knowledge): mark deprecated webchat columns".into(),
        other => format!("chore: update {}", other.to_lowercase()),
    }
}

// ---- Terminals ----------------------------------------------------------

fn line(text: &str, tone: Tone, indent: u32) -> TerminalLine {
    TerminalLine {
        text: text.into(),
        tone,
        indent,
    }
}

/// The seed terminal transcript + status for a worktree.
pub fn terminal(worktree_id: &str) -> Terminal {
    use Tone::*;
    let (lines, running, awaiting, status, status_tone, cwd) = match worktree_id {
        "AK-165" => (
            vec![
                line(
                    "~/akamai-agent/.worktrees/ak-165 · santree/ak-165",
                    Muted,
                    0,
                ),
                line(
                    "$ claude \"implement the PCA auto-learn spike\"",
                    Default,
                    0,
                ),
                line("", Default, 0),
                line(
                    "● Read packages/agent-knowledge/chat.Config.ts (142 lines)",
                    Cyan,
                    0,
                ),
                line("● Read apps/vox-agent/src/learn.ts (88 lines)", Cyan, 0),
                line("", Default, 0),
                line(
                    "● I’ll add a PCA sampler that learns from call transcripts and",
                    Default,
                    0,
                ),
                line(
                    "  feeds the top components back into the config.",
                    Default,
                    0,
                ),
                line("  Edit packages/agent-knowledge/pca.ts", Accent, 0),
                line(
                    "    + export function samplePCA(rows, { dims }) {",
                    Green,
                    0,
                ),
                line("    +   return reduce(rows, dims)", Green, 0),
                line("    + }", Green, 0),
                line("  Bash  pnpm test pca.spec.ts", Amber, 0),
                line("    ✓ 14 passed  (2.3s)", Green, 0),
                line("", Default, 0),
                line("● working — wiring sampler into chat.Config ", Accent, 0),
            ],
            true,
            false,
            "claude working",
            Accent,
            ".worktrees/ak-165",
        ),
        "AK-201" => (
            vec![
                line(
                    "~/akamai-agent/.worktrees/ak-201 · santree/ak-201",
                    Muted,
                    0,
                ),
                line(
                    "$ codex run \"add booking confirmation webhook + retries\"",
                    Default,
                    0,
                ),
                line("", Default, 0),
                line("› analyzing apps/booking-agent/src …", Cyan, 0),
                line("› apply patch  webhook.ts", Accent, 0),
                line("    + const key = idempotencyKey(bookingId)", Green, 0),
                line(
                    "    + await charge(amount, { idempotencyKey: key })",
                    Green,
                    0,
                ),
                line("    − await charge(amount)", Red, 0),
                line("› running  pnpm test booking.e2e.ts", Amber, 0),
                line("    ✓ confirmation sent", Green, 0),
                line("    ✓ retry does not double-charge", Green, 0),
                line("› opened PR #483 · waiting on CI ", Accent, 0),
            ],
            true,
            false,
            "codex working",
            Accent,
            ".worktrees/ak-201",
        ),
        "AK-159" => (
            vec![
                line(
                    "~/akamai-agent/.worktrees/ak-159 · santree/ak-159",
                    Muted,
                    0,
                ),
                line("$ claude \"finalize onboarding design doc\"", Default, 0),
                line("", Default, 0),
                line("● Updated docs/booking-onboarding.md (+312 −47)", Cyan, 0),
                line("● Bash  git push -u origin santree/ak-159", Default, 0),
                line("    ✓ pushed · PR #482", Green, 0),
                line("", Default, 0),
                line("● Done. PR #482 is open and CI is green.", Green, 0),
                line(
                    "  Awaiting human review — nothing more to do here.",
                    Muted,
                    0,
                ),
            ],
            false,
            false,
            "idle · PR open",
            Green,
            ".worktrees/ak-159",
        ),
        _ => (
            vec![
                line("~/akamai-agent/.worktrees/ak-84 · santree/ak-84", Muted, 0),
                line(
                    "$ claude \"mark deprecated webchat columns on chat.Config\"",
                    Default,
                    0,
                ),
                line("", Default, 0),
                line("● Grep \"webchat\" across packages → 18 matches", Cyan, 0),
                line(
                    "● Some columns are still read in livekit-abilities.",
                    Default,
                    0,
                ),
                line("", Default, 0),
                line(
                    "? Should I mark these as @deprecated only, or also emit a",
                    Amber,
                    0,
                ),
                line("  runtime warning when they’re accessed?", Amber, 0),
            ],
            false,
            true,
            "awaiting your input",
            Amber,
            ".worktrees/ak-84",
        ),
    };
    Terminal {
        worktree_id: worktree_id.into(),
        lines,
        running,
        awaiting,
        status: status.into(),
        status_tone,
        cwd: cwd.into(),
    }
}
