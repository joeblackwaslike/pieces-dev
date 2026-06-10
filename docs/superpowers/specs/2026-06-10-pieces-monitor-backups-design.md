# Pieces Monitor — backups extension (design)

> One of the six functional extensions in the Pieces Monitor project. Reworks the existing
> standalone `packages/exporter` (`src/export.ts`) into an in-process Monitor extension over
> `HostContext`. See `2026-06-10-pieces-monitor-core-design.md` for the platform core.

## Context

The current exporter is a standalone Node script (`packages/exporter/src/export.ts`, ~197
lines) wired up as a monthly cron / launchd agent. It already does the hard parts well:
it health-checks Pieces OS, prefers a live **API export** (`GET /database/export`, streamed
and gzipped), falls back to **SQLite VACUUM INTO copies** of the workstream/hints/etc. DBs
plus a **direct copy** of the Couchbase Lite DB when Pieces is down, writes a `manifest.json`,
and prunes old backups. It is a solid backup engine trapped in a dumb wrapper.

Three problems motivate the rework:

- **The port-1000 bug.** `export.ts` hardcodes `const PIECES_PORT = 1000;` and builds
  `BASE_URL = http://localhost:1000`. Pieces OS actually binds a dynamic port in the
  **39300+** range (discovered via `discoverPort()` from `@pieces-dev/core`). With port 1000
  the health check always fails, so **the API export path never runs** — every backup
  silently degrades to the SQLite fallback. We have been backing up via the weaker path for
  months without knowing.

- **Monthly is too coarse.** The project exists because a dual-instance bug collapsed the
  Couchbase Lite DB from 129 MB to 2.9 MB and nobody noticed. A monthly cadence means up to
  ~30 days of lost work between snapshots. The backup window must be **daily**.

- **No corruption guard (retention cliff).** Prune keeps "last 3 + anything ≤ 12 months."
  If a corrupt DB gets snapshotted daily, the three most-recent good backups roll off the
  "last 3" window within three days, leaving only corrupt snapshots inside retention — a
  **retention cliff** that overwrites good history with garbage. A backup tool that happily
  archives a corrupt DB over a known-good one is actively dangerous. The extension must
  **refuse to snapshot while corruption is suspected**.

The fix is not a rewrite of the engine — it is to lift the proven backup functions out of the
script, fix the port, move to daily, and connect it to the platform's shared services
(scheduler, config, dashboard, incidents, notify, health, cli, bus).

## Platform assumptions

- An extension is an **in-process TS module** that exports `activate(ctx: HostContext)`
  (and optional `deactivate()`), per `monitor-sdk`.
- `ctx` provides: `store`, `config`, `health`, `incidents`, `log`, `bus` (pub/sub),
  `schedule`, `notify`, `api`, `commands`, `process`, `menu`, `dashboard`, `cli`, and
  `pieces` (shared `PiecesClient` + `discoverPort()` from `@pieces-dev/core`).
- Conventions: TS strict, ESM only, Node 22+ (built-in `fetch`), Biome, Vitest, no `any`
  (`unknown` + narrowing), no barrel files except the package entry point.
- The `data-integrity` extension emits a `data-integrity.suspect` signal on `ctx.bus` and
  records a matching incident in the core incident store.

## Purpose & scope

Provide a **daily, automatic backup** of the Pieces databases — preferring the live API
export and falling back to SQLite VACUUM copies — with bounded retention, observable through
the Monitor's dashboard / health / incidents / CLI, and **safe by default**: it never
snapshots over good history while corruption is suspected.

In scope:

- Daily scheduled backup via `ctx.schedule`.
- API export + SQLite/Couchbase fallback (ported from `export.ts`).
- Retention prune (configurable count + age).
- Settings pane (frequency, retention, paths, strategy).
- Dashboard widget, health check, incidents, notifications.
- `pmon backup now|list|prune` CLI.
- `data-integrity.suspect` bus subscription that defers snapshots.

Out of scope: restore/rollback (owned by `doctor`), corruption detection (owned by
`data-integrity`), Pieces process lifecycle (owned by `watchdog` / core `process`).

## Design

### Backup strategy

The engine is ported verbatim in behavior from `export.ts`; only its inputs (port, paths,
retention knobs) and its plumbing (logging, scheduling, persistence) change.

**Strategy selection.** On each run, `checkHealth()` pings Pieces OS at the **discovered**
base URL (`/.well-known/health`, 5s timeout).

- Pieces alive → **`api`** strategy: `apiExport()` does `GET /database/export` (180s timeout),
  streams `res.body` through `createGzip({ level: 6 })` into
  `database-export.json.gz`, then re-reads the gzip to extract per-collection counts (every
  top-level value whose `.iterable` is an array contributes `key → length`) for the manifest.
