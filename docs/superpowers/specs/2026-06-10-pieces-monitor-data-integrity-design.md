# Pieces Monitor — data-integrity extension (design)

> One of the functional extensions of the Pieces Monitor platform (see
> `2026-06-10-pieces-monitor-core-design.md`). This is the early-warning system for the exact
> disaster that started the project.

## Context

A dual-instance bug wiped the Pieces CouchBase Lite database: two launchd agents both launched
Pieces OS, defeating `LSMultipleInstancesProhibited`, and the on-disk store **collapsed from
129 MB to 2.9 MB**. Nobody noticed for days. There was no early-warning signal, no baseline to
compare against, and no single place that said "the workstream store just lost 98% of its
bytes." By the time it surfaced, the long-term-memory (LTM) capture this whole project exists
to protect had been silently broken.

`data-integrity` is the fix. It continuously watches each Pieces database for **uptime,
latency, corruption, sudden size collapse, and freshness**, persists a **last-known-good
baseline** so a collapse is detectable the instant it happens, raises incidents and
notifications, and — critically — **emits an event the `backups` extension subscribes to** so a
snapshot is never taken on top of a database that is currently corrupt or collapsing. The
129 MB → 2.9 MB collapse is the canonical signal: if this extension cannot catch that, it has
failed.

## Platform assumptions

- An extension is an **in-process TypeScript module** that exports `activate(ctx: HostContext)`.
- `ctx` exposes the 11 core services: `store`, `config`, `health`, `incidents`, `log`, `bus`
  (pub/sub), `schedule`, `notify`, `api`, `commands`, `process`, plus the contribution surfaces
  `menu`, `dashboard`, `cli`, and the integration handle `pieces`.
- All persistence goes through `ctx.store` (the core SQLite shim, bounded with rollup). The
  extension never opens its own writable DB.
- Notifications go through `ctx.notify` (core dedups + rate-limits). The extension *requests*.
- Cross-extension coordination goes through `ctx.bus`.
- Conventions: TS strict, ESM only, Node 22+, Biome, Vitest, no `any` (`unknown` + narrowing),
  no barrel files except the package entry point.

## Purpose & scope

**In scope:** read-only health surveillance of the Pieces databases on disk; detection of the
five signal classes below; a persisted baseline + bounded history; incidents, notifications,
and bus emits; a dashboard page + freshness widget; settings; and a `pmon data` CLI.

**Out of scope:** taking backups (that is `backups`), restarting Pieces (`watchdog`), running
restores or VACUUM repairs (`doctor`), and porting any Python — this extension is **new**.
`data-integrity` *detects and signals*; remediation lives in sibling extensions that consume
its bus events.

## Design

The extension registers one **scheduled probe sweep** (default every 60 s, configurable). Each
sweep iterates the configured database set, runs the signal checks per DB using **tiered
lock-safe reads** (free `statSync` for size, a cheap read-only/WAL-consistent SQLite connection
for routine content probes, and a `VACUUM INTO` snapshot only for the slow-cadence deep
integrity scan — see Signals & detection), reports a per-DB health status, compares against the
persisted baseline, persists a fresh history sample, and emits bus events / incidents /
notifications on state transitions (not on every sample — only on edge changes, to avoid alarm
spam).

### Databases monitored

All paths are relative to `~/Library/com.pieces.os/production/Pieces/`. Each entry has a
logical `id`, a glob, a `kind`, and whether it is **critical** (drives overall rollup).

| id | path / glob | kind | critical | notes |
| --- | --- | --- | --- | --- |
| `couchbase` | `couchbase.cblite2/db.sqlite3` | couchbase-lite | yes | the big workstream-event store; ltm-reader's default DB |
| `workstream` | `workstream*.sqlite` | sqlite | yes | live workstream DB(s) |
| `workstream-archive` | `workstream*.archive.sqlite` | sqlite | no | rolled-off archives |
| `hints` | `hints.sqlite` | sqlite | no | |
| `vector` | `vector_db/*.sqlite` | sqlite | no | embedding/vector stores |

The configured set is glob-expanded at sweep start, so newly created `workstream*.sqlite` or
`vector_db/*.sqlite` files are picked up automatically. A previously-seen critical DB that has
**disappeared** is itself a `db-missing` incident (deletion is the most extreme size collapse).

