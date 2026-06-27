# Pieces Monitor — menu-bar (Swift app) design

> Downstream spec of the Pieces Monitor platform core. Covers the native macOS menu bar
> frontend only. The daemon, SDK, CLI, and dashboard are specified elsewhere in this
> directory.

## Context

The Pieces Monitor platform core (see `2026-06-10-pieces-monitor-core-design.md`) is a
headless Node/TS daemon bound to `127.0.0.1:4747`, exposing an HTTP/WS API that three
interchangeable frontends render: a native Swift menu bar app, a dashboard web app in a native
window (WKWebView), and the `pmon` CLI. This spec is the menu bar app.

The Swift app is **two surfaces in one process**: the native menu bar status item (a native
`NSMenu` rendered from `GET /menu`) **and** a native window (`NSWindow` hosting a `WKWebView`)
that loads the daemon's dashboard web app from the loopback URL. This is the "native shell +
system WebView" pattern (Tauri-like) implemented in Swift/AppKit — **no Electron, no bundled
Chromium**. `WKWebView` is the OS-provided engine. Because that web view is same-origin to the
daemon (`127.0.0.1:4747`), the app injects the bearer token into the web view (cookie/header)
so the embedded dashboard is auto-authenticated and the user never sees an auth prompt — which
strengthens the "no keychain needed" point below.

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
- `GET /settings` — the **settings schema**: per-extension setting definitions (type, label,
  range, enum cases, current value, optional `web` flag, grouping) the native SwiftUI settings
  window renders.
- `POST /settings` — write changed setting values back. State-changing, so it requires the
  bearer token.
- The dashboard web app served at `http://127.0.0.1:4747/` — loaded by the in-app `WKWebView`
  window (auto-authenticated by the injected bearer token).

Auth model: read-only GETs are open on loopback. State-changing endpoints
(`POST /actions/:id`, `POST /settings`) require a bearer token read from a `chmod 600` file
under
`~/Library/Application Support/PiecesMonitor/`. The dashboard web view (and a real browser, if
used) uses a same-origin CSRF token instead; the menu bar app and CLI use the file token.

Thin-client principle, restated for emphasis: **"an extension contributes a menu item" means
that extension registers a `MenuSection` server-side. The Swift app never changes.** Shipping
a new extension that adds menu items, actions, or deep-links requires zero menu-bar releases.
The app's job is render + dispatch, nothing more.

## Purpose & scope

In scope (v1):

- An `LSUIElement` agent app with a single menu bar status item, no dock icon.
- Render `GET /menu` into a native `NSMenu`, refreshed live over `WS /events`.
- Tint the status item icon from the rollup color (green / yellow / red).
- A native **dashboard window** (`NSWindow` + `WKWebView`) that loads the daemon's web app from
  the loopback URL, auto-authenticated by an injected bearer token (no auth prompt).
- Fire the three item action types: `open-url`, `deep-link`, and `run-action`
  (`POST /actions/:id` with the bearer token). `deep-link` navigates the in-app dashboard window
  to the target loopback route.
- A native **SwiftUI settings window** generated from each extension's settings schema fetched
  from `GET /settings`, writing changes back via `POST /settings` (see Settings).
- Own native rich notifications via `UNUserNotificationCenter`, driven by notification
  requests pushed from the core notify service over WS. The app registers as the OS-notification
  presenter on connect so core suppresses its `osascript` fallback.
- A robust **offline / daemon-down** state (distinct red/dim icon, "daemon not running" item)
  that distinguishes not-installed from installed-but-down, and offers a launchd-mediated
  restart (the app never spawns the daemon directly).
- Single-instance, launch-at-login.

Out of scope (v1):

- No monitoring, scheduling, dedup, or rate-limiting logic — all server-side.
- No extension-specific UI knowledge.
- No keychain usage (see below).
- No custom `piecesmonitor://` URL scheme — deep-links navigate the in-app WebView via loopback
  `http` URLs (see Resolved decisions).
