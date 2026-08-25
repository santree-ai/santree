# Changelog

Notes for each release, newest first. The release workflow publishes the
matching `## <version>` section as the GitHub release body **and** as the
"What's new" the in-app updater shows — write plain bullets, no heavy
markdown, because the app renders them as text. A stable tag fails the
release guard without an entry here; a beta without one falls back to a
commit-compare link.

## 0.1.4-beta.1 — 2026-08-25

- Fixed the hidden Dev terminal so its persistent Claude session launches in the configured Santree checkout again, while rejecting unconfigured repository paths.

## 0.1.3 — 2026-08-25

- Triage queues can now be ordered by attention, due date, priority, creation
  date, or a shared manual order. Manual mode supports drag and drop, keyboard
  reordering, optimistic updates, and undo while respecting read-only access.
- Triage now separates active investigations, waiting issues, and snoozed work
  into clear lanes, and surfaces live agent activity, issue due dates, project
  deadlines, priority, and estimates directly in the queue.
- Issues, Trees, Triage, and Reviews now share a quieter, more consistent card
  and selection system with richer work signals and clearer project grouping.
- Ticket titles render their Markdown consistently across every workflow, with
  improved wrapping for long inline-code titles and narrow side panels.
- Reviews and Triage open on useful home surfaces with workload summaries,
  suggested next items, and discoverable keyboard shortcuts.
- AI review badges now count only current draft comments and update immediately
  as drafts are created, removed, or published.

## 0.1.3-beta.1 — 2026-08-24

- Reviews and Triage now open on useful, unselected home surfaces with clear
  workload summaries, suggested next items, priority and SLA context, and
  discoverable keyboard shortcuts.
- AI review badges now count only the draft comments currently waiting for you,
  update immediately when a draft is deleted, and stay synchronized as review
  agents add or publish drafts.

## 0.1.2 — 2026-08-24

- Codex is now a first-class agent throughout Santree, with its real interactive
  terminal, Codex-managed authentication, live models and reasoning options,
  durable sessions, and provider-aware state and usage.
- Claude Code and Codex can work side by side in Work, Triage, Trees, and
  Reviews. Existing sessions keep their original provider, while each workflow
  remembers separate settings for every configured agent.
- AI reviews now support provider-specific sessions, briefs, and draft comments.
  Codex reviews receive Santree's review tools without exposing GitHub writes,
  and drafts remain private until you explicitly add and submit them.
- Work helpers can independently use the configured provider for commit messages
  and pull request descriptions, regardless of which agent wrote the code.
- Reviews, Trees, Triage, Issues, Agents, and Settings have a cleaner shared
  visual system with stronger grouping, clearer priority and activity signals,
  responsive panels, and less visual noise.
- A global command palette and discoverable keyboard shortcuts provide fast
  access to tickets, pull requests, worktrees, sessions, and navigation.
- Fixed review diff rendering, stale or duplicated review counts, incorrect
  provider branding, sluggish panel resizing, noisy development warnings, and
  several startup and session-resume failures found during the beta cycle.

## 0.1.2-beta.13 — 2026-08-24

- Agent settings now keep provider-specific workflow choices separate, show
  Claude Code version availability, and place Claude Remote Control with the
  Claude Code agent settings.
- Trees now name new agent tabs for the provider that actually runs them and
  consistently use the configured Work agent.
- The Reviews sidebar now puts your PRs first, makes every section collapsible,
  and removes duplicate review rows and counts.
- Opening a pull request as a tree now reuses its existing checkout, targets the
  correct registered repository, and prevents conflicting branch or worktree
  identities from launching against the wrong code.
- Agent integrations are marked as work in progress, and new Linear connections
  request read-only access by default.

## 0.1.2-beta.11 — 2026-08-24

- Commit-message and PR-description controls now show the provider configured
  for that helper instead of always showing Claude Code.
- Review actions now follow the selected provider tab, with the correct icon and
  explicit labels such as "Open Codex review" and "Open Claude Code review."

## 0.1.2-beta.10 — 2026-08-24

- AI review tabs now show only the draft comments created by that provider, so
  Codex and Claude Code no longer share the same badge and footer count.
- Codex AI reviews now load Santree's draft-comment and review-brief tools in
  both new and resumed sessions. Missing review tools fail visibly instead of
  silently starting a review that cannot save its findings.

## 0.1.2-beta.9 — 2026-08-24

- Fixed new Codex terminals failing to attach with a request-rejected error.
  Threads are now made durable before the interactive Codex terminal resumes
  them, and unusable thread IDs created by beta.8 recover automatically.
- Codex reasoning-effort menus now come from each model's live capabilities,
  including model-specific defaults and options such as ultra where supported.
