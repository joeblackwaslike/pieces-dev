# Pieces Monitor — menu-bar (Swift app) design

> Downstream spec of the Pieces Monitor platform core. Covers the native macOS menu bar
> frontend only. The daemon, SDK, CLI, and dashboard are specified elsewhere in this
> directory.

## Context

The Pieces Monitor platform core (see `2026-06-10-pieces-monitor-core-design.md`) is a
headless Node/TS daemon bound to `127.0.0.1:4747`, exposing an HTTP/WS API that three
interchangeable frontends render: a native Swift menu bar app, a browser dashboard, and the
`pmon` CLI. This spec is the menu bar app.

The motivating disaster for the whole project — a dual-instance launchd race that wiped the
CouchBase Lite DB with no early-warning signal — drives the single most important job of this
frontend: surface the daemon's overall health rollup as an always-visible status color in the
macOS menu bar, so a `crit` state (corruption suspected, auth lost, Pieces down) is seen
immediately rather than discovered after the fact.

A second piece of context is the historical "authenticate every day / keychain nag" pain from
the older Python babysitter era. That pain is **not** an auth-logic problem to solve in this
app — it is a code-signing problem. An unsigned or ad-hoc-signed binary changes identity on
every rebuild, so macOS keychain ACLs and TCC permission grants reset constantly and the OS
re-prompts. A stable **Developer ID signature + notarization with a fixed Team ID** gives the
app one durable code identity, so granted permissions stick. This is noted again under
signing.

## Platform assumptions (the daemon API it consumes; thin-client principle)

The app is a **thin client**. It contains no monitoring logic, no extension awareness, and no
business rules. It renders a server-authored model and dispatches user intent back to the
daemon. Everything below is provided by the platform core and assumed stable here.

Endpoints consumed (all on `http://127.0.0.1:4747`, loopback only):

- `GET /status` — overall rollup (`ok` / `warn` / `crit`) plus per-check detail. Drives the
  status icon tint and a quick at-a-glance summary.
- `GET /menu` — the **menu model**: a JSON document with an overall status color, an ordered
  list of `MenuSection`s, each holding `MenuItem`s with typed actions
  (`open-url`, `run-action`, `deep-link`). This is the entire visible menu; the app renders it
  verbatim.
- `WS /events` — live push of status/menu/incident/log/notification updates. Lets the app
  re-render without polling and receive notification requests.
- `POST /actions/:id` — dispatch a registered command (a `run-action` item). State-changing,
  so it requires the bearer token.

Auth model: read-only GETs are open on loopback. State-changing endpoints
(`POST /actions/:id`) require a bearer token read from a `chmod 600` file under
`~/Library/Application Support/PiecesMonitor/`. The browser dashboard uses a same-origin CSRF
token instead; the menu bar app and CLI use the file token.

Thin-client principle, restated for emphasis: **"an extension contributes a menu item" means
that extension registers a `MenuSection` server-side. The Swift app never changes.** Shipping
a new extension that adds menu items, actions, or deep-links requires zero menu-bar releases.
The app's job is render + dispatch, nothing more.

## Purpose & scope

In scope (v1):

- An `LSUIElement` agent app with a single menu bar status item, no dock icon, no main window.
- Render `GET /menu` into a native `NSMenu`, refreshed live over `WS /events`.
- Tint the status item icon from the rollup color (green / yellow / red).
- Fire the three item action types: `open-url`, `deep-link`, and `run-action`
  (`POST /actions/:id` with the bearer token).
- Own native rich notifications via `UNUserNotificationCenter`, driven by notification
  requests pushed from the core notify service over WS.
- A robust **offline / daemon-down** state (distinct red/dim icon, "daemon not running" item).
- Single-instance, launch-at-login.

Out of scope (v1):

- No native settings window — Settings opens the dashboard settings page (see Settings).
- No monitoring, scheduling, dedup, or rate-limiting logic — all server-side.
- No extension-specific UI knowledge.
- No keychain usage (see below).

## Design

### Framework choice (Swift native; MenuBarExtra vs NSStatusItem; LSUIElement; login item; single-instance)

**Native Swift, not Electron/Tauri.** Decision already locked. A menu bar status item is a
tiny, always-resident surface; an Electron runtime per status item is disproportionate memory
and a second auto-updater to manage. Native Swift gives a small, fast, OS-idiomatic agent and
the cleanest path to Developer ID notarization with a stable identity. The app links no daemon
code — it speaks the same HTTP/WS API the CLI and dashboard use.

**`NSStatusItem` (AppKit), recommended over SwiftUI `MenuBarExtra`.** Reasoning:

- The menu is **fully dynamic and server-authored** — an arbitrary, changing tree of sections,
  items, separators, submenus, and per-item icons/states derived from `GET /menu` and live WS
  updates. `NSStatusItem` + `NSMenu` built programmatically is the natural fit for rebuilding a
  menu from a data model on every change, including fine control over enabled/disabled state,
  attributed titles, item images, key equivalents, and submenu nesting.
- `MenuBarExtra` is simpler but is geared toward statically-declared SwiftUI menu content. Its
  `.menu` style maps awkwardly to a model that changes shape at runtime, and the `.window`
  style is a different interaction than the standard click-to-drop menu we want. Dynamic
  rebuild, custom icon tinting via `NSImage` template rendering, and precise control of the
  status button are all more direct in AppKit.
- The app can still be a SwiftUI `App` lifecycle host (or a plain AppKit `NSApplication`); the
  status item and its menu are managed by an AppKit controller either way. SwiftUI may be used
  later for any auxiliary window (e.g. an eventual native settings panel) without changing the
  menu implementation.

**`LSUIElement = true`** (agent app): no dock icon, no app menu bar, no window on launch. The
only presence is the status item.

**Login item:** register with `SMAppService.mainApp` (the modern, user-visible-in-Settings
replacement for the deprecated `SMLoginItemSetEnabled`). A menu toggle ("Launch at login")
flips it; default on after first run. The daemon itself runs as a separate launchd `KeepAlive`
agent — the app launching at login simply means the status item reappears after reboot.

**Single-instance:** on launch, attempt an exclusive lock (a `flock` on a lockfile under
`~/Library/Application Support/PiecesMonitor/menu-bar.lock`, or a named distributed lock). If
already held, the second instance brings nothing to foreground (it has no window) and exits
cleanly. This mirrors the daemon's own single-instance discipline and prevents two status
items.

### Daemon integration (status/menu/events/actions; token handling; menu-model rendering; status icon tinting)

**Transport: WS subscription primary, polling fallback.** On launch the app:

1. Reads the bearer token file (see token handling).
2. Fetches `GET /status` and `GET /menu` once to paint the initial state immediately.
3. Opens `WS /events` and subscribes. Thereafter, status/menu changes arrive as pushes and the
   app re-renders; no steady-state polling.

If the WS connection cannot be established or drops, the app falls back to a **low-frequency
poll** of `GET /status` + `GET /menu` (e.g. every 5 s) with exponential backoff on the WS
reconnect attempts. WS push is the steady-state path; polling exists only to (a) survive a
daemon restart and (b) detect the daemon coming back after being down. This keeps idle CPU and
wakeups near zero while remaining live.

**Menu-model rendering.** The `GET /menu` document is mapped to `NSMenu`:

- Top of menu: a header reflecting overall status (text + colored dot) from the rollup.
- Each `MenuSection` → a labeled group with a leading separator (and an optional section title
  as a disabled header item).
- Each `MenuItem` → an `NSMenuItem`. The item carries its action descriptor as `representedObject`
  so the single target/action handler can dispatch by type:
  - `open-url` → `NSWorkspace.shared.open(url)`.
  - `deep-link` → handle a `piecesmonitor://…` custom scheme (registered by this app) and/or
    `open -a "Pieces"` to bring the Pieces app forward, depending on the link target. Dashboard
    deep-links open the dashboard URL in the browser.
  - `run-action` → `POST /actions/:id` with the bearer token (see below). Show a transient
    state (disabled + spinner-ish title) until the response, then surface success/failure via a
    notification or a brief item state.
- Standard footer items the app always appends locally: "Open Dashboard", "Launch at login"
  toggle, "Quit". These are app-level concerns, not server menu content. ("Open Dashboard" is
  effectively a built-in `open-url` to `http://127.0.0.1:4747/`.)
- The menu is rebuilt from the latest model on each WS update; an open menu is left intact and
  refreshed on next open to avoid yanking items out from under the cursor.

**Status icon tinting.** The status item uses a single **template `NSImage`** (a glyph) so
macOS handles light/dark menu bar appearance, with the rollup color applied as a tint /
overlay dot:

- `ok` → green
- `warn` → yellow
- `crit` → red
- daemon unreachable → a distinct **dim/hollow red (or gray) "disconnected"** glyph, visually
  different from `crit` so "daemon is down" is not confused with "a check is critical".

The icon updates on every rollup change pushed over WS (or seen via the poll fallback).