- No custom status-item overflow UI (rely on notifications + window + CLI).
- No auto-update mechanism (Homebrew cask preferred when added later).

## Design

### Framework choice (Swift native; MenuBarExtra vs NSStatusItem; LSUIElement; login item; single-instance)

**Native Swift, not Electron.** Decision already locked. A menu bar status item is a tiny,
always-resident surface; an Electron runtime per status item is disproportionate memory and a
second auto-updater to manage. Native Swift gives a small, fast, OS-idiomatic agent and the
cleanest path to Developer ID notarization with a stable identity. The app links no daemon
code — it speaks the same HTTP/WS API the CLI and dashboard use.

The app **is** the native shell for the dashboard, Tauri-style: it hosts an `NSWindow`
containing a `WKWebView` (the OS engine — no bundled Chromium) that loads the daemon's web app
from `http://127.0.0.1:4747/`. This gives a real desktop window for the dashboard without an
Electron runtime, and because the WebView is same-origin to the daemon the app injects the
bearer token (cookie/header) so the embedded UI is auto-authenticated. The window is created
lazily on first open (e.g. "Open Dashboard"), so the idle footprint of the resident agent stays
tiny. Settings, by contrast, is a **native SwiftUI** window — not web — generated from schema
(see Settings).

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
- The app is a SwiftUI `App` lifecycle host (or a plain AppKit `NSApplication`); the status item
  and its menu are managed by an AppKit controller either way. SwiftUI hosts the native settings
  window, and AppKit hosts the `WKWebView` dashboard window — neither changes the menu
  implementation.

**`LSUIElement = true`** (agent app): no dock icon, no app menu bar, no window on launch. The
status item is the only presence at idle; the dashboard window and settings window are opened
on demand and dismissed back to the agent.

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
  - `open-url` → `NSWorkspace.shared.open(url)` (external links to a browser).
  - `deep-link` → the canonical target is a loopback `http://127.0.0.1:4747/…` route; the app
    brings up (or focuses) its own in-app dashboard window and navigates the `WKWebView` to that
    route. No custom `piecesmonitor://` scheme in v1 — the app owns the handler and simply tells
    its own window where to go. (A link whose target is the Pieces app itself may still use
    `open -a "Pieces"` to bring Pieces forward.)
  - `run-action` → `POST /actions/:id` with the bearer token (see below). Feedback is keyed to
    command duration: fast commands show inline menu-item state while the menu is open;
    failures always notify; long-running commands fire a "started" notification, show progress
    in the window, and post a completion notification (see Resolved decisions).
- Standard footer items the app always appends locally: "Open Dashboard" (focuses/creates the
  in-app `WKWebView` window at `http://127.0.0.1:4747/`), "Settings…" (opens the native SwiftUI
  settings window), "Launch at login" toggle, "Quit". These are app-level concerns, not server
  menu content.
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

**Daemon-down vs not-installed, and restart.** When the API is unreachable, the app
distinguishes two cases by probing for the launchd-agent plist alongside the failed API probe:

- **Not installed** (no launchd agent plist present) → the menu offers a setup/install flow
  rather than a restart action.
- **Installed but down** (plist present, API unreachable) → the menu shows a red "daemon
  offline" state and a **"Restart daemon"** action that calls
  `launchctl kickstart -k gui/<uid>/<label>`. The app **never spawns the daemon directly** —
  launchd is its sole supervisor, the same single-launcher principle that prevented the original
  DB-wipe race.

**Bearer-token injection into the dashboard WebView.** When the in-app `WKWebView` window opens,
the app injects the bearer token as a cookie/header scoped to `127.0.0.1:4747` (via
`WKHTTPCookieStore` and/or a request header on the initial load) before navigation. Because the
WebView is same-origin to the daemon, the embedded dashboard is authenticated automatically and
the user never sees an auth prompt. The token is held in memory only (see token handling).