### Signals & detection

Checks are **tiered by cost and cadence** so the catastrophic signal is free, routine signals
are cheap and consistent, and only the deep corruption scan pays a snapshot cost (see Resolved
decisions):

- **Size (every sweep, free):** `statSync` the **live** file. No DB open, instant, and it
  catches the 129 MB → 2.9 MB catastrophe directly.
- **Routine content probes (every sweep, cheap):** max seqno, row count, and freshness are read
  via a **read-only, WAL-consistent SQLite connection** (`mode=ro`, using `better-sqlite3`,
  which the core persistence shim already bundles). This is *not* sql.js — `ltm-reader`'s
  current `readFileSync`-whole-file path can read a torn image mid-write and ignores the WAL, so
  it is unsafe for live reads.
- **Deep integrity (slow cadence, snapshot):** full `PRAGMA integrity_check` runs only on a slow
  cadence (default hourly, configurable) against a `VACUUM INTO` snapshot for a consistent
  image; the snapshot is deleted after the check.

1. **Integrity check (corruption) — slow cadence.**
   Run `PRAGMA integrity_check` (with `PRAGMA quick_check` as a fast pre-pass) on a **slow
   cadence** (default hourly, configurable via `integrityCheckIntervalSec`) against a
   `VACUUM INTO` snapshot, so a concurrent Pieces write never corrupts the read and the check
   sees a consistent image. This is the only signal that pays the snapshot cost, and only
   infrequently — running `VACUUM INTO` on a 129 MB file every 60 s would be wasteful, and deep
   corruption is the least time-critical signal. Result `ok` → healthy; any other rows →
   corruption. Run via the bundled SQLite driver (`better-sqlite3`) or the system `sqlite3`
   binary through `ctx.process`-style exec. Output is captured into the incident `data` for the
   doctor page. **crit** on failure.

2. **Seqno gaps (couchbase only).**
   For the couchbase store, use **ltm-reader**'s cheap **non-decoding** helpers against a
   read-only/WAL-consistent open: `maxSequence('workstreamEvents')` and
   `sequenceRange('workstreamEvents')` issue `MAX(sequence)` / `MIN(sequence)` / `COUNT(*)`
   without decoding any Fleece bodies. These keep all CouchBase schema knowledge — table-name
   escaping, the `sequence` column — inside `ltm-reader`, reusable by `doctor`. Compare the
   **max sequence** and **row count** against the previous sample: if max-seqno advanced but the
   count fell, or if there are holes beyond a tolerated window, flag a gap. A *dropping*
   max-seqno (sequence numbers should only ever increase) is a strong corruption/rollback
   signal → **crit**. `getAllDocuments` (which decodes Fleece bodies) is reserved for the one
   case that needs a decoded body — reading the newest event's timestamp for freshness.

3. **Sudden size collapse vs baseline (the headline alarm).**
   On each sweep, `statSync` the live DB file for `bytes`. Compare to the persisted
   **last-known-good baseline** (`baselineBytes`). If
   `bytes < baselineBytes * (1 - collapseRatio)` (default `collapseRatio = 0.5`, i.e. a >50%
   drop) **and** the absolute drop exceeds `minCollapseBytes` (default 1 MB, to ignore noise on
   tiny DBs), raise `size-collapse` → **crit** and emit on the bus immediately. The
   129 MB → 2.9 MB case is a 97.8% drop and trips instantly. The baseline only ratchets
   **upward** automatically (or sideways within a tolerance); it is **never** lowered by an
   unverified shrink — a shrink must be human-confirmed or accompanied by a clean integrity
   check + advancing seqno before the baseline is re-pinned (see Data model). This asymmetry is
   the whole point: a collapse can never quietly become the "new normal."

4. **WAL backlog.**
   `statSync` the sibling `-wal` file. A WAL that keeps growing and never checkpoints means
   writes are not landing in the main DB (a hung/failed checkpoint, often a precursor to data
   loss or lock contention). Warn when `walBytes > walWarnBytes` (default 64 MB); crit when
   `> walCritBytes` (default 256 MB) or when the WAL has grown across N consecutive sweeps
   without the main file growing. Also surfaces the `-shm` file's presence.

