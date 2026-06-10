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
**Swift menu bar app**, a **browser dashboard**, and a **`pmon` CLI**. The existing tools
become **extensions**. This spec covers the platform core only, proven end-to-end by a
trivial built-in health check and command.

## Locked decisions

- **Daemon:** Node/TS, in-process **TS-only extension model**.
- **`monitor-sdk`** is a separate package — the stable extension contract every extension imports.
- **IPC:** HTTP + WebSocket bound to **`127.0.0.1:4747`**. All three frontends are views over
  this one API.
- **Dashboard:** SSR shell (Fastify renders HTML) + **React islands** opt-in for rich pages.
  Extensions contribute HTML fragments/routes as pure backend TS by default.
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
  Swift menu bar app          Browser dashboard                pmon CLI
  (renders JSON menu model)   (SSR shell + React islands)      (commander)
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
   core decides whether/how to fire.

### Surfaces & control

9. **API service** — extensions register namespaced HTTP/WS endpoints (`/api/ext/<id>/…`) for
   React-island data feeds, streaming, and third-party scripting; token/CSRF applied centrally.
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

## Operational spine

- **Daemon = launchd agent (`KeepAlive`)** — launchd supervises the supervisor.
- **Strict single-instance** — via process control: exclusive bind on `:4747` + lockfile
  fallback; a second launch exits cleanly. Non-negotiable given the DB-wipe history.
- **Security** — bind `127.0.0.1` only. Read-only GETs are open on loopback; state-changing
  endpoints require a `chmod 600` bearer token (CLI and menu bar read it; the browser uses a
  same-origin CSRF token).
- **Pieces lifecycle policy** (used by `watchdog`) — enforced inside process control: launch
  via `open -a`, **never `Popen`**; pre-launch PID guard; duplicate killer. Keep
  `com.pieces.os.launch.plist` → `/dev/null`.

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
- `services/notify.ts` — dedup/rate-limit + `osascript` poster.
- `services/api.ts` — namespaced route/WS registration atop Fastify; token/CSRF.
- `services/commands.ts` — command registry + uniform dispatch (`/actions/:id`, CLI, menu).
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

## Downstream specs

Each is its own design doc in this directory and its own implement cycle:
`watchdog`, `menu-bar`, `metrics`, `data-integrity`, `backups`, `doctor`.
