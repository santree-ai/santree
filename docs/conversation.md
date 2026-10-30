# The Conversation view

A Claude agent tab has two faces: **Terminal**, the real `claude` CLI in its PTY,
and **Conversation**, the same live session drawn as a conversation — prompts,
the agent's prose, how long it thought, every tool call with its input and its
result, edits as diffs, subagents, plans, todos, questions and their answers,
notices, and what each turn cost. ⌘J (or the tab's menu, or the toggle on the
strip) switches between them. The CLI keeps running in its terminal the whole
time. The Conversation view types into it only what a user would, on their
own click or key: their message, the keys of an answer they pick, and Stop's
Esc.

The Conversation view is experimental: all of it is behind Settings →
Experimental → Conversation view, off on a fresh install. While it is off, a
Claude tab is its terminal alone: no switch on the strip, no ⌘J, no menu row and
no "Open conversation" in Session history. A tab's stored choice of face is
kept, and honoured again once the switch is back on. `useConversationOffer`
(`viewMode.tsx`) is the one place that asks.

This is the source of truth for `crates/core/src/conversation/`,
`src-tauri/src/conversation*` and `src/features/conversation/`. The rules it
works inside are COMPLIANCE.md's "No output-parsing influences input" (the
composer) and "Transcript reads" (the reader).

## Why it is built from the record