**Token handling.** The app needs the bearer token for `POST /actions/:id` **and** to
auto-authenticate the in-app dashboard WebView (cookie/header injection, above). It reads the
token from the `chmod 600` file under `~/Library/Application Support/PiecesMonitor/` at launch
and caches it in memory. If a `run-action` returns `401`, the app re-reads the file once (the
daemon may have rotated it) and retries; if it still fails, it surfaces a clear error. The
token is never written to disk by the app and never logged.

**No keychain.** Because the token lives in the daemon's local, permission-restricted file and
the app reads it directly — then injects it straight into the same-origin dashboard WebView —
the menu bar app needs **no Keychain access at all** and the embedded UI needs no login flow.
This sidesteps the historical keychain-nag pain entirely: there is no per-app secret to store,
no interactive auth prompt in the dashboard, and with a stable Developer ID identity there are
no repeated keychain ACL prompts. (Contrast the old babysitter, which held Pieces credentials
itself.)

### Notifications ownership (native UNUserNotificationCenter + core notify as routing brain; the WS contract)

**Recommendation: the Swift app owns presentation; the core notify service owns the decision.**
This splits cleanly along the thin-client line and gives the best of both:

- **Core `notify` service = the brain.** It already dedups, rate-limits, and routes; extensions
  only *request* notifications and core decides whether/how to fire. Keeping that logic
  server-side means every frontend benefits and there is one consistent policy. (The core spec
  currently posts via `osascript`; this app supersedes that path on macOS when registered as the
  OS-notification presenter — see presenter election in the contract.)
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
      "deepLink": "http://127.0.0.1:4747/incident/inc_01H..."   // loopback route, opened in-app
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
  menu `deep-link` — the in-app dashboard window is focused/created and the `WKWebView`
  navigates to the loopback route; a `runAction` is dispatched via `POST /actions/:id` with the
  bearer token, exactly like a menu `run-action`.
- On the default tap (body), navigate the in-app window to the notification's primary deep-link
  if present, else open the dashboard window at its root.

**Presenter election (capability registration).** OS-level notification presentation is decided
by **registration, not a per-notification ack race.** On connect, the app registers itself as
the OS-notification presenter over WS (declaring its permission status). While the app is
connected **and** notification-permitted, core routes notifications to it and **suppresses its
own `osascript` fallback**. If the app is absent or notifications are denied, core fires
`osascript` instead. The dashboard is **not** an OS presenter — it shows in-page toasts only —
so there is no double-fire even when both the dashboard and the menu bar app are open.

**Acks and dedup boundary.** Dedup/rate-limit remains entirely server-side keyed by the
notify service; the app does **not** re-implement it. The app may still send a small WS ack
(`{ "type": "notify-ack", "id": "ntf_…", "delivered": true }`) so core can record delivery, but
the presenter choice is made by registration above, not by an ack race. The app also honors a
server `notify-withdraw` message (by `id`) to remove a stale notification from Notification
Center.

**Permission.** The app requests notification authorization on first run via
`requestAuthorization` and reports the result in its presenter registration. If denied, it
registers as present-but-unpermitted (or does not claim the presenter role), so core keeps using
its `osascript` path; the menu bar status color still conveys severity regardless.

### Settings (native SwiftUI window generated from schema)

