# Pieces Monitor — Platform Core (design)

> Cycle 1 of the Pieces Monitor project: the daemon + SDK + CLI. The menu bar app and the
> six functional extensions each have their own design spec in this directory.

## Context

The Pieces developer tooling in this monorepo has grown into a loose collection of
single-purpose programs: a Python babysitter (process health/restart/auth), a Python
metrics sampler, a TS exporter (with a hardcoded wrong port), `gap-reconstruct`,
`ltm-reader`, and the `ltm-injector` VS Code extension. They run as independent launchd
agents and crons with no shared services, no unified status, no UI, and no common config.

A recent **dual-instance bug wiped the CouchBase Lite DB** (two launchd agents both
launching Pieces OS, bypassing `LSMultipleInstancesProhibited`). There was no early-warning
signal — the 129 MB → 2.9 MB size collapse went unnoticed — and no single place to see
"what happened and why." That disaster is the motivating case for this project.

**Goal:** a thin, extensible monitoring platform. A headless **Node/TS daemon** (extension
host + core services + a local HTTP/WS API) with three interchangeable frontends: a native
**Swift menu bar app**, a **dashboard web app in a native window (WKWebView)**, and a
**`pmon` CLI**. The existing tools
become **extensions**. This spec covers the platform core only, proven end-to-end by a
trivial built-in health check and command.

## Locked decisions

- **Daemon:** Node/TS, in-process **TS-only extension model**.
- **`monitor-sdk`** is a separate package — the stable extension contract every extension imports.
- **IPC:** HTTP + WebSocket bound to **`127.0.0.1:4747`**. All three frontends are views over
  this one API.
- **Dashboard:** SSR shell (Fastify renders HTML) + **React islands** opt-in for rich pages.
  Extensions contribute HTML fragments/routes as pure backend TS by default. The dashboard is
  **not** shown in a browser by default — it is the **dashboard web app rendered in a native
  macOS window (an `NSWindow` hosting a `WKWebView`)** provided by the menu-bar app, loading
  the daemon's loopback dashboard URL. This is the "native shell + system WebView" pattern
  (what Tauri does) realized in Swift/AppKit — no Electron/Chromium bundle. Because the
  `WKWebView` is same-origin to the daemon (`127.0.0.1:4747`), the app injects the bearer token
  into the web view so the embedded UI is auto-authenticated (no token/login prompt). Power
  users can still open the loopback URL in a real browser.
- **Settings:** a **native SwiftUI window** generated from the extensions' settings schemas
  fetched from the daemon (not web). The web dashboard and `pmon` CLI render the **same**
  schema.
- **Menu bar:** native **Swift** (`LSUIElement`, Developer ID notarization). Its own spec;
  not in this cycle.
- **Persistence:** a core **SQLite-shim service**; everything persists through it, **bounded
  with rollup** (never unbounded-then-purge — the mistake this project exists to fix). DB
  under `~/Library/Application Support/PiecesMonitor/`.
- **Reuse, don't rebuild:** `@pieces-dev/core` (`discoverPort`, `PiecesClient`, health) and
  `ltm-reader` (used later by `data-integrity`).
- **Conventions:** TS strict, ESM only, Node 22+, Biome, Vitest, no `any`
  (`unknown` + narrowing), no barrel files except package entry points.

## Architecture

```text
            ┌───────────────── 127.0.0.1:4747 (HTTP + WS) ─────────────────┐
            │                                                              │
  Swift menu bar app          Dashboard web app                pmon CLI
  (renders JSON menu model)   in a native window (WKWebView)   (commander)
                              (SSR shell + React islands)
            └──────────────────────────┬───────────────────────────────────┘
                                        │
                          ┌─────────────▼──────────────┐
                          │   monitor-core (daemon)     │
                          │   Extension host            │  loads extension TS modules,
                          │   + 11 core services        │  calls activate(ctx)
                          │   + HTTP/WS + SSR shell      │
                          └──────────────┬──────────────┘
                                         │ reuses
                       @pieces-dev/core (port discovery, client) , ltm-reader
```