- Fixed ended AI-review sessions collapsing against the left edge instead of
  filling the review pane.

## 0.1.2-beta.7 — 2026-08-24

- Fixed Codex settings and agent launches failing with “Codex initialize timed
  out.” Santree now speaks the App Server's Unix WebSocket transport correctly,
  with bounded startup time, short private socket paths, and reliable process
  cleanup when a connection fails.

## 0.1.2-beta.6 — 2026-08-24

- Codex is now the default agent for new work, investigations, Ask AI, Fix CI,
  and manual agent tabs. Existing Claude sessions and tabs keep their provider
  and continue to resume as before; AI Review keeps its existing Claude tools
  in this beta.
- Codex runs through its own App Server while the real Codex terminal remains
  interactive. Settings now shows the detected CLI, account, models, reasoning
  options, rate limits, and login controls.
- Agent sessions now use one provider-neutral contract, so future providers can
  plug into the same session, tab, workflow, and launch boundaries without
  adding provider branches throughout the app.
- Tightened agent-launch security around persisted provider identity, review
  checkout paths, App Server sockets, executable resolution, and Codex sandbox
  permissions.

## 0.1.2-beta.5 — 2026-08-23

- New: AI review. In the Reviews tab, "Review with AI" opens a Claude session
  on the pull request that reads it and writes its findings back into santree:
  a brief beside the diff, and draft comments anchored to the lines they are
  about. You edit or delete each one and add the ones you keep to your own
  pending review, then send it with Finish review as usual. Nothing it writes
  reaches GitHub until you add it.
- The session can read your connected tools while it reviews, so it can check
  the change against the ticket and the documents that ticket links to.
- A draft written before someone pushed is flagged rather than sent, since its
  line numbers no longer describe the code.
- The review brief is now written by that session instead of a separate
  background call, so it arrives while you watch and you can ask for changes.

## 0.1.2-beta.4 — 2026-08-23

- Pressing the + in a diff and dragging now covers every line you drag over.
  In beta.3 it still stopped at the line you started from: the range only grew
  while the pointer was over the line numbers, and the + sits half over the
  code, so dragging down left the gutter immediately.

## 0.1.2-beta.3 — 2026-08-23

- Range comments now start where you reach for them. Press the + in a diff's
  line-number gutter and drag; let go, and the comment box opens on every line
  you covered. Pressing the + used to open the box straight away, which left no
  way to drag past the first line. Clicking it without dragging still comments
  on that one line.
- Reworded a lot of the text across the app and the website.

## 0.1.2-beta.2 — 2026-08-23

- Review comments can cover a range of lines. Drag down the line numbers in a
  PR diff and click the + on the last line you picked; the comment lands on
  the whole range, the way it does on GitHub.
- Suggest a change from the comment box. The Suggestion button drops in a
  block already filled with the lines you're commenting on, and a suggestion
  someone posts now shows as the change it proposes: the lines it replaces in
  red above the ones it suggests in green.
- The comment box itself reads like GitHub's: who you're commenting as, which
  line you're on, and Cancel / Comment / Start a review.
- Fixed the colours inside a diff in dark mode. Comment boxes and comment
  threads had lost their text shades and sat on a different black from the
  diff around them.
- The hidden Dev tab gained two panes: Files, to browse the checkout, read the
  diff of what changed and commit it; and Release, to bump the version, write
  the changelog entry, tag and push a release without leaving the app.

## 0.1.2-beta.1 — 2026-08-21

- New keep-awake toggle in the top bar (the coffee cup, macOS only): hold the
  Mac awake (no sleep, no lock screen) while a long agent run is on screen.
- The keep-awake toggle is now remembered. Turn it on and it stays on across
  restarts until you turn it off; it starts off on a fresh install. Quitting
  santree always lets the Mac sleep again.

## 0.1.1 — 2026-08-20

- santree now updates itself. Settings → Updates checks your release channel,
  downloads, and relaunches; a background check runs shortly after launch and
  every six hours, announcing new versions with a toast.
- Release channels: Stable gets finished releases, Beta gets every build as it
  ships. The channel is a dropdown in Settings → Updates, and updates only
  ever move forward.
- Linear can be connected read-only. Choose the permissions santree requests
  in Settings → Integrations; everything that writes to Linear (status
  changes, comments, the "move to In Progress" automation) disables itself
  with an explanation when writes aren't available. Flipping to read-only
  applies immediately, no reconnect needed.
- Local GitHub settings are one tabbed card, matching the Agents screen.
- The DMG installer got its background and icon layout back.

## 0.1.0 — 2026-08-19

- First signed, notarized macOS release: one universal DMG (Apple Silicon +
  Intel), built, verified and published entirely from CI.