5. **Freshness — "last workstream event N minutes ago" (most important for the project goal).**
   The project exists to keep LTM capture alive, so a **stale** workstream store is the signal
   that matters most even when nothing is corrupt. Via **ltm-reader** over the read-only/
   WAL-consistent open: `getAllDocuments('workstreamEvents', 1)` decodes **just the one newest
   row** (ordered by `sequence DESC`) and reads its event timestamp from the Fleece-decoded
   `data`; the cheap `maxSequence` probe advancing across sweeps is the liveness fallback.
   `ageMinutes = now - lastEventTime`. The alarm only fires when capture **should** be
   happening: gate stale-freshness on **Pieces running and authed AND the user not idle**
   (macOS HID idle time via `CGEventSourceSecondsSinceLastEventType` / IOKit), with an
   **optional** bus subscription to `ltm-injector` activity as a sharper refinement when present
   (it must **not** hard-depend on `ltm-injector`). Under those gates, warn when
   `ageMinutes > freshnessWarnMinutes` (default 30); crit at `freshnessCritMinutes` (default
   120). This is the check that would have caught "capture silently stopped" independent of any
   size change, while staying quiet overnight or when the user is away.

6. **Query latency — constant-cost probe.**
   The latency probe must be **fixed-cost** so the signal means "contention / IO duress," not
   "the DB got bigger." Do **not** time `COUNT(*)` — it is O(rows) and would scale with DB size,
   producing false "rising latency" as data legitimately grows. Instead, **time the indexed
   `MAX(sequence)` probe already issued each sweep** (zero extra queries) for couchbase; for
   plain sqlite DBs, time a `PRAGMA page_count`. Record `latencyMs`. Warn at `latencyWarnMs`
   (default 500), crit at `latencyCritMs` (default 3000). Rising latency on a constant-cost probe
   is an early indicator of lock contention, WAL bloat, or a DB under duress before it fully
   fails.

#### Status mapping

Per DB, the worst signal wins: any **crit** signal → DB `crit`; any **warn** → `warn`; else
`ok`. The DB statuses for **critical** DBs roll up into the extension's overall health via
`ctx.health.report`.

### Contributions (HostContext)

**Health checks (`ctx.health.report`).** One check id per monitored DB, e.g.
`data.couchbase`, `data.workstream`, `data.vector`. Each sweep reports
`report('data.<id>', 'ok' | 'warn' | 'crit', detail)` where `detail` summarizes the tripped
signals (`{ bytes, baselineBytes, walBytes, maxSeqno, count, ageMinutes, latencyMs,
integrity }`). The daemon's rollup turns these into menu-bar color / dashboard banner / CLI
exit code. A `data.sweep` meta-check reports `crit` if the sweep itself failed to run.

**Incidents (`ctx.incidents.record`).** Recorded on state transitions (ok→bad), not every
sample. Enumerated kinds:

- `corruption-suspected` — `PRAGMA integrity_check` returned non-`ok`, or seqno went backwards.
  Severity crit. `data` includes the full integrity_check output and DB id.
- `size-collapse` — live size dropped past the collapse threshold vs baseline. Severity crit.
  `data` includes `{ id, bytes, baselineBytes, dropRatio, baselinePinnedAt }`. **The headline.**
- `stale-events` — workstream freshness exceeded the crit threshold while Pieces is up.
  Severity warn→crit by threshold. `data` includes `{ ageMinutes, lastEventTime, maxSeqno }`.
- `wal-backlog` — WAL exceeded crit threshold / grew N sweeps without main growth. Severity
  warn/crit.
- `db-missing` — a previously-seen critical DB file is gone. Severity crit (extreme collapse).
- `latency-degraded` — probe latency past crit threshold. Severity warn/crit.

**Notifications (`ctx.notify`).** Requested on crit transitions for `db-missing`,
`corruption-suspected`, and `size-collapse` (the user-facing emergencies). Each notify carries
an action button that **deep-links to the doctor page** for that DB
(`action: { route: '/ext/doctor?db=<id>' }`), so one click goes from alert to remediation.
Core dedups/rate-limits, so a flapping DB does not spam. `stale-events` notifies on the
crit threshold only.

**Bus emits (consumed by `backups`).** This is the cross-extension contract. The extension
publishes on `ctx.bus`:

- `data-integrity.suspect` `{ id, reason: 'corruption' | 'collapse' | 'missing', at }` — emitted
  the instant a crit corruption/collapse/missing condition is detected. **`backups` subscribes
  and SKIPS its next snapshot for that DB** so it never captures a poisoned image over a good
  one. (Mirrors the core spec's "`backups` skips a snapshot on `data-integrity.suspect`.")
- `data-integrity.recovered` `{ id, at }` — emitted when a previously-suspect DB returns to
  `ok` across a full clean sweep, so `backups` may resume.
- `data-integrity.freshness` `{ id, ageMinutes, maxSeqno, at }` — periodic freshness sample for the
  freshness widget and any subscriber (e.g. `watchdog` may use prolonged staleness as a hint
  that Pieces capture is wedged).

**Dashboard (`ctx.dashboard`).**

- **Page** `data` — a **per-DB table**: one row per monitored DB with columns *id, status,
  size (live vs baseline + delta), WAL, max seqno / count, last event age, latency, last
  integrity check, last checked*. Bad cells are colored; each row links to the doctor page for
  that DB. Rendered as a backend-TS HTML fragment by default (React island only if needed for
  live updates over WS `/events`).
- **Widget** `freshness` — a compact "last workstream event N min ago" tile for the dashboard
  grid and the menu bar, green/amber/red against the freshness thresholds. This is the
  at-a-glance answer to "is LTM capture alive right now?".

**Settings (`ctx.config`).** Namespaced schema:

```ts
interface DataIntegritySettings {
  sweepIntervalSec: number;          // default 60   (size + cheap content probes)
  integrityCheckIntervalSec: number; // default 3600 (slow-cadence deep PRAGMA integrity_check)
  databases: Array<{                 // which DBs to watch; defaults seeded from the table above
    id: string;
    glob: string;
    kind: "couchbase-lite" | "sqlite";
    critical: boolean;
    enabled: boolean;
  }>;
  collapseRatio: number;             // default 0.5  (>50% drop)
  minCollapseBytes: number;          // default 1_048_576
  walWarnBytes: number;              // default 67_108_864
  walCritBytes: number;              // default 268_435_456
  freshnessWarnMinutes: number;      // default 30
  freshnessCritMinutes: number;      // default 120
  latencyWarnMs: number;             // default 500
  latencyCritMs: number;             // default 3000
  snapshotStrategy: "vacuum-into" | "readonly-open";  // default "vacuum-into" (deep integrity scan only)
}
```

Live-reloaded via `config.onChange`; thresholds and the DB list are editable from the settings
UI / dashboard / CLI, all reading the same store.

**CLI (`ctx.cli`).** Grafted under `pmon data`:

- `pmon data status` — print the per-DB table (the dashboard page in text form); exit code from
  the rollup so it is usable in scripts/CI.
- `pmon data check [--db <id>]` — force an immediate sweep (all DBs or one), print results, and
  raise incidents/emits as a normal sweep would. Useful for "did my last change break capture?"

### Data model

Everything persists through `ctx.store` (core SQLite shim, bounded + rollup). Two namespaced
tables:

- **`baseline`** — the last-known-good, one row per DB id:
  `{ id, baselineBytes, baselineMaxSeqno, baselineCount, pinnedAt, pinnedReason }`.
  The baseline is **pinned** (created/raised) only when a sweep is fully clean for that DB
  (integrity ok, seqno non-decreasing, no collapse). It ratchets **up** automatically; it is
  **never auto-lowered** by an unverified shrink — re-pinning a lower value requires a clean
  integrity check **and** advancing seqno (a legitimate compaction), or an explicit operator
  acknowledgement via a command. This asymmetry is what makes a collapse permanently visible
  until acknowledged.
- **`history`** — bounded rolling samples for the dashboard sparkline / trend and for the
  "WAL grew N sweeps without main growth" detector:
  `{ id, ts, bytes, walBytes, maxSeqno, count, ageMinutes, latencyMs, integrity, status }`.
  Retained via the core retention/rollup (e.g. 1-minute samples for 24 h, hourly rollup beyond
  that) so it never grows unbounded — deliberately avoiding the unbounded-then-purge pattern
  that this project exists to fix.

Baseline bootstrap: on first run with no baseline row, the first baseline pin is gated on a
**clean integrity check PLUS corroborating health signals** — Pieces running + authed + a
plausible `workstreamEvents` row count + non-stale freshness. If all of those hold (the healthy
common case), the baseline is **auto-pinned silently** — no blocking prompt. If the file looks
suspiciously small against a **soft, corroboration-based floor** (not a hardcoded byte
threshold), or the store looks empty / stale on first run, the baseline is **not** pinned:
report `baseline-pending` as `warn` and surface a one-click "pin current state" confirm on the
data / doctor page. This prevents canonizing an already-collapsed DB — the exact disaster where
the monitor is installed *after* the collapse — as "normal."

## Source to reuse

**`ltm-reader`** (`packages/ltm-reader`) — read-only CouchBase-Lite reader. Exact API:

```ts
import { LtmReader, decodeFleeceToJSON } from "ltm-reader";
import type { LtmReaderOptions, CollectionName } from "ltm-reader";

// constructor: default dbPath is
//   ~/Library/com.pieces.os/production/Pieces/couchbase.cblite2/db.sqlite3
// open the LIVE file read-only / WAL-consistent for cheap per-sweep probes (NOT sql.js):
const r = new LtmReader({ dbPath: "<live path>", mode: "ro" });

// cheap NON-DECODING probes added for data-integrity (and reusable by doctor):
await r.maxSequence("workstreamEvents");           // number — MAX(sequence), no Fleece decode
await r.sequenceRange("workstreamEvents");         // { min, max, count } — MIN/MAX(sequence) + COUNT(*)

await r.stats();                                  // Record<CollectionName, number> — count per collection
await r.count("workstreamEvents");                // number — authoritative row count (cheap)
await r.getDocument("workstreamEvents", key);     // unknown | null — single Fleece-decoded doc
await r.listKeys("workstreamEvents", limit, off); // string[] — keys, ORDER BY sequence DESC
await r.getAllDocuments("workstreamEvents", limit, off);
//   Array<{ key: string; sequence: number; data: unknown }> — ORDER BY sequence DESC
//   decodes Fleece bodies; reserved for the one freshness case (decode just the newest row)
r.close();

decodeFleeceToJSON(blob, sharedKeys);             // exported standalone Fleece→JSON decoder
```

Collection names (11): `workstreamEvents`, `workstreamSummaries`, `annotations`, `hints`,
`tags`, `persons`, `websites`, `anchors`, `anchorPoints`, `wpeSources`, `wpeSourceWindows`.
We rely chiefly on `workstreamEvents` for seqno-gap, freshness, and latency probes. The cheap
non-decoding `maxSequence` / `sequenceRange` helpers are the seqno + row-count source of truth
for per-sweep probes (the latency probe times the indexed `maxSequence` query); `getAllDocuments`
is used only to decode the single newest row for freshness. All CouchBase schema knowledge
(table-name escaping, the `sequence` column, the read-only/WAL-consistent open) stays inside
`ltm-reader`, reusable by `doctor`.

**System `sqlite3`** — `PRAGMA integrity_check` / `PRAGMA quick_check` for corruption
detection (run against the snapshot), and `PRAGMA page_count` for cheap size/latency probes on
plain sqlite DBs.

**`@pieces-dev/core`** — `discoverPort` / `PiecesClient` via `ctx.pieces`, used to know whether
Pieces is actually **running and authed** (so freshness staleness is only alarming when capture
*should* be happening). Combined with **macOS HID idle time**
(`CGEventSourceSecondsSinceLastEventType` / IOKit) for user-not-idle gating, and an **optional**
bus subscription to `ltm-injector` activity as a sharper refinement when present (never a hard
dependency).

## Resolved decisions

1. **Lock-safe reads — tiered by cost / cadence.** Size collapse is caught by a free `statSync`
   of the **live** file every sweep (no DB open, instant, catches the 129 MB → 2.9 MB
   catastrophe). Routine content probes (max seqno, row count, freshness) run every sweep over a
   **read-only, WAL-consistent** SQLite connection (`mode=ro`, via `better-sqlite3`, which core
   persistence already bundles) — **not** sql.js, whose `readFileSync`-whole-file approach can
   read a torn image and ignores the WAL. The full `PRAGMA integrity_check` runs only on a
   **slow cadence** (default hourly, configurable) against a `VACUUM INTO` snapshot for a
   consistent image.
   *Rationale:* `VACUUM INTO` on a 129 MB file every 60 s is wasteful; the catastrophic signal is
   a free stat, the routine signals are cheap consistent SQL, and only the deep (least
   time-critical) corruption scan pays the snapshot cost, infrequently.

2. **Seqno read method / encapsulation.** Add two cheap **non-decoding** helpers to `ltm-reader`
   — `maxSequence(collection)` and `sequenceRange(collection)` (issuing
   `MAX(sequence)` / `MIN(sequence)` / `COUNT(*)`) — plus a read-only / WAL-consistent open mode;
   `data-integrity` calls these. `getAllDocuments` (which decodes Fleece bodies) is reserved for
   when the newest event's timestamp is needed (freshness: decode just the one newest row).
   *Rationale:* keeps CouchBase schema knowledge (table-name escaping, the `sequence` column)
   inside `ltm-reader`, reusable by `doctor`, and avoids decoding bodies on every sweep.

3. **Latency probe — constant cost.** Do **not** time `COUNT(*)` (O(rows) — scales with DB size
   and creates false "rising latency" as data grows). Time the fixed-cost indexed `MAX(sequence)`
   probe already issued each sweep (zero extra queries); for plain SQLite DBs, time a
   `PRAGMA page_count`.
   *Rationale:* a latency signal must be constant-cost to mean "contention / IO duress" rather
   than "bigger DB."

4. **Baseline bootstrap.** Gate the first baseline pin on a **clean integrity check plus
   corroborating health signals** (Pieces running + authed + plausible `workstreamEvents` row
   count + non-stale freshness). If those hold, auto-pin silently. If the file is suspiciously
   small against a **soft, corroboration-based floor** (not a hardcoded byte threshold), or the
   store looks empty / stale on first run, do not pin — report `baseline-pending` as `warn` and
   surface a one-click "pin current state" confirm on the data / doctor page; no blocking prompt
   in the healthy case.
   *Rationale:* prevents canonizing an already-collapsed DB (monitor installed *after* the
   collapse) as "normal."

5. **Freshness vs activity.** Gate stale-freshness alarms on **Pieces running and authed AND the
   user not idle** (macOS HID idle time via `CGEventSourceSecondsSinceLastEventType` / IOKit),
   with an **optional** bus subscription to `ltm-injector` activity as a sharper refinement when
   present (must not hard-depend on `ltm-injector`).
   *Rationale:* the meaningful alarm is "actively working but capture stopped"; alarming
   overnight / away is noise.

## Verification

- `pnpm build` and `pnpm test` green for the package.
- **Unit (Vitest):** size-collapse detector trips on a synthetic 129 MB → 2.9 MB baseline-vs-live
  pair and does **not** trip on a small legitimate compaction within tolerance; baseline ratchets
  up but never auto-lowers on an unverified shrink; seqno-gap detector flags a dropped/holed
  sequence and ignores a normal monotonic advance; WAL detector warns/crits at thresholds and on
  "N sweeps growing without main growth"; freshness math (`ageMinutes`) and warn/crit thresholds;
  status rollup (worst-signal-wins) per DB; settings schema validation + `onChange` reload.
- **Integration:** point the sweep at a fixture DB tree; corrupt one file and confirm
  `PRAGMA integrity_check` failure → `corruption-suspected` incident + `data-integrity.suspect`
  emit; delete a critical file → `db-missing`; truncate a file past `collapseRatio` →
  `size-collapse` incident + notify with a doctor deep-link.
- **Bus contract:** a stub `backups` subscriber receives `data-integrity.suspect` and confirms
  it would skip its next snapshot; `data-integrity.recovered` is emitted after a clean sweep.
- **Live smoke (Pieces running):** `pmon data status` prints the per-DB table with real sizes,
  WAL, max seqno, last-event age, and latency for the actual couchbase store; `pmon data check`
  forces a sweep; the dashboard `data` page renders the table and the `freshness` widget shows a
  live "last event N min ago" against the running install — read with the configured
  `snapshotStrategy` and **without** disrupting Pieces' own writes.