## Core services (platform primitives)

### Data & state

1. **Persistence (SQLite shim)** — owns the DB file, migrations, per-extension namespaced
   tables, and retention/rollup helpers. Incidents/metrics/logs and extensions persist
   through it rather than opening their own DBs.
2. **Config store** — one schema-validated file under Application Support. Extensions register
   a settings schema namespaced by id; settings window/dashboard/CLI all read/write the same
   store; `onChange` live reload.

### Observability

3. **Health rollup** — extensions `health.report(checkId, 'ok' | 'warn' | 'crit', detail)`;
   the daemon aggregates to one overall status driving menu bar color, dashboard banner, and
   CLI exit code.
4. **Incident store** — built on persistence: structured, queryable "when & why" records
   (killed-for-CPU, crash, restart, auth-lost, corruption-suspected).
5. **Log service** — structured, queryable per-extension logs surfaced in a dashboard log
   viewer; complements incidents (incidents = headlines, logs = verbose stream).

### Eventing & scheduling

6. **Event bus (pub/sub)** — cross-extension coordination (e.g. `backups` skips a snapshot on
   the `data-integrity.suspect` event; `doctor` signals `watchdog` to stop Pieces
   before a restore) and the WS `/events` live-push backbone.
7. **Scheduler** — one shared interval/cron engine so extensions don't each spin loops.
8. **Notification service** — single point that **dedups + rate-limits** and posts macOS
   notifications with action buttons that deep-link to a dashboard page. Extensions *request*;
   core decides whether/how to fire. **Presenter election via capability registration:** the
   menu-bar app registers as an OS-notification presenter on connect (with its permission
   status); while a permitted presenter is connected, core routes each notification to it and
   **suppresses its own `osascript` fallback**. If no permitted presenter is connected (or
   permission was denied), core fires `osascript` itself. The browser/in-window dashboard shows
   in-page toasts only — it is **not** an OS-notification presenter, so it never double-fires.

### Surfaces & control

9. **API service** — extensions register namespaced HTTP/WS endpoints (`/api/ext/<id>/…`) for
   React-island data feeds, streaming, and third-party scripting; token/CSRF applied centrally.
   **React-island delivery:** an extension ships a self-contained ESM bundle (its deps — e.g.
   uPlot — bundled in) served by the daemon at `/islands/<id>.js`; the SSR shell mounts it via a
   `<div data-island="<id>" data-props='…'>` element plus a `<script type="module">`, and renders
   a meaningful server-side fallback inside the mount node, so first paint is instant and the page
   degrades without JS. `metrics` is the reference island.
10. **Command registry** — one named command `{id, title, params, handler}` invokable
    identically from menu bar, dashboard button, CLI subcommand, and API. The primitive that
    guarantees the "everything is scriptable" symmetry. **Commands = verbs; API routes = nouns.**
11. **Process control** — hardened launch/kill/restart/PID-discovery for Pieces with the
    `open -a` + `LSMultipleInstancesProhibited` + pre-launch PID-guard policy baked into core,
    so no extension can recreate the dual-instance DB-wipe bug. Also backs the daemon's own
    single-instance lock.

Plus `pieces` (shared `PiecesClient` + `discoverPort` from `@pieces-dev/core`) exposed via
context.

### Event-bus naming convention

Bus events are named `<emitter-id>.<event>` — the emitter's extension id, then a kebab event
name. Cross-extension events form a small published contract:

- `data-integrity.suspect` `{ id, reason: 'corruption' | 'collapse' | 'missing', at }` — a DB
  is suspected bad. `backups` defers snapshots until recovery; `doctor` surfaces it on the
  fix-it page.
