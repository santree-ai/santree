# Changelog

Notes for each release, newest first. The release workflow publishes the
matching `## <version>` section as the GitHub release body **and** as the
"What's new" the in-app updater shows — write plain bullets, no heavy
markdown, because the app renders them as text. A stable tag fails the
release guard without an entry here; a beta without one falls back to a
commit-compare link.

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