- Pieces down → **`sqlite`** strategy: `sqliteExport()` writes into `sqlite/`:
  - **VACUUM INTO** for the live SQLite DBs (`workstreamEvents`, `*.archive`,
    `workstreamSummaries`, `hints`, `conversationMemories`, `tags`, …). `vacuumDb(src, dest)`
    removes any stale `dest` first (VACUUM INTO fails if it exists), then runs
    `sqlite3 <src> "VACUUM INTO '<dest>'"`. VACUUM INTO produces a clean, compact copy even
    on a live DB.
  - **Direct copy** for `couchbase.cblite2/db.sqlite3` — Couchbase Lite uses a custom SQLite
    format that VACUUM INTO rejects, so it is `copyFile`'d as-is.
  - Per-file byte sizes are recorded as counts.

The `strategy` field is chosen by configuration when set to a fixed `api`/`sqlite`; the
default `auto` preserves the existing alive-vs-down selection.

**Output layout** (unchanged, one dated dir per day under the backup root):

```text
<backupRoot>/
  2026-06-10/
    manifest.json            # { timestamp, strategy, counts, deferred? }
    database-export.json.gz   # api strategy only
    sqlite/                  # sqlite strategy only
      workstreamEvents.sqlite
      …
      db.sqlite3            # couchbase, direct copy
```

**Retention / prune.** `pruneBackups()` lists dated `YYYY-MM-DD` dirs, sorts descending, and
keeps **last N (default 3)** plus anything newer than **maxAgeMonths (default 12)**; the rest
are `rm -rf`'d. Both N and the age window become settings. The corruption guard (below) is
what prevents prune from eroding good history during a corruption event.

### Reworks vs the old exporter

| Concern | Old `export.ts` | Reworked extension |
| --- | --- | --- |
| Port / base URL | `PIECES_PORT = 1000` (always wrong) | `await ctx.pieces.discoverPort()` → dynamic 39300+; `BASE_URL` derived from it (or reuse `ctx.pieces` client directly) |
| Cadence | monthly cron / launchd agent | **daily** via `ctx.schedule` |
| Config | hardcoded paths + constants | `ctx.config` settings pane (frequency, retention N + age, paths, strategy) with live `onChange` |
| Logging | `process.stdout`/`stderr` writes | `ctx.log` (structured, queryable) |
| Failure visibility | none (exit 1) | `ctx.incidents.record(...)` + `ctx.notify(...)` |
| Liveness/staleness | none | `ctx.health.report('backup-fresh', …)` |
| Invocation | only the cron | `ctx.commands` + `ctx.cli` (`pmon backup now|list|prune`) |
| Corruption safety | none — would back up corruption over good data | **`ctx.bus` subscribe to `data-integrity.suspect`** → skip/defer snapshot |
| Run record | manifest file only | manifest **plus** a row in `ctx.store` (last run time/size/strategy) for the widget |

The backup functions (`checkHealth`, `apiExport`, `vacuumDb`, `sqliteExport`, `pruneBackups`,
manifest writing) move into the extension module largely intact; `main()` is replaced by an
`activate(ctx)` that registers schedule/command/health/settings/bus and a `runBackup(ctx)`
that orchestrates them.

### Contributions (HostContext)

- **`ctx.schedule`** — register a **daily** job (default e.g. `0 4 * * *`, overridable from
  settings) that calls `runBackup(ctx)`. The shared scheduler replaces the launchd cron.
- **`ctx.config`** — register a settings schema (namespaced `backups`):
  - `frequency` (`daily` default; `weekly`/`monthly` allowed) → drives the schedule.
  - `retentionCount` (number, default 3) and `retentionMaxAgeMonths` (number, default 12).
  - `backupRoot`, `vectorDbDir`, `couchbaseDir` paths (defaulting to the current
    `~/Library/com.pieces.pfd/backups` and `~/Library/com.pieces.os/production/Pieces/…`).
  - `strategy` (`auto` default | `api` | `sqlite`).
  - `onChange` re-arms the scheduler when `frequency` changes.
- **`ctx.dashboard`** — a widget showing **last backup time, size, strategy** (read from
  `ctx.store`) and **next scheduled run**; a "Back up now" button bound to the command;
  a deferred/skip badge when corruption is suspected.
- **`ctx.incidents`** — `record({ kind: 'backup-failed' | 'backup-deferred', severity, summary,
  data })` on failure or corruption-deferral, replacing the silent `exit(1)`.
- **`ctx.notify`** — request a macOS notification on failure or on a deferred backup (core
  dedups/rate-limits); action button deep-links to the backups dashboard page.