- `data-integrity.recovered` `{ id, at }` — clears the above.
- `data-integrity.freshness` `{ id, ageMinutes, maxSeqno, at }` — periodic freshness sample.
- `doctor.restore-begin` `{ restoreId, expectedDurationMs }` / `doctor.restore-end`
  `{ restoreId, ok }` — bracket a restore; `watchdog` stands down between them.
- `watchdog.standby-ack` `{ restoreId }` — watchdog acknowledges stand-down.

Incident *kinds* (e.g. `corruption-suspected`) are a separate namespace from bus events.

## Extension contract (`monitor-sdk`)

```ts
export interface Extension {
  id: string;
  name: string;
  version: string;
  activate(ctx: HostContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface HostContext {
  // data & state
  store: StoreApi; // persistence: tables/migrations, query, retention
  config: ConfigApi; // get/set/onChange, namespaced
  // observability
  health: HealthApi; // report(checkId, status, detail)
  incidents: IncidentApi; // record({ kind, severity, summary, data })
  log: LogApi; // structured, queryable logger
  // eventing & scheduling
  bus: EventBusApi; // emit/on — cross-extension + WS push
  schedule: SchedulerApi; // schedule(cronOrInterval, handler)
  notify: NotifyApi; // notify({ title, body, action? }) — core dedups/rate-limits
  // surfaces & control
  api: ApiApi; // register namespaced HTTP/WS endpoints
  commands: CommandApi; // register named commands (menu/dashboard/cli/api dispatch)
  process: ProcessApi; // safe launch/kill/restart/PID (anti-dual-instance)
  menu: MenuApi; // contribute(() => MenuSection)
  dashboard: DashboardApi; // widgets/pages (HTML fragment | React island)
  cli: CliApi; // command(...) grafted onto pmon
  // integration
  pieces: PiecesApi; // shared PiecesClient + discoverPort()
}
```

An extension is **pure backend TS** unless it opts into a React island.

### Settings schema (drives native + web + CLI rendering)

Settings render as a **native SwiftUI window**, as a web pane in the dashboard, and as `pmon`
prompts — all from the **same** `SettingsSchema`. So the schema must be expressive enough to
drive native control generation. Each section groups typed fields; each field carries:

- `label` and `help` (human text)
- `type` — drives the native control: `bool`→Toggle, `number`→Stepper/Slider, `string`→TextField,
  `enum`→Picker, `path`→path picker
- constraints — `min` / `max` / `step` (for `number`)
- `enum` options (for `enum`)
- `default`
- section grouping

A section may set a **`web` escape hatch**: instead of native controls it opts to render as a
custom pane in the `WKWebView`. None of the six planned extensions need it, but the hook exists.

### Command type flags

The `Command` type carries two flags that drive cross-surface behavior:

- `expectedDurationMs?` (or an `async?` boolean) — drives menu-bar feedback: fast commands show
  inline state, long-running commands emit started/progress/completion notifications.
- `destructive?: boolean` — drives a uniform confirmation flow across surfaces: a typed-confirm
  modal in the UI, a `--yes`/TTY prompt in the CLI, and a two-step confirm-token on the API
  (beyond bearer/CSRF).

## Operational spine

- **Daemon = launchd agent (`KeepAlive`)** — launchd supervises the supervisor. The menu-bar
  app **never spawns the daemon directly**; it asks launchd via `launchctl kickstart`. launchd
  (`KeepAlive`) is the daemon's sole supervisor, preserving the single-launcher invariant.
- **Strict single-instance** — via process control: exclusive bind on `:4747` + lockfile
  fallback; a second launch exits cleanly. Non-negotiable given the DB-wipe history.
- **Security** — bind `127.0.0.1` only. Read-only GETs are open on loopback; state-changing
  endpoints require a `chmod 600` bearer token (CLI and menu bar read it; the browser uses a
  same-origin CSRF token).
