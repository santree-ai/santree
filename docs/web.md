# The Web tab

The source of truth for santree's in-app browser: a Web tab in any strip (Trees,
Reviews' checkout, Triage), its page, and how the page lives beside the app's own
webview. Read this before touching `src-tauri/src/browser/`, `src/features/web/`
or `src/lib/overlays.ts`.

---

## The shape

A Web tab is a `worktree_tabs` row (`kind = 'web'`, its `url`), opened from the
"+" menu (key 4), from a link clicked in one of the surface's terminals, or by a
page (a popup, `target=_blank`, ⌘-click). Its **page is a native `WKWebView`**
that the backend creates per tab and lays over the tab's placeholder in the
window. The tab renders a toolbar and that placeholder; everything else is the
page's.

```
React: WebTabPane ── toolbar (DOM) + placeholder <div>
         │  browser_show / browser_place (CSS rect)      ▲ BrowserChanged, BrowserShortcut,
         ▼                                               │ BrowserPointerDown, BrowserOpened…
Rust:  browser::native ── Host (NSView over the app's webview)
                             └─ Slot per tab ── PageView (WKWebView subclass) + Delegate
```

**Why not a Tauri webview.** Tauri injects every plugin's init script into each
webview it creates. Two of santree's would change any website: the opener plugin
takes over `target=_blank` clicks and calls IPC the website is refused, so the link
does nothing; the dialog plugin replaces `window.alert`/`confirm` with IPC calls
that fail the same way. A WKWebView made with objc2 loads a page the way Safari
would: no Tauri IPC, no app scripts, a cookie store of its own.

**Why not an iframe.** Most sites refuse framing, and WebKit blocks their
cookies as third-party inside one.

## The page

- **One shared cookie store** for every local Web tab:
  `WKWebsiteDataStore(forIdentifier: LOCAL_PROFILE)`, apart from the app's own
  webview storage. macOS 14+ (`browser_supported`); older systems say so in the
  menu and open links in the default browser.
- **User agent** names the installed Safari (`Version/<x> Safari/605.1.15`): a bare
  WKWebView's has no Safari token and Google Workspace turns it away.
- **Popups need a click** (`javaScriptCanOpenWindowsAutomatically = NO`; macOS's
  default is YES). A popup and a `target=_blank` link open a Web tab beside their
  opener, made from WebKit's own configuration so `window.opener` keeps working
  (OAuth popups report back through it; an empty `window.open('')` is
  `about:blank`, which they point at the provider after). A popup no tab adopts
  within 20 s is closed. ⌘- and middle-click open a tab behind (WebKit reports a
  middle click as button 4). A page calling `window.close()` closes its tab.