- **`ctx.health`** — `report('backup-fresh', 'ok' | 'warn' | 'crit', detail)`: **ok** if the
  newest backup is within ~1.5× the configured cadence, **warn** when the backup age is
  **stale** (older than that), **crit** if no backup exists or the last run failed. Feeds the
  overall rollup / menu-bar color.
- **`ctx.cli`** — graft `backup` onto `pmon`:
  - `pmon backup now` → run a backup immediately (dispatches the command).
  - `pmon backup list` → list dated backups with timestamp / size / strategy.
  - `pmon backup prune` → run retention prune now.
- **`ctx.commands`** — register `backups.run` (and `backups.prune`) so the widget button, CLI,
  menu, and API all dispatch the same verb (commands = verbs; routes = nouns).
- **`ctx.bus`** — `ctx.bus.on('data-integrity.suspect', …)` sets a "defer" flag; while set,
  `runBackup` records a `backup-deferred` incident and returns **without** snapshotting, so a
  corrupt DB never overwrites a good one and prune never erodes good history. Cleared on a
  recovery/all-clear signal (see Open questions).

## Source to port / reuse

- **`packages/exporter/src/export.ts`** — port these in place:
  - `checkHealth()` (health probe) — keep, but against the **discovered** base URL.
  - `apiExport(outDir)` — streamed gzip export + count extraction. Keep verbatim; swap
    `BASE_URL`.
  - `vacuumDb(src, dest)` — `sqlite3 … VACUUM INTO`. Keep verbatim.
  - `sqliteExport(outDir)` — VACUUM INTO list + Couchbase direct copy. Keep; source the DB
    path lists from settings (defaults = current `SQLITE_DBS` / `DIRECT_COPY_DBS`).
  - `pruneBackups()` — keep "last N + ≤ age" logic; parameterize N and age from settings.
  - manifest assembly (`{ timestamp, strategy, counts }`) — keep; add `deferred` when skipped.
- **`@pieces-dev/core`** — `discoverPort()` (dynamic 39300+ port) and the shared
  `PiecesClient` via `ctx.pieces`; this is the canonical fix for the hardcoded port-1000 bug.
- **Core services** (`monitor-core`) — scheduler, config, store, health, incidents, log,
  notify, commands, cli, bus, as wired through `ctx`.

## Open questions

- **Skip-during-corruption coordination.** What exactly clears the defer flag — an explicit
  `data-integrity.recovered` bus event from `data-integrity`, a successful `doctor` restore, or a
  TTL? And should a deferral block *all* DBs or only the specific DB flagged as corrupt
  (per-DB granularity would let healthy DBs keep backing up)?
- **Verify snapshot integrity.** Should each VACUUM INTO / direct-copy run
  `PRAGMA integrity_check` (and a gzip-decompress sanity read for the API export) before the
  manifest is written, so we never record a "successful" backup that is itself corrupt? This
  overlaps `data-integrity`'s remit — decide ownership.
- **Gzip level / dedupe.** Level 6 is the current default; is daily cadence worth a higher
  level or content-addressed/hardlink dedupe across dated dirs to cut disk usage, given most
  days' DBs barely change? Or is the simple per-day full copy fine within the retention bound?
- **Strategy when both available.** When Pieces is alive, should `auto` ever *also* take the
  SQLite snapshot (belt-and-suspenders), or strictly one strategy per run as today?

## Verification

- `pnpm build` and `pnpm test` green for the backups extension package; Vitest unit tests:
  - `checkHealth` uses the **discovered** port, not 1000 (regression test for the bug).
  - `apiExport` streams + gzips and extracts counts from a mocked `/database/export`.
  - `vacuumDb` / `sqliteExport` against fixture SQLite DBs; Couchbase fixture uses direct copy.
  - `pruneBackups` keeps last N + ≤ age and removes the rest, with N/age from settings.
  - `data-integrity.suspect` on `ctx.bus` causes `runBackup` to record `backup-deferred` and
    **not** write a snapshot; clear signal re-enables it.
  - `health.report('backup-fresh', …)` returns `warn` when the newest backup is stale and
    `crit` when none exists.
- Integration: register the extension with a test host; fire the scheduled job once and assert
  a dated dir with `manifest.json` (+ `database-export.json.gz` or `sqlite/`) is produced and a
  run row is written to `ctx.store`.
- Manual: with Pieces OS running, `pmon backup now` produces an **api**-strategy backup
  (proving the port fix); with Pieces stopped, it produces a **sqlite**-strategy backup;
  `pmon backup list` shows both; `pmon backup prune` honors retention; the dashboard widget
  shows last/next run.