- **Pieces lifecycle policy** (used by `watchdog`) — enforced inside process control: launch
  via `open -a`, **never `Popen`**; pre-launch PID guard; duplicate killer. Keep
  `com.pieces.os.launch.plist` → `/dev/null`.
- **Restore coordination owned by core** — core mediates the `doctor`↔`watchdog` restore
  stand-down handshake and owns the **dead-man timer** that auto-re-enables the watchdog if
  `doctor.restore-end` never arrives (e.g. doctor crashed mid-restore), since core is the only
  neutral always-alive party. The full handshake lives in the `doctor` spec.

## Cycle 1 scope

Build the platform core so a trivial built-in `hello` health check and `ping` command prove
the host end-to-end across daemon + CLI. **No** menu bar, **no** real extensions yet. All 11
service interfaces are defined in `monitor-sdk`; `monitor-core` ships working impls of the
framework — extension-specific checks/commands/routes land later with their extensions.

### Packages

```text
packages/
  monitor-sdk/    # Extension + HostContext interfaces, 11 service API types, helpers
  monitor-core/   # daemon: ext host, 11 services, HTTP/WS server, SSR dashboard shell
  monitor-cli/    # pmon (commander) — talks to daemon API
```

### `monitor-sdk`

Pure types + light helpers (no runtime deps): `Extension`, `HostContext`, the 11 service API
interfaces (`StoreApi`, `ConfigApi`, `HealthApi`, `IncidentApi`, `LogApi`, `EventBusApi`,
`SchedulerApi`, `NotifyApi`, `ApiApi`, `CommandApi`, `ProcessApi`), the contribution surfaces
(`MenuApi` / `DashboardApi` / `CliApi`), plus `MenuSection` / `MenuItem` / `MenuAction`,
`Incident`, `HealthStatus`, `Command`, `SettingsSchema`. The contract every extension
imports; keep it minimal and stable.

`SettingsSchema` is expressive enough to **drive native control generation** (typed fields with
`label` / `help` / `type` / constraints / `enum` options / `default` / section grouping, plus a
per-section `web` escape hatch) — the same schema feeds the native SwiftUI settings window, the
web dashboard, and the CLI. `Command` carries `expectedDurationMs?` (or `async?`) for menu-bar
feedback and `destructive?: boolean` to trigger the uniform cross-surface confirmation flow.

### `monitor-core`

- `daemon.ts` — bootstrap: single-instance lock (process control), load config, init
  services, discover & load extensions, start HTTP/WS server.
- `services/persistence.ts` — SQLite shim (`better-sqlite3` or `node:sqlite`): DB file,
  migrations, per-extension namespaced tables, retention/rollup helpers.
- `services/config.ts` — schema-validated JSON store + `onChange`.
- `services/health.ts` — registry + rollup.
- `services/incidents.ts` — built on persistence; incident schema + query API + bounded retention.
- `services/log.ts` — structured logger over persistence + ring buffer; query API.
- `services/event-bus.ts` — typed pub/sub; bridges to WS `/events`.
- `services/scheduler.ts` — shared interval/cron engine.
- `services/notify.ts` — dedup/rate-limit + presenter election (route to a registered, permitted
  presenter; `osascript` fallback only when none is connected).
- `services/api.ts` — namespaced route/WS registration atop Fastify; token/CSRF; serves
  per-extension island ESM bundles at `/islands/<id>.js`.
- `services/commands.ts` — command registry + uniform dispatch (`/actions/:id`, CLI, menu);
  honors `expectedDurationMs`/`async` feedback and `destructive` confirmation.
- `services/process.ts` — single-instance lock, PID discovery, safe launch/kill policy.
- `host.ts` — builds `HostContext`, calls `activate(ctx)`/`deactivate()`, namespaces
  contributions per extension.
- `server/` — Fastify HTTP + WS; SSR shell; menu-model endpoint; wires api/commands/auth.
- `menu-model.ts` — assembles the JSON menu tree from contributions + rollup status.
- Built-in **`hello`** health check + **`ping`** command to prove the host with zero real
  extensions.

