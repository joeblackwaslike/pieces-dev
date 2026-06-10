# Pieces Monitor — watchdog extension (design)

> The first real Pieces Monitor extension. Ports the standalone Python babysitter onto the
> platform core's `HostContext`. Validates the whole extension API end-to-end — especially
> the hardened `process` control service that exists to prevent the DB-wipe disaster from
> recurring.

## Context

The Pieces tooling in this monorepo currently includes a standalone Python babysitter
(`packages/babysitter/bin/pieces_babysitter.py`, 388 lines) running as its own launchd agent.
It launches Pieces OS, health-checks it, escalates restarts, detects logged-out auth, and
kills duplicate instances. It works, but it is a separate program with its own loop, its own
logging, its own `osascript` notifications, and — critically — it shells out directly to
`open -a`, `pgrep`, and `os.kill`.

That last point is the danger. A recent **dual-instance bug wiped the CouchBase Lite DB**:
two launchd agents both launched Pieces OS, bypassing `LSMultipleInstancesProhibited`, and
the 129 MB → 2.9 MB collapse went unnoticed. Any program that independently spawns/kills
Pieces OS can recreate that bug. The whole point of the Pieces Monitor platform is to make
that structurally impossible by routing every process operation through one hardened core
service.

This extension **replaces** the Python babysitter. It preserves every behavior — health
loop, auth loop, startup grace, 3-tier escalated restart, restart-counter reset, duplicate
killer, macOS notifications — but expresses them as a TS extension over `HostContext`, with
all launch/kill/restart/PID operations delegated to `ctx.process`. The watchdog itself never
shells out.

## Platform assumptions

The watchdog is an in-process TypeScript module implementing the `Extension` contract
(`{ id, name, version, activate(ctx), deactivate? }`), pure backend TS with no React island.
It runs inside the `monitor-core` daemon and uses only the `HostContext` services defined in
the platform core spec (`docs/superpowers/specs/2026-06-10-pieces-monitor-core-design.md`).
**All** process operations — launch, kill, restart, PID discovery, duplicate detection —
go through `ctx.process`, the hardened core service that bakes in `open -a` (never `Popen`),
the pre-launch PID guard, `LSMultipleInstancesProhibited`, and the duplicate killer. The
watchdog must never shell out to `open`, `pgrep`, `lsof`, or `os.kill` itself, and the
`com.pieces.os.launch.plist` LaunchAgent stays redirected to `/dev/null`.

## Purpose & scope

Keep Pieces OS alive, single-instanced, and logged in, and make every failure and recovery a
first-class incident + notification visible in the menu bar, dashboard, and CLI.

In scope:

- Periodic health check against Pieces OS (`/.well-known/health`).
- Periodic auth check (`/user` → `id` / `email`) with logged-out / restored transitions.
- A startup grace period that suppresses health-driven restarts during boot.
- A 3-tier escalated restart state machine: API restart → SIGTERM+relaunch → SIGKILL+relaunch.
- A bounded restart budget (`MAX_RESTARTS`) with a clean-uptime counter reset.
- Duplicate-instance detection and single-instance enforcement.
- Process-missing detection and relaunch (outside grace).
- Health rollup reporting, structured incidents, dedup/rate-limited notifications, and
  user-invokable commands.

Out of scope:

- Port discovery (provided by `ctx.pieces` / `@pieces-dev/core`).
- The actual process launch/kill/PID mechanics (owned by `ctx.process`).
- Metrics/CPU sampling, backups, data-integrity, doctor (their own extensions).

## Design

### Behavior / state machine

The Python babysitter is one `while True` loop polling timestamps. On the platform we
decompose it into discrete scheduled tasks over `ctx.schedule`, with a small in-memory state
object owned by the extension. There is no long-lived loop; the scheduler is the clock.

Persistent in-memory state (mirrors the Python locals):

- `restartCount` — restart attempts used in the current budget window.
- `healthFailStreak` — consecutive health-check failures.
- `lastCleanTime` — timestamp of last confirmed-healthy restart (for counter reset).
- `authLoggedIn` — last known auth state (optimistic `true` until first check).
- `startupTime` — set on activate; drives the grace window.
- `escalating` — reentrancy guard so a long escalation can't overlap the next health tick.

Overall lifecycle as a state machine:

```text
            activate(ctx)
                 │  startupTime = now; escalating = false
                 ▼
      ┌──────────────────────┐  duplicate killer + single launch via ctx.process
      │   STARTUP (grace)     │  (process.killAll → process.launch)
      │  now-startupTime<90s  │  health failures here DO NOT restart
      └──────────┬───────────┘
                 │ first health 200  OR  grace expires
                 ▼
      ┌──────────────────────┐   health 200  → healthFailStreak=0, report ok
      │      MONITORING      │◄──────────────────────────────────────────────┐
      │  (steady state)      │                                                 │
      └──────────┬───────────┘                                                 │
   health!=200 × HEALTH_FAIL_LIMIT (3)  AND not in grace                       │
                 ▼                                                             │
      ┌──────────────────────┐  restartCount++                                 │
      │   RESTART DECISION    │  restartCount > MAX_RESTARTS ─► GAVE_UP         │
      └──────────┬───────────┘                                                 │
                 │ within budget                                               │
                 ▼                                                             │
      ┌──────────────────────┐  Tier 1: ctx.process.restart (API /os/restart) │
      │   ESCALATION (FSM)    │  Tier 2: SIGTERM + relaunch                    │
      │   escalating = true   │  Tier 3: SIGKILL + relaunch                    │
      └──────────┬───────────┘                                                 │
       healthy? ─┤── yes ─► lastCleanTime = now; escalating=false ─────────────┘
                 └── no (all tiers failed) ─► incident, stay; next tick retries
                 │
                 ▼
      ┌──────────────────────┐  notify CRITICAL; report crit; record incident
      │       GAVE_UP        │  stop auto-restart; await manual command / relogin
      └──────────────────────┘
```

#### Health loop (`schedule` every `HEALTH_INTERVAL`, default 10s)

1. `GET /.well-known/health` via `ctx.pieces` client.
2. `200` → `healthFailStreak = 0`; `health.report('pieces-os', 'ok', detail)`.
3. non-200 / error → `healthFailStreak++`; `health.report('pieces-os', 'warn', …)`; log.
4. When `healthFailStreak >= HEALTH_FAIL_LIMIT`:
   - If within startup grace (`now - startupTime < STARTUP_GRACE_SECS`): log, reset streak,
     hold off (no restart).
   - Else: reset streak, `restartCount++`. If `restartCount > MAX_RESTARTS` → enter GAVE_UP
     (notify CRITICAL, `health.report('pieces-os', 'crit')`, record `gave-up` incident, stop
     restarting). Otherwise run the escalation FSM; on success set `lastCleanTime = now`.
5. Guard: if `escalating` is already true, skip this tick's restart logic (escalation can run
   longer than one interval).

#### Auth loop (`schedule` every `AUTH_CHECK_INTERVAL`, default 300s)

1. `GET /user` via `ctx.pieces`; parse `{ user: { id, email } }` or flat `{ id, email }`.
   `loggedIn = bool(id || email)`; any non-200 → `loggedIn = false`.
2. Transition `authLoggedIn → false`: record `auth-lost` incident, `notify` ("Auth Lost",
   action deep-link), `ctx.process.openApp()` to trigger re-login UI. Fires once per
   logged-out episode (only on the true→false edge — still-logged-out ticks log quietly).
3. Transition `authLoggedIn → true` (after being false): record `auth-restored` incident,
   `notify` ("Auth Restored").
4. `authLoggedIn = loggedIn`.

#### Process / single-instance check (folded into the health tick, or its own short task)

1. Ask `ctx.process` for current Pieces OS PIDs.
2. `pids.length > 1` → record `duplicate-instance` incident, `notify`, call
   `ctx.process.killAll('duplicate instance detected')` then a single `ctx.process.launch()`;
   wait for startup.
3. `pids.length === 0` and not in grace → record `process-missing` incident, `notify`,
   `ctx.process.launch()`; wait for startup.

#### Startup (on `activate`)

- Set `startupTime = now`, `escalating = false`, optimistic `authLoggedIn = true`.
- `ctx.process.killAll('startup cleanup')` then a single `ctx.process.launch()` —
  **only if** the watchdog is configured to manage boot launch (see Open questions); otherwise
  it assumes Pieces OS is already supervised and only restarts on failure.
- Wait up to `STARTUP_GRACE_SECS` for the first health `200`; on timeout record a
  `startup-unhealthy` incident at `warn` (not a restart — grace suppresses that).

#### 3-tier escalated restart (the FSM, mirrors `escalated_restart`)

