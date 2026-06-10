# Pieces Monitor — metrics extension (design)

> Downstream spec of `2026-06-10-pieces-monitor-core-design.md`. The `metrics`
> extension is a pure-backend TS module loaded by `monitor-core`, except for the
> charts page, which is this project's **first React island**.

## Context

This extension replaces the standalone Python metrics sampler at
`packages/metrics/bin/pieces_metrics.py`. That sampler runs as its own launchd
agent: it opens its own SQLite DB at `~/Library/Logs/PiecesOS/metrics.db`, spins
its own 30s loop, parses `babysitter.stdout.log` for restart counts, and has no
UI — you read the trend by hand-querying SQLite.

Centralizing it inside the daemon matters for three reasons:

- **One DB, bounded with rollup.** The standalone sampler writes unbounded rows
  forever. Folding it into the core persistence shim means the metrics table is
  subject to the same bounded-rollup discipline that this whole project exists to
  enforce (the unbounded-then-purge mistake is what wiped the CouchBase Lite DB).
- **Shared signals, not siloed logs.** `restart_count` no longer comes from
  scraping a log file the babysitter happens to write; it comes from querying the
  core **incident store**, where the `watchdog` extension records restart
  incidents as structured data. The metrics sampler and the watchdog stop
  guessing about each other through a flat file.
- **A real surface.** Samples become a dashboard page (trend charts), a dashboard
  widget (current CPU/mem sparkline), a health check (CPU/mem over threshold →
  warn), a JSON data feed, and a `pmon metrics` CLI command — instead of raw
  SQLite the operator has to know how to open.

## Platform assumptions

- The extension is a TS module exporting `{ id, name, version, activate(ctx) }`
  per `monitor-sdk`. All capability comes from `ctx: HostContext`.
- `ctx.store` is the SQLite shim: the extension declares a namespaced table +
  migration and queries through it; retention/rollup helpers are provided by core.
- `ctx.schedule` is the shared interval/cron engine — the extension registers a
  30s handler instead of spinning its own loop.
- `ctx.health` feeds the daemon's health rollup; `ctx.incidents` is the queryable
  incident store; `ctx.config` is the schema-validated settings store with
  `onChange`; `ctx.api` registers `/api/ext/metrics/*` routes; `ctx.dashboard`
  contributes a page (React island) and a widget; `ctx.cli` grafts subcommands
  onto `pmon`; `ctx.pieces` exposes `discoverPort` + `PiecesClient` from
  `@pieces-dev/core`.
- Conventions: TS strict, ESM, Node 22+, Biome, Vitest, no `any`
  (`unknown` + narrowing).
- Dashboard pages are SSR shell by default; this extension opts the charts page
  into a React island. The widget stays a plain HTML/SVG fragment (no island).

## Purpose & scope

Sample the Pieces OS process every 30s — CPU%, RSS/VSZ, thread count, open file
descriptors, cumulative user/system CPU seconds, process age, `/health` status,
and restart count — persist each sample through the core store with bounded
rollup, and surface the trend as charts, a widget, a health check, an API feed,
and a CLI command.

**In scope:** the ported sampler, the table + rollup, the five contributions
above, and settings.

**Out of scope:** anything the `watchdog` owns (restart/kill decisions, PID
discovery policy, the `open -a` launch). The metrics extension only *reads* the
process and *queries* incidents the watchdog already recorded. It never launches,
kills, or restarts Pieces.

## Design

### Sampling

A single handler registered via `ctx.schedule` at the configured interval
(default 30s). One pass = "find the PID, probe it, write one row":

1. **`getPid()`** — `pgrep -f "Pieces OS"`, take the first numeric PID, or `null`
   if not running. (Port of `get_pid`.) Same probe the watchdog uses, but here
   read-only; we do not adopt the core process-control PID policy because we only
   observe.