The view is rebuilt from the record Claude Code keeps of the session — its
transcript under `projects/` — plus the hooks and status line santree already
layers onto every launch. It is not a client of the agent: santree does not run
`claude -p`, the Agent SDK or any other control channel to get these events.
That keeps the session exactly what it is in the terminal — the unmodified CLI
on the user's own login, the use Anthropic's terms describe as plainly allowed —
and keeps santree a terminal rather than a harness. The cost is that the view can
only show what the record and the hooks carry (see [Limits](#limits)).

## Data flow

```
claude (PTY) ──writes──▶ projects/<cwd slug>/<session>.jsonl  (+ <session>/subagents/)
                                   │
            watch.rs (FSEvents) ───┤ ConversationChanged { sessionId }, ≤ 1 per 75 ms
                                   ▼
conversation_read(target, agentId, cursor)
   locate (conversation.rs) → cache.rs (append-only reads) → claude.rs → journal.rs
                                   │
                                   ▼
useConversation (lib/queries.ts) → conversationJournal.ts → ConversationView
```

The live state the view shows (working, needs you, idle) comes from the
session-state hooks through `lib/attention.ts`, and context and cost from the
status line, exactly as the sidebar and status bar read them. The composer reads
the same hook record more strictly, as stored and only from the process now in
the pane (see [The composer](#the-composer)). The hooks also carry what the
record lacks: the dialog Claude is showing (`SessionState.prompt`, from its own
`PermissionRequest` or an MCP server's `Elicitation`), the permission mode and
effort level (`permissionMode`, `effortLevel`; the status line adds
`outputStyle` and `vimMode`), and, on a launch made while Settings →
Experimental → Conversation view was on, the reply as it renders
(`session_live_text`, refetched on `SessionLiveTextChanged`; docs/terminals.md,
"Live text").

An open view reads again on every change event, every few seconds while Claude
works, and at least once a minute otherwise: the watch forgets a session nobody
has read for three minutes, and a read is what keeps it.

## The journal

`crates/core/src/conversation/mod.rs` is the contract: a provider-neutral list of
`ConversationItem`s — user messages, agent prose, reasoning, tool calls, notices,
turn ends — each with a stable `id`, an order (`seq`) and the user turn it
belongs to (`turn`). A tool call is recorded when it is dispatched and replaced
in place when its result lands, so items change as well as append.

A read returns only what changed after the reader's cursor. A cursor names the
backend's parse (`epoch`) and the last revision the reader holds (`rev`); a
different epoch — the app restarted, the parse was evicted, the file was replaced
or shrank, the tab now names another session — makes the read a reset. The
frontend folds reads into one ordered list (`lib/conversationJournal.ts`): reset
replaces, everything else upserts by id, and unchanged items keep their identity
so an append re-renders only what moved.

Item ids are derived from the record, so they survive a re-parse: the record's
`uuid` (and `uuid:N` for further blocks of one record), `tool:<call_id>` for a
tool call, `#n` for a notice or a queued message the record gives no id.

## The reader

`conversation_read` takes a target — a tab (`repo`, `termKey`) or a session from
a worktree's history (`repo`, `issueId`, `sessionId`) — and optionally a subagent
id. The webview names a session; the file is derived in Rust:

- **A tab** reads the session its `terminal_sessions` row names now, so a
  `/clear` that rebinds the row moves the view with it. The id is one santree
  minted for `--session-id`, checked for that shape before it names a file, and
  the transcript is looked for under Claude's own projects roots only.
- **A listed session** is located by re-deriving the worktree's session listing,
  exactly as Session history does.
- **A subagent** is matched by name against its session's `subagents/` listing.
- Files are opened without following symlinks and without blocking, a file's
  identity is taken from the opened handle, and the opened file's real path is
  checked against the projects roots again (refusing a symlink guards only a
  path's last component), so a swapped path or a symlinked directory cannot
  redirect a read (`record_file.rs`).

`cache.rs` keeps up to 24 warm parses within a memory budget it checks after
every read, not only on a new parse, and reads only the bytes appended since the
last read; a partial trailing line waits for its newline. A record over 32 MB is
read from its tail (`meta.truncated`, and the view says the start is missing).

The answer is a state as well as items: `Ready`, `NoSession` (the tab's agent has
not started a session yet), `NotFound`, or `Remote` (a Daedalus project, whose
records are on the home server and not read live). Codex sessions answer
`NotFound` with their agent and thread id: Codex is not read here yet, and the
view is not offered on Codex tabs.

## Mapping Claude's transcript

`claude.rs` is incremental and tolerant: the transcript format is internal to
Claude Code and changes between versions, so a record it does not know is
skipped and a tool it does not know is still drawn as JSON. Points that are easy
to get wrong:

- Each content block of an API message is its own line, sharing `message.id`.
  Up to 2.1.299 lines were flushed block by block with placeholder usage; from
  2.1.309 a whole message lands at once. Usage is counted once per `message.id`.
- Thinking is recorded mostly empty — only a short summary at most — so a
  reasoning item often carries just "thought for N s".
- `toolUseResult` carries the structured result: an edit's `structuredPatch`
  becomes unified hunks; before the result lands (or when the edit was denied)
  the hunks are built from the old and new strings and start at line 1. A failed
  Bash result's "Exit code N" line gives the exit code.
- Typed prompts start a turn; queued prompts start one when they are delivered.
  A message typed while Claude works is a `queued` item from the moment Claude
  takes it (`queue-operation` `enqueue`, written at the Enter), pending until it
  leaves the queue: delivered (`dequeue`; `remove` with `absorbed_mid_turn`,
  when a running tool's turn takes it in; or its delivery reaching the record)
  or withdrawn (`popAll`, when Up at Claude's prompt recalls it into the input,
  or any other `remove`). Prompts queued together are delivered together and
  share one turn. Queue records have no `uuid`, and their file order is not the
  order things happened in. A background task's notification goes through the
  same queue and never becomes a queued item.
  Slash commands, shell escapes and their output are commands; task
  notifications, system reminders and compaction summaries are injected, and a
  background agent's report lands on the Agent call that started it.
- Interruptions, permission-mode changes, compaction and API errors become
  notices; an interruption marks the running tools interrupted. An Esc
  mid-tool and a "No" at its permission prompt record the same rejection, so a
  tool reads as interrupted when its denial kind says `interrupted` or
  `cancelled`, or when it belongs to the message the interrupt marker names
  (`interruptedMessageId`), and as denied otherwise.
- Every text the mapper emits — prose, reasoning, tool output, text shown from
  a tool's input — is stripped of terminal escape sequences and of control
  characters other than tab and newline, at one boundary: a transcript holds
  raw tool output.
- A rewind does not remove the abandoned branch.

Fixtures are structure captured from real transcripts with every text replaced;
a test whose fixture is a guess about the format encodes the same guess as the
parser.

## The view

`ConversationView` is a reading-width column: a header (live state, model,
permission mode in words, effort, branch, title, context and cost, and the
output style and vim mode when set), the journal by turn, and the composer. A finished turn folds to its prompt, its final answer and a footer
("Worked for 1m 12s · 14 steps · 3 files +40 −12 · 18.2k tokens"); the latest
stays open. Runs of tool calls fold into one sentence ("Read 3 files, searched
twice, ran 1 command") and open into cards per tool kind: commands with their
output, edits as diffs (the PR patch renderer), reads, searches, fetches,
subagents (lazily read with their `agentId` and drawn nested), plans, todo lists,
questions with their answers, and anything else as JSON. Folded turns mount
nothing of their work, and tool bodies mount only when opened.

What the view renders as markdown loads nothing remote: transcript text is
attacker-influenceable, and an image URL in an agent's reply would otherwise be
fetched the moment it is drawn.

The hooks add what the transcript doesn't have yet. While Claude writes a
reply, it shows under the running turn line by line as Claude draws it
(`MessageDisplay`, kept in `session_live_text`), until the transcript has the
message; the hook is registered only while the Experimental switch is on, so
only sessions launched after it was turned on have it. A turn that ends on an
API error (`StopFailure`) shows a notice naming the error, unless the
transcript has its own error notice. A message sent while Claude worked shows
in its turn as queued, delivered, or taken back into Claude's input (Up
recalls a queued message), and it confirms the composer's echo of the same
text. When the tab's terminal is lost, the view offers Resume and Close
itself, as the terminal's own notice does (`useLostTabResume`), with the
server's reason when it refuses a resume.

Claude creates a session's transcript with its first message, so a tab that has
not been prompted yet shows an empty conversation. Only once the status line
shows the session has run a turn does a missing transcript read as a problem
(transcript saving may be off).

The choice of face is per tab (keyed by its terminal key, in local storage). A
tab nobody has switched follows "Claude tabs open in" (`claude_tab_face`,
Terminal unless changed), under Settings → Experimental → Conversation view and
shown only while that switch is on; a switch records the tab's own
choice, so changing the default later never flips a tab the user set by hand.

The strip's "Conversation | Terminal" switch (in both faces, while the
Experimental switch is on), ⌘J and the tab menu's row are the only ways between
the faces: nothing in the view switches on its own or sends the user to the
terminal. While the conversation shows, the terminal stays mounted in the
terminal layer at its last size, so the PTY never sees a resize and switching
back shows it exactly as it was. The conversation mounts the first time it is
shown and then stays mounted as an opaque cover over the terminal's host
(`ConversationFace`), invisible, inert and reading nothing while the terminal
shows, so a switch keeps its scroll position and opened cards. The composer's
draft, notes and sent messages live in a per-tab memory store
(`composerStore`), so they also survive a tab switch, which unmounts the pane.

## The composer

The composer types into the tab's own pane as the user would, inside
COMPLIANCE.md's bound: only on the user's click or Enter in the view, and only
the bytes below. It works the way Orca's bridge chat does, without reading the
screen.

- **One queue per pane** (`paneWriter.ts`). Every write the view makes (a send,
  a Stop, an answer) goes through it as steps (`keys.ts`, pure and
  table-tested): one write, a wait, or a check. One action's writes never
  interleave with another's. Nothing reaches the pane within 100 ms of an Esc
  the queue sent, whatever the steps say: within about 20 ms Claude reads Esc
  and the next byte as one Alt chord, drops the Esc and acts on the other key
  (an Esc then `1` approved a command). Every write goes through the pane's
  renderer (xterm's own paste and key input) and the pane's one writer, the
  path a typed key takes. `compliance.test.ts` reads the view's modules as
  syntax trees and pins that only an action started from a click or key
  handler reaches the queue, never an effect, a timer or a subscription, and
  that the only text typed is what the user wrote in the view: the draft, or
  an answer card's field.
- **Send** is: a fresh check; clear what is left in Claude's input
  (`\x0b`×16 then `\x15`×16, Ctrl+K and Ctrl+U, one write of its own: sharing
  the text's write, the clear arrived as text); the draft as one paste, with
  control characters other than tab and newline dropped so it cannot end a
  bracketed paste early, bracketed while Claude asks for it; a wait of 500 ms
  to 1 s, longer for longer drafts; a fresh check; Enter as its own write.
  Ctrl+K and Ctrl+U empty Claude's input whatever is in it (several lines, a
  paste placeholder, an open `/` or `@` menu, either vim mode) and interrupt
  nothing while Claude works. Clearing with Esc would open Rewind on an empty
  input and write each cleared draft to Claude's history. The fresh checks read
  the session's row and the process table directly (`readSessionNow`), not the
  cache, and give up the rest of the send when the link is not live, the pane's
  input or its `claude` process changed, the session exited, or the row now
  records a dialog: an Enter there would confirm whichever option is
  highlighted.
- **When Send is on.** At the prompt, while Claude works, and while background
  agents run. A message sent while Claude works is queued by Claude itself: it
  joins the running turn after the current tool, or starts the next turn when
  this one ends. Send needs, all from the `claude` process now in the pane
  (`AgentProcess.startedAtMs`, matched to the pane by its id):
  - a hook write stored after that process started, or Claude's interrupt
    marker (`interruptedAtMs`). `SessionStart` counts: Claude fires no hook
    under the trust dialog, an `.mcp.json` approval, the bypass-permissions
    warning or the resume picker, so before it a key could answer one of them;
  - no recorded dialog, unless an interrupt marker came after it or the
    dialog's own call finished at least 2 s ago (`callEndedAtMs`, never for a
    stacked dialog). A status-line render also says a dialog closed, but that
    is timing (a status-line process that starts late can fake one), so it
    only clears the card and the dot. The 2 s are for a dialog that follows:
    it is on screen 45-70 ms before its own hook lands, longer on a loaded
    machine, and the one before it already reads finished;
  - no exited row, and a live link.

  The reconciled `state` the status dot reads never enables it: it decays a
  pending prompt to idle after a quiet spell, which suits a dot and not an
  Enter. A row the tab's previous process left is older than the floor, and a
  pane whose `claude` has exited has no floor.
- **A send that doesn't finish** keeps the draft, with "Not sent:" and the
  reason. When the paste already went in, the note says it is in Claude's
  input and that sending again replaces it: the next send's clear wipes
  Claude's copy, so nothing locks. Stop, switching to the terminal, or the view
  going away cancels a send before its Enter.
- **Sent messages** show once the session takes the Enter, as "Sent", or as
  "Queued" when Claude was working, until the transcript shows them (oldest
  first). If Claude has stopped working and 20 s pass without it, the view says
  Claude hasn't shown the message yet and offers to put it back in the
  composer. It never sends again by itself.
- **Stop** is one Esc, offered while Claude works once its process has
  reported, then held until the record moves, so there is never a second Esc
  (two open Claude's rewind menu). It is also held for 2 s after a dialog on
  record closes (`closedAtMs`): the session reads as working at once, while a
  dialog that follows may already be on screen without its hook, and an Esc
  there would reject it. An Esc that lands before Claude's first
  reply makes Claude put the prompt back in its input and record nothing: no
  hook fires and the transcript does not change. So when nothing new is
  recorded within 3 s of a Stop that ended the turn it sent, the composer puts
  that message back in the box and says so in one line; the next send's clear
  replaces Claude's copy.
- While the pane's link is not live (reconnecting to the santree server, or
  lost), the composer says so and types nothing. A server pane whose link
  drops mid-send refuses the write rather than accepting keys it would
  discard, so the draft stays.
- Showing the conversation focuses the composer, or the card while Claude
  asks. The terminal it leaves is blurred and inert (docs/terminals.md), and
  switching back hands it the focus.
- **The accepted risk** (COMPLIANCE.md). santree does not read the screen, so
  what Claude keeps only on screen can still take these keys: a dialog drawn in
  the ~50 ms before its hook lands, a menu Claude opened with no hook, or
  history search (Ctrl+R) left open in the terminal, where the clear empties
  only the search query, the paste goes into it, and the Enter loads an entry
  without sending it (the sent message then says Claude hasn't shown it).
- Nothing is sent on the user's behalf: hook state can withhold an action and
  never produces a byte, and nothing the view renders from the transcript
  reaches the draft.

## Answer cards

While Claude shows a dialog, the composer gives way to a card drawn from the
dialog's own hook payload: `SessionState.prompt`, what `PermissionRequest` or
`Elicitation` sent, kept while it is the row's latest write and stamped with
when it was recorded (`recordedAtMs`). The card shows while the view says
Claude asks, the dialog is newer than the `claude` process in the pane, and no
interrupt marker came after it; a row with no payload keeps the plain card
that points to the terminal. It draws the command, the edit as a diff, the
file to be written, the page to fetch, the questions with their options, the
plan, or an MCP server's form or address, and names the subagent or MCP server
that asks. Every string in a payload is the model's or a server's: it is drawn
as text, or as markdown that loads nothing remote, and an address is never a
link.

An answer is the dialog's own keys, as probed on Claude Code 2.1.312's
dialogs. `keys.ts` `answerSteps` is the one builder, table-tested by tool:

| Dialog | Answers | Keys |
|---|---|---|
| A permission: Bash, Edit, Write, Read, WebSearch, an MCP tool | Yes · option 2 · No · Yes, and tell Claude · No, and tell Claude | `1` · `2` · Esc · Tab, paste, Enter · Up, Tab, paste, Enter |
| A permission: WebFetch | Yes · option 2 · No | `1` · `2` · Esc |
| A permission: any other tool | Yes · No | `1` · Esc |
| One question | an option · something else · Cancel | its digit · N+1, paste, Enter · Esc |
| Several questions | Submit · Cancel | a digit per question, then `1` on the Submit tab · Esc |
| One multi-select question | Submit · Cancel | the options' digits, Tab, `1` · Esc |
| A plan | Approve, and review each edit · Keep planning · Reject | Up, Up, Enter · Up, paste, Enter · Esc |
| An MCP form or address | none: the terminal answers it | |

- **Option 2** is offered only when every entry of Claude's suggestion list is
  one the probes saw, in their shape: `addRules` that allow, `addDirectories`,
  or `setMode` to accept edits. Its label names the first entry's kind (the
  dialog's own wording varies), and under it the card lists, as text,
  everything it grants (each rule, such as `Bash(sh)`, each directory, the
  mode) and where it is saved (this session, the project's local settings,
  and so on). A `curl … | sh` command's option 2 allows every `sh` command,
  and the card says so. With an empty list, a flagged command's row 2 is
  "switch to auto mode"; under an MCP `ask` rule the list is absent though the
  dialog has a row 2.
- **No, and tell Claude** goes Up, not Down: Up on row 1 wraps to the last row,
  No, whatever the row count, and Tab there opens its field. WebFetch has no
  text answer (Tab does nothing there and a paste is swallowed), and a tool
  nobody probed gets Yes and No only.
- **A plan never gets a digit.** Its row 1 varies (auto mode, bypass
  permissions, clearing the context, auto-accepting edits), while Up, Up is
  "manually approve edits" in every variant probed. Approving into auto mode
  is left to the terminal.
- **Questions.** "Type something." is row N+1, except in the preview layout,
  which has none. The preview layout was probed as one single-select question
  only, so several questions or a multi-select one that carry previews get
  Cancel only, as does a question with more than nine options.

**How far the card trusts the dialog.** Each answer needs a level
(`trust.ts`), and the card offers only the answers its level reaches: `reject`
(a lone Esc: No, Cancel, Reject), `basic` (also a digit that picks: Yes, an
option), `lone` (also option 2) and `full` (every answer, the key sequences
included). Everything known about the dialog sets a limit; the lowest wins,
and the card says why its other answers are missing.

- **Not the one on screen, or gone: `none`.** A dialog recorded while the one
  before it was still open (`PendingPrompt.stacked`, docs/terminals.md) may be
  behind another one on screen. A dialog Claude's own signs say has closed
  (`closedAtMs`: a status-line render after it, or its own call finishing)
  reads as the turn going on, so the card goes away.
- **Input to the pane.** `inputWatch` notes when input reached each pane
  through its one writer, never what, and leaves out the focus reports the
  terminal sends by itself (a face switch makes one).
  - Input from 1 s before the dialog's hook on may already have answered it
    (Claude draws a dialog about 50 ms before its hook lands, longer under
    load): `none`. So does a pane this page wasn't watching then (an app
    restart, a reload, a re-attach).
  - Input 1 to 2 s before leaves `lone`: a key pressed in the terminal can
    turn a sequence into another answer (after one Down, "Up, Tab" opens the
    Yes field instead of No's), while a lone digit still picks its own row.
  - A card's own answer keys don't count against the next dialog: they went
    to the dialog the record showed, and the last of them closed it.
- **The Claude Code release.** `full` on 2.1.312, where the keys were probed,
  and its later 2.1 patches; any other release gets `lone`.
- **The permission mode**, for a tool's dialog: `full` in default and accept
  edits mode (probed alike); any other mode gets `basic`.
- **A payload cut to fit** gets `reject`: it can't be approved from a card
  that doesn't show all of it.
- **No `claude` seen in the pane yet**: `none`.

**Typing it.** Each key is a write of its own, 300 ms apart (the dialogs were
probed with 300 to 600 ms between keys); an Enter behind a paste waits as
Send's does, and nothing follows an Esc for 100 ms. No clear goes first. The
record is read afresh before the first key and before the last: the same
session, the same stored dialog (`recordedAtMs`), neither stacked nor closed,
the displayed state still the dialog's, the same pane and `claude` process,
and no interrupt since. The first read also checks the pane's input, as
above. Switching to the terminal, or the view going away, gives up the keys
not yet typed.

**Once per dialog.** An occurrence is the session and its dialog's
`recordedAtMs`, kept outside the card in memory (`answerStore`), so a remount
or a face switch can't answer twice: a second key would answer the next
dialog, which Claude draws 33 to 54 ms after the first is answered. A card is
inert for its first 600 ms, so a double click lands on nothing when the next
dialog's card takes the answered one's place, and that card says "New
request". After an answer the card says "Sent:" and the answer; if 5 s pass
with nothing new recorded, it says so and points to the terminal, and retries
nothing. An answer stopped part-way leaves the dialog in a state nothing here
can know, so the card offers nothing more for it; one stopped before its first
key can be given again. While the card has the keyboard, a digit picks the row
that has it, and those are always Claude's own digits: Yes is 1, option 2 is 2,
a question's options are 1 to N and "Something else…" is N+1. No, the tell
rows, Cancel and a plan's rows have none, and Esc in a text field closes the
field without answering.

## Limits

What the record and the hooks cannot give, and what stands in:

| Missing from the record | What the view does |
|---|---|
| Token streaming (a message lands whole, once its tools are dispatched) | The reply line by line from the `MessageDisplay` hook, in sessions launched while the Conversation switch was on, until the message lands; otherwise the message when it lands |
| A pending permission prompt, question or plan approval (not on disk until answered) | The `PermissionRequest` hook stores the dialog's payload and its card answers it with the dialog's own keys (a background subagent's dialog too, which also marks its parent). An MCP form or address, and a row with no payload, are answered in the terminal |
| An answer to a dialog, from anywhere (no hook records one; an approved tool fires nothing until it ends, an Esc nothing at all) | Claude's status line renders 65-120 ms after a dialog closes and never while one is up, and the dialog's own call reports when it ends: either closes it (`closedAtMs`) and the card goes away. Send comes back 2 s after the call's own end (`callEndedAtMs`), never on a render alone, and Stop 2 s after either. When the next dialog draws first, the render is dropped and the next dialog's hook replaces the record |
| Which of several dialogs is on screen (parallel calls and a background subagent fire every `PermissionRequest` at once; the screen's `1 of 2` is in no payload, and the order differs by tool) | A stacked dialog gets no answers on its card; it is answered in the terminal. A serial dialog whose hook beats its predecessor's `PostToolUse` reads stacked too, until the next render |
| A permission dialog queued behind an MCP form | It is recorded stacked, and the form's answer (`ElicitationResult`) and notices leave a permission dialog on record, so it gets no card and Send stays held until it is answered in the terminal |
| A notice from a modal with no hook of its own (the classifier's billing notice) over a dialog on record | The row reads waiting: Send stays held and the card offers nothing |
| A turn Claude starts by itself (a background task's notification) while a subagent's dialog is up: `UserPromptSubmit` doesn't say who started the turn | The new turn's write clears the dialog on record, so Send's fresh checks can't see that dialog (the accepted risk) |
| An MCP form recorded behind a permission dialog, answered while the permission dialog stays up (if the two can be answered out of order; not probed) | The form's answer clears the row, so the permission dialog is not on record and Send's fresh checks can't see it (the accepted risk) |
| A message Claude takes from its queue (no hook fires at delivery) | The transcript's queue records: the turn shows it queued, delivered, or taken back, and the dot reads a delivered turn as working (docs/terminals.md) |
| An API error Claude is retrying (up to about 3 minutes; no hook meanwhile) | The dot decays to idle after 30 s quiet; `StopFailure` then ends the turn with a notice naming the error |
| An Esc before Claude's first reply (Claude puts the prompt back in its input; nothing is written and no hook fires) | After the user's own Stop, the composer puts the message back in the box and says so; the next send's clear replaces Claude's copy |
| Whether a background subagent is about to ask for permission | Send stays on while background agents work. Once the subagent's `PermissionRequest` has landed, the fresh check before the Enter drops it; in the ~50 ms before, the Enter would confirm that dialog (the accepted risk) |
| Whether history search (Ctrl+R) or a menu without a hook is open in the terminal | Nothing: the keys go there (the accepted risk). A message that never reaches the transcript is marked as not shown after 20 s idle |
| Live tool progress | Start and end only |
| The context window and live cost | The status line's numbers, as the status bar shows them |
| Todo lists on current models (TodoWrite is off by default) | Shown when present |

## Not yet

- **Codex.** Its interactive face is planned as a native chat on a santree-owned
  `codex app-server` child — what that protocol exists for — rather than a record
  reader; it will need its own COMPLIANCE.md exception, since santree has no
  Codex control plane today.
- **Daedalus sessions** are not read live, so the Conversation face is not
  offered on a Daedalus project's tabs.