### `monitor-cli`

`pmon` (commander). Root commands: `status` (exit code from rollup), `incidents`, `logs`,
`daemon start|stop|status`. Extension subcommand grafting is wired but unexercised in
Cycle 1.

## HTTP/WS API surface (initial)

- `GET /status` → overall rollup + per-check detail
- `GET /menu` → JSON menu model
- `GET /incidents`, `GET /logs` → query incidents/logs
- `GET /settings` / `POST /settings` (token/CSRF) → config read/write
- `POST /actions/:id` (token/CSRF) → dispatch a registered command
- `/api/ext/<id>/…` → extension-registered endpoints (token/CSRF for mutations)
- `GET /` → SSR dashboard shell (status banner, widget grid, incident timeline, log viewer, settings)
- `WS /events` → event-bus push (status/menu/incident/log updates)

## Verification

- `pnpm build` and `pnpm test` green across the three new packages. Vitest unit tests per
  service: persistence migrations + namespacing + retention; config validation + `onChange`;
  health rollup precedence; incident write/query; log write/query; event-bus emit/on;
  scheduler firing; notify dedup/rate-limit; command register + dispatch; api route
  registration; process single-instance + PID discovery.
- Start the daemon locally; confirm single-instance (a second start exits cleanly).
- `pmon status` returns the built-in `hello` check and a correct exit code; `pmon logs` reads back.
- The built-in `ping` command dispatches identically via `pmon` and `POST /actions/ping`.
- `curl 127.0.0.1:4747/status` and `/menu` return well-formed JSON; a state-changing POST
  without a token is rejected; with the token it succeeds.
- Open `http://127.0.0.1:4747/` — the SSR shell renders the status banner + (empty) widget
  grid + incident timeline + log viewer.

## Resolved design decisions (review)

1. **Native window delivery** — the dashboard/feature UI runs inside a native macOS window
   (`NSWindow` hosting a `WKWebView`) provided by the menu-bar app, loading the daemon's loopback
   dashboard URL; same-origin token injection auto-authenticates the embedded UI. No
   Electron/Chromium bundle; power users can still open the URL in a real browser.
2. **Native settings** — settings render as a native SwiftUI window generated from the
   extensions' settings schemas; the web dashboard and `pmon` render the same schema, so
   `SettingsSchema` is expressive enough to drive native control generation, with a per-section
   `web` escape hatch.
3. **Command type flags** — `Command` gains `expectedDurationMs?`/`async?` (menu-bar feedback)
   and `destructive?: boolean` (uniform confirmation: typed-confirm modal, CLI `--yes`/TTY
   prompt, two-step API confirm-token).
4. **API service — island contract** — extensions ship self-contained ESM island bundles served
   at `/islands/<id>.js`; the SSR shell mounts them via `data-island`/`data-props` + a module
   script and renders a server-side fallback, so first paint is instant and the page degrades
   without JS. `metrics` is the reference island.
5. **Notify presenter election** — core elects a single OS-notification presenter via capability
   registration; while a permitted presenter is connected it routes there and suppresses its own
   `osascript` fallback, otherwise core fires `osascript`. The dashboard shows in-page toasts
   only and never double-fires.
6. **Daemon lifecycle** — the menu-bar app never spawns the daemon; it uses `launchctl kickstart`,
   keeping launchd (`KeepAlive`) the daemon's sole supervisor and preserving the single-launcher
   invariant.
7. **Restore coordination owned by core** — core mediates the `doctor`↔`watchdog` restore
   stand-down handshake and owns the dead-man timer that auto-re-enables the watchdog if
   `doctor.restore-end` never arrives, since core is the only neutral always-alive party.

## Downstream specs

Each is its own design doc in this directory and its own implement cycle:
`watchdog`, `menu-bar`, `metrics`, `data-integrity`, `backups`, `doctor`.