- **Navigation** is http, https and `about:blank` from santree's side
  (`address::checked` gates every URL from IPC or the DB); a page may also show a
  `blob:` it made, but not become a top-level `data:` page. A link to another app
  (`mailto:`, `slack:`) opens it only after the user really acted on the page in
  the last 2 s (`PageView::note_input` — WebKit's own "link activated" is earned
  by a script's `a.click()`), and only after asking, Cancel the default; `file:`
  never.
- **Saved addresses carry no credentials** (`address::persistable`, tested): no
  user:password, no credential-named query parameter, no key-value fragment, and
  nothing past the path on a local host — `codex login` lands its `id_token` in
  `localhost:1455/success?…`, and santree stores no agent's credential.
- **Native panels**: `<input type=file>` (NSOpenPanel); `alert`/`confirm`/`prompt`
  as sheets headed "<host> says" with a globe, answered as dismissed when the
  page is hidden; downloads to ~/Downloads with Gatekeeper's quarantine set, only
  within a minute of the user acting on the page; camera and microphone denied;
  Inspect Element on right-click.
- **An address that doesn't open** (`BrowserFailure`) stands in front of the
  page before it, as a browser's error page does: the address bar shows it, the
  pane says why (nothing running there, no such host, offline, too slow, or
  WebKit's words), Back returns to the page behind it and Reload tries the
  address again. WebKit never commits a failed load, and by the time it reports
  one it is naming the previous page as the page's URL again — so the failure
  keeps the address from the error, and `nav` gives Back and Reload those
  meanings while it is up (measured: Reload would reload the page before it, and
  on a tab whose first page failed it does nothing). The failure stays up while
  the next load runs and goes when a page commits.
- **A crashed page** shows "This page stopped working" and Reload. The view is
  never replaced inside `webViewWebContentProcessDidTerminate` (that crashes
  WebKit).

## Placement and overlays

The page sits *above* the app's webview, so the frontend places it and keeps it
out of the way:

- Every rectangle and hole from IPC is held to one a window could have
  (`browser::checked_rect`, at most 32 holes): AppKit turns a huge one into NaN
  geometry, which aborts the app.
- `useBrowserPage` shows the page on the placeholder's rect when the tab mounts,
  moves it on resize, window resize, scroll and `RELAYOUT_EVENT` (one IPC per
  animation frame, only when it moved), and hides it when the tab unmounts. The
  backend multiplies the CSS rect by the app webview's `pageZoom` and snaps it to
  pixels. A page is never recreated by moving its tab between splits.
- When the app's own webview reloads, every page is hidden (`browser::hide_all`,
  from `on_page_load`) until its tab mounts and shows it again; otherwise a page
  would stay up over whatever the reloaded app shows.
- **Overlays register** in `lib/overlays.ts`: `Dropdown`, `PositionedMenu`, every
  modal through `useModalA11y` (plus `WorktreeGate`), the toast viewport while it
  has toasts, and the split workspace's drop preview. While any is open, a shown
  page checks once per animation frame:
  - an overlay **crossing** the page is cut out of it (`browser_set_holes`): an
    even-odd mask on the slot's layer and a hit test that lets clicks through;
    overlapping holes are merged (`browser::disjoint`) so even-odd can't fill
    them back in;
  - an overlay **covering** it (a modal) has the page swapped for a still:
    `browser_snapshot` while the page still shows, drawn under it, then the page
    hidden; undone in the opposite order. A generation counter drops a still that
    lands after its modal closed.
- A new overlay built from those shared pieces is covered without knowing any of
  this. One that isn't must call `useOverlay`/`useModalOverlay` itself.

## Keys and focus

A page holding AppKit's first responder gets every keystroke; the app's webview,
where santree's shortcuts listen, gets none. So:

- **⌘-chords** pressed in a page go through `browser::keys::route` (tested):
  editing chords and anything else stay the page's (⌘B still bolds); ⌘Q/⌘W/⌘H/⌘M
  go to the native menu; ⌘R, ⌘[, ⌘], ⌘+/−/0 are done natively on the page; ⌘T,
  ⌘K, ⌘L, ⌘1–9, ⌘, ⌘; ⌘/ ⌘⇧R are santree's, sent as `BrowserShortcut` and
  replayed as a keydown on the app's `document.body` after the app takes the
  keyboard back (`browser_release_focus`) — ⌘L focuses the tab's address bar.
- **A page takes the keyboard** only when a click lands on it (the window's own
  hit test, so not through a hole or under another page) or when picked
  (`browser_focus`, which waits until a hidden page is shown) — never because it
  focused one of its own fields: a background tab's autofocus would steal typing.
- **A click in a page** sends `BrowserPointerDown`: the app dispatches a
  `pointerdown` on its body (so its menus' outside-click handlers close them) and
  activates the tab's split group.

## Resources

Pages are made on first show. A hidden page keeps running, throttled by WebKit.
Past `AWAKE_HIDDEN` (4) hidden pages, the one hidden longest is put to sleep —
closed, keeping its URL and WebKit's `interactionState` (its back/forward list;
measured, it doesn't bring the scroll back) — and wakes on that page, at its
top, when its tab shows again. A page loading or downloading is never put to
sleep. The page a tab shows is written to its row, settled first
(`browser::remember`), so a restart reopens it.

## Links and hosts

A link clicked in a terminal opens in a Web tab of the surface that terminal is on
(`features/web/links.ts`, by its term key), in the tab already on that site when
there is one — one that failed to open it (a dev server not up yet) and one
restored from the last session and not shown since count, the latter's page made
on the spot (`native::load`) — and ⇧-click opens the default browser. Each strip
registers the
surfaces and Web tabs it shows (`useStripWebHost`), which is also where a page's
popups and self-closes land. A Daedalus pane's links always go to the default
browser.

## Daedalus

Web tabs are **off for Daedalus projects** until the browser can browse from the
box: opening one from this Mac would quietly put `localhost` on the wrong
machine. The plan, measured on macOS 26:

- WebKit **never** sends `localhost`, `127.0.0.1`, `::1` or `localhost.` through a
  proxy, whatever `proxyConfigurations` says.
- So a Daedalus page needs a per-box `WKWebsiteDataStore` with a SOCKS5 proxy
  (server-side DNS) for everything else, **and** same-port loopback listeners on
  this Mac tunnelling to the box's localhost (bound without `SO_REUSEADDR`;
  refuse a port already taken here rather than remap it).
- Both ride one new protocol-v1 stream, `net.open {host, port}`, dialed on the
  box (docs/remote.md), on the santree side and Daedalus's session host.

## Cookie import

Settings → Web imports cookies from another browser on this Mac into the Web
tabs' own store, per site the user picks, so a page here opens signed in
(`src-tauri/src/browser/import/`). It runs only on the user's click.

- **Sources** are the browser profiles found under `~/Library/Application
  Support` (`import::sources`): Chromium-family (Chrome, Arc, Brave, Edge,
  Vivaldi, Opera, Chromium) and Firefox. Picking one lists the sites it has
  cookies for (`browser_cookie_sites`), used-last first; no cookie value is read
  and no Keychain is touched to list them.
- **A site** is a host standing for itself and every subdomain with cookies
  under it. Sites are grouped under the shortest parent host that has cookies of
  its own (`site_of`) — a browser refuses a cookie for a public suffix, so
  `co.uk` and `github.io` are never hosts to group under, and no suffix list is
  needed.
- **Reading** copies the browser's cookie file (with its `-wal`/`-journal`) to a
  private temp dir first, since the browser holds the original open. Chromium
  values are encrypted: the key is derived (PBKDF2-HMAC-SHA1, salt `saltysalt`,
  1003 rounds) from the browser's `"<Browser> Safe Storage"` secret in the login
  Keychain — so an import asks macOS for that one item — then each value is
  AES-128-CBC decrypted (a 16-space IV), and on store version ≥ 24 its SHA-256
  host-key prefix is checked and dropped. A value that doesn't decrypt is
  skipped, never guessed. Firefox keeps cookies in plain text. Cookies in a
  container or set inside another site's frame (partitioned) are left out.
- **Writing**: each cookie becomes an `NSHTTPCookie` set on the shared store's
  `httpCookieStore` (`native::import_cookies`), keeping its expiry, Secure,
  HttpOnly and SameSite. The result says how many went in and how many were
  skipped. A value only ever goes from the browser's file to WebKit — nothing of
  a cookie is logged or saved anywhere else.

## Not built

Agent tools (the user deferred them: no MCP browser tools), find in page,
favicons, permission prompts beyond the defaults, HTTP basic auth, restoring
back/forward history across restarts.

## Prior art

Researched 2026-10-26: cmux (native WKWebView — the model for hosting, keys,
popups and WebKit pitfalls), Superset (tried a native view over its UI and went
back to Electron's `<webview>` within a day over overlays), Orca (its docked
DevTools is the same native-over-HTML problem: hide under overlays, show a
still), Wave, VS Code (remote: per-port forwarding, now an experimental proxy),
Playwright and agent-browser (the agent contract, for when agent tools come).