Settings is a **native SwiftUI window**, not the web UI. The "Settings…" menu item opens it.
The window is **generated from the extensions' settings schemas** fetched from the daemon
(`GET /settings`); writes go back via `POST /settings`. The config store stays server-side and
schema-driven and remains the single source of truth — the native UI is just a renderer over
that schema, exactly as the menu is a renderer over `GET /menu`. This keeps the thin-client
property (a new extension's settings appear with no app release) while giving a fast, native,
OS-idiomatic settings experience rather than an embedded web page.

**Schema → control mapping.** Each setting declares a type; the window renders a native control
per type:

- `bool` → `Toggle`
- `number` → `Stepper` or `Slider` (per declared range/step)
- `string` → `TextField`
- `enum` → `Picker`
- `path` → a path picker (`NSOpenPanel`-backed field)

Settings are **grouped one tab per extension** (the schema is grouped by contributing
extension), so each extension owns a tab of its own settings. Edits are written back with
`POST /settings`.

**Web escape hatch.** A settings section may carry a `web` flag, in which case that section is
rendered as a custom pane in the `WKWebView` (the extension supplies a settings route in the
dashboard web app) instead of being generated natively. This is an escape hatch for settings
too bespoke for the schema-driven controls; **none of the six planned extensions use it**, so
v1 renders entirely native, but the hook keeps the design open.

### Signing, notarization & packaging (Developer ID, self-sign interim, xcodebuild, login item)

- **Project type:** a SwiftPM/Xcode project at `packages/menu-bar` (an Xcode `.app` target, not
  a pnpm package). It is excluded from the pnpm workspace build; its build is `xcodebuild`.
- **Build:** `xcodebuild -scheme PiecesMonitor -configuration Release` producing
  `PiecesMonitor.app`. Hardened Runtime enabled. Entitlements limited to what is actually used
  (outgoing network client for the loopback HTTP/WS API and the `WKWebView` dashboard load; user
  notifications). No keychain entitlement needed. The `WKWebView` only ever loads
  `http://127.0.0.1:4747/`, so an App Transport Security exception is scoped to that loopback
  host.
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
- **Auto-update:** out of scope for v1. The v1 obligation is to ship a **versioned, notarized
  `.app` in a zip/dmg-shaped artifact** so a future update path can consume it. When auto-update
  is added, the preferred path is a **Homebrew cask** (fits Joe's existing Homebrew +
  self-hosted marketplace workflow, needs no extra signing identity and no appcast hosting);
  **Sparkle** is reserved only if true in-app auto-update is later required.
- **Token file access:** reads the `chmod 600` token from
  `~/Library/Application Support/PiecesMonitor/`. Same-user access, so no special entitlement;
  the file's mode plus loopback binding is the security boundary.

## Resolved decisions

- **Notify presenter election → capability registration.** The app registers as the
  OS-notification presenter on connect (declaring its permission status). While connected and
  permitted, core routes notifications to it and suppresses its own `osascript` fallback; if the
  app is absent or denied, core fires `osascript`. The dashboard shows in-page toasts only (it
  is **not** an OS presenter), so there is no double-fire. *Rationale: registration is a stable,
  explicit hand-off, avoiding a flaky per-notification ack race.*
- **Deep-link form → loopback `http` in the in-app WebView.** Deep-links use loopback
  `http://127.0.0.1:4747/…` URLs navigated in the in-app `WKWebView` window; no custom
  `piecesmonitor://` scheme in v1. *Rationale: the app owns the notification handler and just
  tells its own window where to go — a custom scheme is only worth it for an external→app
  handoff, which is deferred until actually needed.*
- **Daemon not-installed vs down → API probe + plist presence; launchd-only restart.**
  Distinguish the two by combining the failed API probe with launchd-agent-plist presence.
  Not-installed → offer a setup/install flow. Installed-but-down → red "daemon offline" plus a
  "Restart daemon" action that calls `launchctl kickstart -k gui/<uid>/<label>`. The app never
  spawns the daemon directly. *Rationale: launchd as sole supervisor is the single-launcher
  principle that prevented the original DB-wipe race.*
- **`run-action` feedback → both, keyed to command duration.** Fast commands show inline
  menu-item state while the menu is open; failures always notify; long-running commands (declared
  via `expectedDurationMs`/`async`) fire a "started" notification, show progress in the window,
  and post a completion notification. *Rationale: match the feedback channel to how long the user
  will be looking at the menu vs away from it.*
- **Status-item overflow → accept gracefully, no custom UI in v1.** When macOS hides the icon
  because the menu bar is full, there is no custom overflow affordance. Notifications are
  icon-independent, and the dashboard window and CLI remain reachable; relaunching the app
  re-opens the window, so there is always a way in. A global hotkey to summon the window is a
  later nicety. *Rationale: a custom overflow UI is disproportionate effort for an
  already-covered failure mode.*
- **Auto-update → out of scope for v1; Homebrew cask preferred later.** When added, prefer a
  Homebrew cask (fits Joe's Homebrew + self-hosted marketplace; no extra signing identity, no
  appcast hosting); reserve Sparkle only if in-app auto-update is later needed. v1 obligation:
  ship a versioned, notarized `.app` in a zip/dmg-shaped artifact so either path can consume it.
  *Rationale: defer the update mechanism while keeping the artifact shape future-proof.*

## Verification (manual)

- **Status colors:** drive the daemon rollup to each state and confirm the menu bar glyph
  tints correctly — `ok` green, `warn` yellow, `crit` red — and updates live over WS without a
  manual refresh.
- **Offline-daemon "red" state:** stop the daemon; confirm the icon switches to the distinct
  **disconnected** glyph (not the `crit` glyph), the menu shows a "daemon offline" state with a
  "Restart daemon" action that runs `launchctl kickstart -k …` (never a direct spawn), and the
  app reconnects automatically (icon returns to the live rollup) when the daemon comes back, via
  the poll fallback. Remove the launchd plist and confirm the menu instead offers the
  setup/install flow (not-installed vs installed-but-down).
- **Menu rendering:** with sections/items registered server-side, confirm the `NSMenu` mirrors
  `GET /menu` (sections, separators, item titles/icons/enabled state) and that adding a server
  `MenuSection` shows new items with **no app rebuild**.
- **Menu actions:** click an `open-url` item (opens browser), a `deep-link` item (focuses/creates
  the in-app `WKWebView` window and navigates it to the loopback route), and a `run-action` item
  (confirm `POST /actions/:id` fires with the bearer token, returns 200, and the daemon executes
  the command). Confirm a token failure path: invalidate the token file, click `run-action`, see
  the re-read-then-error behavior. Confirm `run-action` feedback: a fast command shows inline
  menu-item state, a failure notifies, and a long-running (`async`/`expectedDurationMs`) command
  fires a "started" notification, shows window progress, and posts a completion notification.
- **Dashboard window auto-auth:** open the dashboard window; confirm the `WKWebView` loads
  `http://127.0.0.1:4747/` and is authenticated **with no login prompt** (injected bearer
  token), and that a state-changing dashboard action succeeds.
- **Native settings window:** open "Settings…"; confirm a native SwiftUI window renders one tab
  per extension from `GET /settings`, with the correct control per type (`bool`→Toggle,
  `number`→Stepper/Slider, `string`→TextField, `enum`→Picker, `path`→path picker), and that
  changing a value persists via `POST /settings`.
- **Notification deep-links:** have the core notify service push a `notify` message with action
  buttons; confirm a rich native notification appears with the buttons, the default tap navigates
  the in-app window to the primary deep-link, a `deepLink` button navigates to the target, and a
  `runAction` button dispatches via `POST /actions/:id`. Verify a `notify-withdraw` removes a
  posted notification.
- **Presenter election:** with the app connected and permitted, confirm core routes through the
  app (native notification) and does **not** also fire `osascript`; with the app quit or
  notifications denied, confirm core falls back to `osascript`; with the dashboard open
  alongside the app, confirm the dashboard only shows in-page toasts (no duplicate OS
  notification).
- **Agent behavior:** confirm no dock icon (`LSUIElement`), launch-at-login toggle persists and
  the status item reappears after reboot, and a second launch exits without a second status
  item (single-instance).
- **Signing:** verify `codesign --verify --deep --strict` passes and (once notarized)
  `spctl -a -vvv PiecesMonitor.app` accepts it; confirm granted notification permission
  persists across a rebuild with the stable Developer ID identity.