2. **`psMetrics(pid)`** — port of `ps_metrics`. Two `ps` invocations because
   macOS `ps -o` cannot do `nlwp`:
   - `ps -p <pid> -o %cpu=,rss=,vsz=,etime=` → `cpu_percent` (float),
     `mem_rss_mb` (`rss` KiB ÷ 1024), `mem_vsz_mb` (`vsz` KiB ÷ 1024),
     `process_age_secs` (via `parseEtime`).
   - `ps -p <pid> -o utime=,stime=` → `cpu_user_secs`, `cpu_sys_secs` (via
     `parsePsTime`).
3. **`getThreadCount(pid)`** — port of `get_thread_count`. `ps -M -p <pid>`
   prints one line per thread plus a header; thread count =
   `max(0, lines - 1)`. macOS-native; there is no portable `nlwp` here.
4. **`countOpenFiles(pid)`** — port of `count_open_files`. `lsof -p <pid>`,
   count = `max(0, lines - 1)` (drop the header). 10s timeout — `lsof` is the
   slowest probe.
5. **`checkHealth()`** — port of `check_health`. Build the URL from
   `ctx.pieces.discoverPort()` rather than hardcoding `39300`
   (`http://127.0.0.1:<port>/.well-known/health`), GET with timeout, return the
   HTTP status, `-1` on any failure.
6. **`getRestartCount()`** — **replaces** `parse_restart_count`. Instead of
   regex-scanning `babysitter.stdout.log` for `=== Restart attempt n/m ===`, it
   queries `ctx.incidents` for restart incidents recorded by the `watchdog`
   extension (e.g. `count of kind === "restart"`, optionally within the
   retention window). See "where restart_count now comes from."
7. **`collectSample(pid)`** — port of `collect_sample`. Assemble one row;
   `timestamp` = ISO-8601 UTC to seconds. If `pid` is `null`, write a row with
   all process fields `null` but real `health_status` and `restart_count` (the
   "process not running" null sample is intentional — gaps are signal).

Helper ports, exact semantics preserved:

- **`parseEtime(s)`** — `[[dd-]hh:]mm:ss` → seconds. Split on `-` for days, then
  on `:`; 3 parts = `h:m:s`, 2 parts = `m:s`, else `null`.
- **`parsePsTime(s)`** — `mm:ss.ss` → seconds: `min*60 + sec` when one colon,
  else `float(s)`.

Every probe is wrapped so a single failed command yields `null` for that field,
never a thrown sample — same defensive posture as the Python. All `child_process`
calls use `execFile` (array argv, no shell) with explicit timeouts.

**macOS specifics:** `pgrep -f`, `ps -M`, `etime`/`utime`/`stime` column
formats, and `lsof` row semantics are all BSD/macOS-flavored. This extension is
macOS-only (consistent with the menu bar and the rest of the platform). The probe
layer is isolated behind these functions so a future Linux port swaps only them.

### Data model

One namespaced table declared through `ctx.store` (core prefixes/owns it, e.g.
`ext_metrics_samples`). Columns map 1:1 from the Python `process_metrics` schema,
minus the surrogate `id` (the store provides identity/ordering):

```sql
CREATE TABLE ext_metrics_samples (
  ts                TEXT    NOT NULL,  -- ISO-8601 UTC, seconds (was `timestamp`)
  pid               INTEGER,           -- null when process not running
  cpu_percent       REAL,
  mem_rss_mb        REAL,
  mem_vsz_mb        REAL,
  thread_count      INTEGER,
  open_files        INTEGER,
  cpu_user_secs     REAL,
  cpu_sys_secs      REAL,
  process_age_secs  REAL,
  health_status     INTEGER,           -- HTTP code, or -1
  restart_count     INTEGER            -- from incident store, not log scrape
);
-- index on ts for range queries (port of idx_ts)
```

Migration is registered through the store's migration API; the index on `ts` is
the port of the Python `idx_ts`.

**Bounded rollup strategy.** This is the deliberate departure from the standalone
sampler:

- **Raw tier** — 30s rows kept for `rawRetentionDays` (default 7).
- **Hourly tier** — a second table `ext_metrics_samples_hourly` (same columns +
  `bucket TEXT`). A scheduled rollup job (hourly via `ctx.schedule`) collapses
  raw rows older than the raw-retention boundary into one hourly row per bucket:
  averages for gauges (`cpu_percent`, `mem_rss_mb`, `mem_vsz_mb`, `thread_count`,
  `open_files`), `max` for peaks worth keeping (peak `cpu_percent`,
  `mem_rss_mb`), `last`/`max` for monotonic counters (`cpu_user_secs`,
  `cpu_sys_secs`, `process_age_secs`, `restart_count`), and worst-case for
  `health_status`. Exact aggregate set is an open question below.
