# Changelog

Notes for each release, newest first. The release workflow publishes the
matching `## <version>` section as the GitHub release body **and** as the
"What's new" the in-app updater shows — write plain bullets, no heavy
markdown, because the app renders them as text. A stable tag fails the
release guard without an entry here; a beta without one falls back to a
commit-compare link.

## 0.1.1 — 2026-08-20

- santree now updates itself. Settings → Updates checks your release channel,
  downloads, and relaunches; a background check runs shortly after launch and
  every six hours, announcing new versions with a toast.
- Release channels: Stable gets finished releases, Beta gets every build as it
  ships. The channel is a dropdown in Settings → Updates, and updates only
  ever move forward.
- Linear can be connected read-only. Choose the permissions santree requests
  in Settings → Integrations; everything that writes to Linear — status
  changes, comments, the "move to In Progress" automation — disables itself
  with an explanation when writes aren't available. Flipping to read-only
  applies immediately, no reconnect needed.
- Local GitHub settings are one tabbed card, matching the Agents screen.
- The DMG installer got its background and icon layout back.

## 0.1.0 — 2026-08-19

- First signed, notarized macOS release: one universal DMG (Apple Silicon +
  Intel), built, verified and published entirely from CI.