Set `escalating = true` for the duration. Each tier is delegated to `ctx.process`; the
watchdog only sequences and evaluates health between tiers:

1. **Tier 1 — API restart.** `ctx.process.restart({ mode: 'api' })` → issues `/os/restart`,
   waits `RESTART_WAIT` (30s), re-checks health. Success ⇒ done.
2. **Tier 2 — SIGTERM + relaunch.** `ctx.process.restart({ mode: 'sigterm' })` → SIGTERM the
   PID, wait for exit, `killAll` straggler cleanup, single `launch`, `waitForStartup`.
   Success ⇒ done.
3. **Tier 3 — SIGKILL + relaunch.** `ctx.process.restart({ mode: 'sigkill' })` → SIGKILL,
   cleanup, single `launch`, `waitForStartup`. Success ⇒ done.

Record a `restart-attempt` incident per attempt (with the tier that finally restored health,
or "all tiers failed"). On success: `lastCleanTime = now`. Always clear `escalating` in a
`finally`. (Whether the daemon-level scheduler can run this inline or must dispatch it as a
detached task is an Open question.)

#### Restart-counter reset (`schedule` every minute, or evaluated each health tick)

If `restartCount > 0` and `now - lastCleanTime >= CLEAN_UPTIME_RESET` (10 min), reset
`restartCount = 0` and log "clean uptime — restart counter reset." This re-arms the budget
after a stable window, exactly as the Python loop does.

#### Duplicate killer

The duplicate killer logic lives in `ctx.process` (it is core policy, not watchdog policy).
The watchdog only *detects* the >1-PID condition via `ctx.process`, records the incident,
and asks `ctx.process` to remediate. This is the central anti-DB-wipe guarantee.

### Contributions (HostContext)

- **`health`** — registers one check `pieces-os`:
  - `ok` — health endpoint returned 200 on the last tick.
  - `warn` — health failing but under the fail limit, or in startup grace, or auth lost.
  - `crit` — restart budget exhausted (GAVE_UP), or unrecoverable after all tiers.
  - Optionally a second check `pieces-auth` (`ok` / `warn`) so auth state shows independently
    in the rollup.
- **`incidents`** — records structured, queryable "when & why" entries. Kinds:
  - `pieces-health-fail` — a health tick crossed the fail limit (severity `warn`).
  - `restart-attempt` — one escalated-restart attempt; `data` carries `{ attempt, tier,
    outcome }` (severity `warn`/`crit`).
  - `restart-succeeded` — escalation restored health; `data: { attempt, tier }`.
  - `gave-up` — `restartCount > MAX_RESTARTS`; severity `crit`.
  - `auth-lost` — logged-out transition detected (severity `warn`).
  - `auth-restored` — logged-in transition detected (severity `ok`/info).
  - `duplicate-instance` — >1 Pieces OS PID found (severity `crit` — this is the DB-wipe class).
  - `process-missing` — 0 PIDs outside grace; relaunched (severity `warn`).
  - `startup-unhealthy` — failed to become healthy within grace (severity `warn`).
- **`notify`** — requests (core dedups/rate-limits and posts the macOS notification):
  - "Pieces OS — Auth Lost" (action: open dashboard / re-login).
  - "Pieces OS — Auth Restored".
  - "Pieces OS — CRITICAL" (restart budget exhausted; action: open dashboard).
  - "Pieces OS — Duplicate Instance Killed".
  Each `notify({ title, body, action })` deep-links to the watchdog dashboard section.
- **`commands`** (verbs; also surfaced as menu items and `pmon` subcommands):
  - `watchdog.restart` — force an escalated restart now.
  - `watchdog.kill-duplicates` — run the duplicate killer on demand.
  - `watchdog.relaunch` — kill all + single launch.
  - `watchdog.check-auth` — run the auth check immediately.
  - `watchdog.reset-restart-counter` — clear `restartCount` / leave GAVE_UP manually.
  - `watchdog.status` — return current state (counts, streak, auth, last clean time).
- **`menu`** — a "Pieces OS" section showing current health + auth status and the above
  commands as menu items (Restart, Kill Duplicates, Re-check Auth).
- **`settings`** (schema namespaced by extension id) — fields below under Configuration.
- **`schedule`** — tasks:
  - `health` — interval `HEALTH_INTERVAL`.
  - `auth` — interval `AUTH_CHECK_INTERVAL`.
  - `counter-reset` — interval 60s (or folded into the health tick).
  - (duplicate/process-alive check folded into the health tick).