- **Prune** — after rollup, raw rows past `rawRetentionDays` are deleted; hourly
  rows kept for `hourlyRetentionDays` (default 90), then pruned. Both bounds use
  core retention helpers, so the table can never grow unbounded.
- The series API merges raw + hourly transparently: recent window from raw, older
  window from hourly, based on `since`.

### Contributions (HostContext)

- **`ctx.schedule`** — two jobs: the 30s sampler (`collectSample` → `store`
  insert) and the hourly rollup/prune job.
- **`ctx.store`** — declares the two tables + migration; provides insert and the
  range-query that backs the API. Retention/rollup via core helpers.
- **`ctx.health` + thresholds** — after each sample, report a check
  (`metrics.resource`) to the rollup: `crit` if `cpu_percent` or `mem_rss_mb`
  exceeds the configured `crit` threshold, `warn` if over `warn`, else `ok`, with
  a detail string (`"cpu 91% > 85"`). This feeds the daemon's overall rollup
  (menu bar color, dashboard banner, CLI exit code). Sustained-vs-instantaneous
  smoothing (N consecutive samples) is a settable knob; default is instantaneous
  to match the Python's per-sample CPU%.
- **`ctx.dashboard` page (React island)** — `/dashboard/metrics`, the project's
  first React island. SSR shell renders the page chrome; the island mounts an
  **uPlot** chart component that fetches `/api/ext/metrics/series` and draws CPU%,
  RSS/VSZ, threads, fds over time, with a `since` range selector. uPlot chosen
  for tiny bundle + fast canvas redraw on dense time series (see open questions).
- **`ctx.dashboard` widget** — a small **CPU/mem sparkline** showing the latest
  sample + last ~30 min trend, rendered as a plain HTML/inline-SVG fragment (no
  island), cheap enough to live in the dashboard widget grid and the menu bar
  model.
- **`ctx.api` routes** —
  - `GET /api/ext/metrics/series?since=<iso|relative>&fields=<csv>` → JSON
    columnar series for charts (raw+hourly merged), shaped for direct uPlot
    ingestion (`[ts[], cpu[], rss[], …]`).
  - `GET /api/ext/metrics/latest` → the most recent sample (backs the widget).
  - Read-only GETs; loopback-open per core security model.
- **`ctx.config` settings** (namespaced schema, `onChange` live-reload):
  - `sampleIntervalSec` (default 30)
  - `rawRetentionDays` (default 7)
  - `hourlyRetentionDays` (default 90)
  - `cpuWarnPct` / `cpuCritPct` (e.g. 75 / 90)
  - `memWarnMb` / `memCritMb`
  - `alarmSustainSamples` (default 1 = instantaneous)
  - `onChange` reschedules the sampler if the interval changes and re-reads
    thresholds without restart.
- **`ctx.cli`** — `pmon metrics [--since <iso|relative>] [--json]`. Prints a
  compact recent-trend table (ts, cpu, rss, threads, fds, health) over the
  `--since` window; `--json` emits the same rows the series API returns for
  scripting. Reads through the daemon API, consistent with other `pmon`
  subcommands.
- **Where `restart_count` now comes from** — `ctx.incidents`. The `watchdog`
  extension records a restart incident each time it restarts Pieces; the metrics
  sampler queries that store (count of restart-kind incidents, within the active
  window) and stamps it onto each sample. The `babysitter.stdout.log` scrape and
  the `=== Restart attempt n/m ===` regex are dropped entirely. If `watchdog` is
  not loaded, `restart_count` is `0` (no incident source) — documented, not an
  error.

## Source to port / reuse

Port from `packages/metrics/bin/pieces_metrics.py`:

- `init_db` → store migration declaring `ext_metrics_samples` (+ `idx_ts`
  equivalent) and the hourly rollup table.