**Token handling.** The app needs the bearer token only for `POST /actions/:id`. It reads the
token from the `chmod 600` file under `~/Library/Application Support/PiecesMonitor/` at launch
and caches it in memory. If a `run-action` returns `401`, the app re-reads the file once (the
daemon may have rotated it) and retries; if it still fails, it surfaces a clear error. The
token is never written to disk by the app and never logged.

**No keychain.** Because the token lives in the daemon's local, permission-restricted file and
the app reads it directly, the menu bar app needs **no Keychain access at all**. This sidesteps
the historical keychain-nag pain entirely: there is no per-app secret to store, and with a
stable Developer ID identity there are no repeated keychain ACL prompts. (Contrast the old
babysitter, which held Pieces credentials itself.)

### Notifications ownership (native UNUserNotificationCenter + core notify as routing brain; the WS contract)

**Recommendation: the Swift app owns presentation; the core notify service owns the decision.**
This splits cleanly along the thin-client line and gives the best of both:

- **Core `notify` service = the brain.** It already dedups, rate-limits, and routes; extensions
  only *request* notifications and core decides whether/how to fire. Keeping that logic
  server-side means every frontend benefits and there is one consistent policy. (The core spec
  currently posts via `osascript`; this app supersedes that path on macOS when the menu bar app
  is connected — see contract.)
- **Swift app = native presentation.** `UNUserNotificationCenter` gives rich notifications with
  **action buttons** (`UNNotificationAction`) that can deep-link, grouping/threading, sounds,
  and proper Notification Center history — none of which the `osascript` path can do well. The
  app registers notification categories and handles button taps.

**The WS contract.** Over `WS /events`, the core notify service pushes a `notify` message when
it decides a notification should fire. The app translates it into a `UNNotificationRequest`.
Suggested shape:

```jsonc
{
  "type": "notify",
  "id": "ntf_01H...",            // server id, used for dedup + delivery ack + dismissal
  "category": "incident",       // maps to a registered UNNotificationCategory
  "title": "Pieces OS down",
  "body": "watchdog: process exited; restart attempt 2 failed",
  "actions": [                   // each becomes a UNNotificationAction button
    {
      "id": "open-incident",
      "title": "View incident",
      "deepLink": "piecesmonitor://incident/inc_01H..."   // or an https/dashboard URL
    },
    {
      "id": "restart-pieces",
      "title": "Restart Pieces",
      "runAction": "watchdog.restart"   // dispatched via POST /actions/:id with token
    }
  ],
  "sound": "default",
  "expiresAt": "2026-06-10T12:00:00Z"   // optional auto-withdraw
}
```

App behavior on receipt:

- Build a `UNNotificationCategory` per distinct `category` (lazily, the first time seen) with
  the listed actions, then post a `UNNotificationRequest` keyed by `id`.
- On an action button tap (`UNUserNotificationCenterDelegate`): a `deepLink` is opened like a
  menu `deep-link`; a `runAction` is dispatched via `POST /actions/:id` with the bearer token,
  exactly like a menu `run-action`.
- On the default tap (body), open the notification's primary deep-link if present, else open the
  dashboard.

**Acks and dedup boundary.** Dedup/rate-limit remains entirely server-side keyed by the
notify service; the app does **not** re-implement it. The app may optionally send a small WS
ack (`{ "type": "notify-ack", "id": "ntf_…", "delivered": true }`) so core can record delivery
and avoid double-firing across frontends (e.g. if both menu bar and dashboard are open, core
chooses one presenter). The app also honors a server `notify-withdraw` message (by `id`) to
remove a stale notification from Notification Center.

**Permission.** The app requests notification authorization on first run via
`requestAuthorization`. If denied, notifications silently no-op on the app side and core may
fall back to its `osascript` path; the menu bar status color still conveys severity regardless.

### Settings (open dashboard in v1)

v1 has **no native settings window.** The "Settings…" menu item is an `open-url` to the
dashboard settings page (`http://127.0.0.1:4747/` settings route). Rationale: the config store
is server-side and schema-driven, and extensions register their own settings; the dashboard
already renders all of it from one source of truth. Building a parallel native settings UI
would duplicate that and drift.

Later option (noted, not built): a native SwiftUI settings window for app-local preferences
that genuinely belong on the client (launch-at-login, notification sound/quiet hours,
poll-fallback interval, status-icon style). Anything server-owned stays in the dashboard.

### Signing, notarization & packaging (Developer ID, self-sign interim, xcodebuild, login item)

- **Project type:** a SwiftPM/Xcode project at `packages/menu-bar` (an Xcode `.app` target, not
  a pnpm package). It is excluded from the pnpm workspace build; its build is `xcodebuild`.