- **`process`** — the only path to the OS: `launch()`, `killAll(reason)`, `restart({ mode })`,
  PID discovery, duplicate detection, `openApp()` (open Pieces Desktop App for re-login),
  `waitForStartup(timeout)`. The watchdog issues no syscalls of its own.
- **`pieces`** — shared `PiecesClient` + `discoverPort()` for the `/.well-known/health`,
  `/user`, and `/os/restart` HTTP calls.
- **`bus`** — emits `watchdog.restarting`, `watchdog.restarted`, `watchdog.gave-up`,
  `watchdog.auth-lost`, `watchdog.auth-restored`, `watchdog.duplicate-killed` so other
  extensions can coordinate (e.g. `doctor` asks watchdog to stop Pieces before a restore;
  `backups` listens for instability before snapshotting). Subscribes to a `pieces.stop` /
  `pieces.start` request bus event from `doctor` to pause/resume its own restart logic during
  a maintenance window.
- **`log`** — structured per-extension logs (verbose stream complementing incidents),
  replacing the Python file logger at `~/Library/Logs/PiecesOS/babysitter.log`.

### Configuration / settings

Ported 1:1 from the Python config constants, registered as a namespaced settings schema with
these defaults:

```ts
const watchdogSettings = {
  healthIntervalSec: 10,     // HEALTH_INTERVAL — seconds between health checks
  authCheckIntervalSec: 300, // AUTH_CHECK_INTERVAL — seconds between auth checks (5 min)
  healthFailLimit: 3,        // HEALTH_FAIL_LIMIT — consecutive fails before restart
  restartWaitSec: 30,        // RESTART_WAIT — wait after /os/restart before re-check
  maxRestarts: 5,            // MAX_RESTARTS — give-up threshold per budget window
  cleanUptimeResetSec: 600,  // CLEAN_UPTIME_RESET — clean uptime before counter reset (10 min)
  startupGraceSec: 90,       // STARTUP_GRACE_SECS — suppress health restarts during boot
  manageBootLaunch: true,    // launch Pieces OS on activate vs. only restart on failure
  startupWaitTimeoutSec: 60, // wait_for_startup timeout after a (re)launch
} as const;
```

All are live-reloadable via `config.onChange` — changing `healthIntervalSec` reschedules the
health task; changing `maxRestarts` re-arms the budget. The hardcoded paths (`APP_BINARY`,
`PIECES_APP`, `CANDIDATE_PORTS`, `LOG_DIR`) are **not** watchdog settings — app path/launch
policy belongs to `ctx.process`, port discovery belongs to `ctx.pieces` / `@pieces-dev/core`,
and logging belongs to `ctx.log`.

## Source to port / reuse

Port from `packages/babysitter/bin/pieces_babysitter.py`, mapping each function to a
`HostContext` call rather than a syscall:

- Config constants block (lines 22–34) → `watchdogSettings` schema above.
- `check_auth` / `handle_auth_failure` (lines 183–221) → auth loop; `/user` parse logic
  (`data.user ?? data`, `id || email`) preserved verbatim; notify + open-app via
  `ctx.notify` + `ctx.process.openApp()`.
- `try_api_restart`, `kill_and_relaunch`, `escalated_restart` (lines 248–293) → the 3-tier
  escalation FSM, with each tier delegated to `ctx.process.restart({ mode })`.
- `kill_all_instances` (lines 139–172) and the duplicate detection in `main` (lines 366–375)
  → `ctx.process.killAll` + duplicate detection; watchdog only orchestrates.
- `launch_process` (lines 223–234, `open -a`, never `Popen`, pre-launch PID guard) and
  `wait_for_startup` (lines 237–245) → `ctx.process.launch()` / `ctx.process.waitForStartup()`.
- `discover_port` / `base_url` / `http_get` (lines 59–101, 175–180) → `ctx.pieces`
  (`discoverPort` + `PiecesClient` from `@pieces-dev/core`); the candidate-port + lsof logic
  is dropped (core owns it).
- `notify` / `open_pieces_app` (lines 104–117) → `ctx.notify` + `ctx.process.openApp()`.
- The `main` loop's timestamp polling (lines 296–383) → `ctx.schedule` tasks; the restart
  budget, fail streak, grace, and counter-reset logic move into the in-memory state object.