- `get_pid` → `getPid()` (`pgrep -f "Pieces OS"`).
- `ps_metrics` → `psMetrics()` (two `ps` calls: `%cpu,rss,vsz,etime` then
  `utime,stime`).
- `get_thread_count` → `getThreadCount()` (`ps -M -p`, lines − 1).
- `count_open_files` → `countOpenFiles()` (`lsof -p`, lines − 1).
- `parse_etime` → `parseEtime()`.
- `parse_ps_time` → `parsePsTime()`.
- `check_health` → `checkHealth()` (now port-discovered via `ctx.pieces`, not
  hardcoded `39300`).
- `collect_sample` → `collectSample()` (same null-sample-when-down behavior).
- `insert_sample` → store insert.
- `parse_restart_count` → **dropped**; replaced by an incident-store query.

Reuse from the platform: `ctx.pieces` (`discoverPort` + `PiecesClient` from
`@pieces-dev/core`) for health URL/port; core store retention/rollup helpers;
core scheduler; core health rollup; core incident store.

## Open questions

- **Charting lib.** Recommend **uPlot** (≈40 KB, canvas, built for dense time
  series) for the island over Chart.js/Recharts (heavier, slower on thousands of
  points). Confirm before the island lands; the API shape is already
  uPlot-friendly columnar so a swap is contained.
- **Rollup aggregates.** Exact per-column aggregate set when collapsing raw →
  hourly: avg vs avg+max for gauges, how to fold `health_status` (worst code in
  bucket? count of non-200?), and whether to keep peak CPU/RSS as extra columns
  vs separate min/avg/max triples. Affects the hourly table shape.
- **Restart count semantics.** Cumulative-since-install vs within-retention-window
  vs since-daemon-start — must match what `watchdog` actually records and what the
  chart should show. Resolve jointly with the watchdog spec.
- **Health smoothing default.** Whether `alarmSustainSamples` should default to >1
  to avoid flapping the rollup on a single CPU spike (the Python alarmed
  per-sample; the rollup is more visible, so flapping is costlier).
- **uPlot in the island bundle.** Build/ship story for the first React island
  (bundling uPlot, SSR fallback when JS is off) — coordinate with the core
  dashboard shell.

## Verification

- `pnpm build` + `pnpm test` green for the `metrics` extension package.
- Unit tests (Vitest) for the pure parsers against the Python's exact cases:
  `parseEtime` (`mm:ss`, `hh:mm:ss`, `dd-hh:mm:ss`, malformed → `null`),
  `parsePsTime` (`mm:ss.ss`, bare float, malformed → `null`).
- Probe tests with `execFile` mocked: `psMetrics` maps `%cpu/rss/vsz/etime` and
  `utime/stime` correctly (KiB→MB division), `getThreadCount`/`countOpenFiles`
  do `lines − 1` and clamp at 0, every probe returns `null` on command failure.
- `collectSample` writes a full row when up and a null-process row (real
  `health_status`/`restart_count`) when `getPid()` is `null`.
- `restart_count` is sourced from a mocked `ctx.incidents` query, never from a
  log file (assert no filesystem read of `babysitter.stdout.log`).
- Store tests: migration creates both tables + the `ts` index; insert →
  range-query round-trips; rollup collapses raw → hourly with the chosen
  aggregates; prune respects `rawRetentionDays`/`hourlyRetentionDays` so neither
  table grows unbounded.
- Health: a synthetic sample over `cpuCritPct`/`memCritMb` reports `crit` to the
  rollup; under `warn` reports `ok`; `alarmSustainSamples` gates flapping.
- API: `GET /api/ext/metrics/series?since=…` returns merged raw+hourly columnar
  JSON; `GET /api/ext/metrics/latest` returns the newest sample.
- CLI: `pmon metrics --since 1h` prints the trend table; `--json` matches the
  series payload.
- Manual: with Pieces OS running, the 30s job populates rows; the dashboard
  charts page renders the React island fed by the series route; the widget
  sparkline shows current CPU/mem; killing Pieces produces null-process samples
  and a visible gap in the charts.