- **Build:** `xcodebuild -scheme PiecesMonitor -configuration Release` producing
  `PiecesMonitor.app`. Hardened Runtime enabled. Entitlements limited to what is actually used
  (network client for loopback; user notifications). No keychain entitlement needed.
- **Signing — target state:** **Developer ID Application** signature + **notarization** with a
  **stable Team ID**. This gives the app one durable code identity so that granted permissions
  (notifications, login item, any TCC grants) persist across rebuilds and updates — directly
  fixing the historical "re-authenticate / keychain nag" churn caused by changing code
  identity. Flow: `codesign --options runtime --timestamp` → `xcrun notarytool submit … --wait`
  → `xcrun stapler staple PiecesMonitor.app`.
- **Signing — interim (until the Apple Developer account is active):** **self-sign locally**
  with an ad-hoc or local development identity for Joe's own machine. Functional for personal
  use; will trip Gatekeeper on other machines and will not have the stable-identity benefit
  until the real Developer ID cert is in place. Document this as a known interim limitation, not
  a design choice to keep.
- **Distribution / install:** ship the notarized `.app`; install into `/Applications` (or
  `~/Applications`) and register as a **login item** via `SMAppService.mainApp` on first run.
- **Token file access:** reads the `chmod 600` token from
  `~/Library/Application Support/PiecesMonitor/`. Same-user access, so no special entitlement;
  the file's mode plus loopback binding is the security boundary.

## Open questions

- **Notify presenter election.** When both the menu bar app and the dashboard are connected,
  how does core pick a single presenter to avoid double notifications? Proposed: app sends a
  `notify-ack`; core prefers the menu bar when present. Needs the exact election rule pinned
  down in the notify service spec.
- **Custom scheme vs https for deep-links.** Should deep-links use a `piecesmonitor://` scheme
  the app registers, the dashboard `http://127.0.0.1:4747/…` URL, or both depending on target?
  Affects which links the app handles internally vs hands to the browser.
- **Daemon-not-installed vs daemon-down.** Distinguish "daemon binary/launchd agent not
  installed yet" (offer install/help) from "installed but currently down" (offer start, if the
  app is even allowed to start it). Does the app get a `run-action` to start the daemon, or is
  that strictly launchd's job?
- **`run-action` result feedback.** Inline menu item state vs a result notification vs both —
  what is the standard UX for a dispatched command's success/failure?
- **Status item overflow.** Behavior when the menu bar is full and macOS hides the item (Sonoma+
  menu bar management) — any fallback affordance needed?
- **Auto-update.** Out of scope for v1, but how will the notarized app update later — Sparkle,
  or rely on a separate installer? Affects whether a second signing/feed identity is needed.

## Verification (manual)

- **Status colors:** drive the daemon rollup to each state and confirm the menu bar glyph
  tints correctly — `ok` green, `warn` yellow, `crit` red — and updates live over WS without a
  manual refresh.
- **Offline-daemon "red" state:** stop the daemon; confirm the icon switches to the distinct
  **disconnected** glyph (not the `crit` glyph), the menu shows a "daemon not running" item,
  and the app reconnects automatically (icon returns to the live rollup) when the daemon comes
  back, via the poll fallback.
- **Menu rendering:** with sections/items registered server-side, confirm the `NSMenu` mirrors
  `GET /menu` (sections, separators, item titles/icons/enabled state) and that adding a server
  `MenuSection` shows new items with **no app rebuild**.
- **Menu actions:** click an `open-url` item (opens browser), a `deep-link` item (brings Pieces
  forward / opens dashboard route), and a `run-action` item (confirm `POST /actions/:id` fires
  with the bearer token, returns 200, and the daemon executes the command). Confirm a token
  failure path: invalidate the token file, click `run-action`, see the re-read-then-error
  behavior.
- **Notification deep-links:** have the core notify service push a `notify` message with action
  buttons; confirm a rich native notification appears with the buttons, the default tap opens
  the primary deep-link, a `deepLink` button opens the target, and a `runAction` button
  dispatches via `POST /actions/:id`. Verify a `notify-withdraw` removes a posted notification.
- **Agent behavior:** confirm no dock icon (`LSUIElement`), launch-at-login toggle persists and
  the status item reappears after reboot, and a second launch exits without a second status
  item (single-instance).
- **Signing:** verify `codesign --verify --deep --strict` passes and (once notarized)
  `spctl -a -vvv PiecesMonitor.app` accepts it; confirm granted notification permission
  persists across a rebuild with the stable Developer ID identity.