Reuse `@pieces-dev/core` (`discoverPort`, `PiecesClient`, health helpers) — never re-implement
port discovery or HTTP client logic in the extension.

## Open questions

1. **Escalation as a scheduled state machine.** The escalation can take >1 health interval
   (Tier 1 alone waits `RESTART_WAIT` = 30s; each relaunch waits up to 60s). Should it run
   inline within a health tick (relying on the `escalating` reentrancy guard so the next tick
   no-ops), or be dispatched as a separate one-shot `ctx.schedule` task / detached async job
   so the health task stays short and the scheduler isn't blocked? Leaning toward a detached
   async job guarded by `escalating`, with intermediate `restart-attempt` incidents emitted as
   it progresses.
2. **Restart-counter reset.** Reset on a dedicated 60s scheduled task, or evaluate
   `now - lastCleanTime` lazily inside the health tick (as the Python loop does)? Lazy is
   simpler and matches the original; a dedicated task is cleaner but adds a timer. Also: should
   reaching GAVE_UP latch until a manual `watchdog.reset-restart-counter` command, or auto-rearm
   after a clean-uptime window like a normal counter? (Python `sys.exit(1)`s — we can't; we must
   pick latch vs. auto-rearm.)
3. **Boot launch responsibility.** Does the watchdog launch Pieces OS at boot (`manageBootLaunch:
   true`, replacing the babysitter's startup launch), or does it only ever *restart* a process
   that something else starts? If the daemon itself is the launchd-supervised supervisor, the
   watchdog launching on activate is natural — but we must guarantee exactly one launcher to
   avoid re-introducing the dual-instance bug. The `manageBootLaunch` setting exists to make
   this explicit and disableable.
4. **Auth check scope.** Should auth failure influence the overall health rollup (own
   `pieces-auth` check), or stay incidents/notify only? Logged-out means LTM stops collecting —
   arguably a `warn` in the rollup — but it's not a process-liveness problem.

## Verification

Unit (Vitest), with `ctx` services mocked/faked:

- **Health loop:** feed N non-200 responses; assert no restart below `healthFailLimit`, and
  exactly one escalation call at the limit; assert `healthFailStreak` resets on a 200.
- **Startup grace:** simulate health failures within `startupGraceSec`; assert no
  `ctx.process.restart` is called and the streak is reset; assert it *does* restart once the
  grace window passes.
- **3-tier escalation:** stub `ctx.process.restart` to fail Tier 1, fail Tier 2, succeed
  Tier 3; assert all three modes were called in order, `restart-succeeded` incident carries
  `tier: 'sigkill'`, and `lastCleanTime` updated. Stub all tiers failing → assert
  `restart-attempt` incident with "all tiers failed" and no `lastCleanTime` change.
- **Restart budget + reset:** drive `restartCount` past `maxRestarts`; assert GAVE_UP
  (CRITICAL notify, `gave-up` incident, `crit` rollup, no further restarts). Advance fake
  time past `cleanUptimeResetSec` after a clean restart; assert counter resets.
- **Auth transitions:** logged-in → logged-out edge fires exactly one `auth-lost` incident +
  notify + `openApp`; subsequent logged-out ticks are quiet; logged-out → logged-in fires one
  `auth-restored`.
- **Duplicate / single-instance:** report 2 PIDs from `ctx.process`; assert `duplicate-instance`
  incident + `killAll` + single `launch` (never two launches). Report 0 PIDs outside grace →
  `process-missing` + single relaunch; 0 PIDs inside grace → no action.
- **Reentrancy:** assert a health tick during an in-flight escalation (`escalating === true`)
  does not start a second escalation.
- **Config live-reload:** change `healthIntervalSec` via `config.onChange`; assert the health
  task is rescheduled.

Integration / manual:

- Run the watchdog inside the daemon against a real Pieces OS; kill Pieces OS manually and
  watch the escalation + incidents + notification fire; confirm exactly one instance comes
  back (single-instance safety — the core anti-dual-instance guarantee).
- Log out of Pieces and confirm `auth-lost` notify + app open, then re-login and confirm
  `auth-restored`.
- `pmon watchdog.status` reflects live state; `POST /actions/watchdog.restart` triggers an
  escalation identically to the menu item.
- Crucially: launch a second Pieces OS by hand and confirm the watchdog kills the duplicate
  and never leaves two running — the exact scenario that caused the DB wipe.
