# Pieces Monitor — doctor extension (design)

## Context

`doctor` is the diagnostics-and-repair umbrella for Pieces Monitor — the "fix-it" panel a
user lands on when something is wrong and they want it fixed. It does not generate its own
problem signals from scratch; it **aggregates** them from the platform core (health rollup,
recent incidents) and from data-integrity signals, then offers one-click repairs.

It is the convergence point for the rest of the system. Other extensions (`watchdog`,
`data-integrity`, `backups`, `metrics`) request notifications through the core notify
service; those macOS notifications carry an action button that **deep-links to a doctor
dashboard page** (e.g. `pmon://doctor?problem=corruption-suspected`). So when the user
clicks "Fix it" on a corruption-suspected alert, they arrive in `doctor` with the relevant
problem pre-selected and the right repair action ready to run.

The motivating disaster — the dual-instance bug that collapsed the CouchBase Lite DB from
129 MB to 2.9 MB with no early warning and no single place to act — is exactly what `doctor`
exists to make recoverable: detect the integrity collapse, restore from a `backups` snapshot,
backfill the lost window with `gap-reconstruct`, and re-establish the Pieces sign-in, all
from one panel without the user assembling a CLI incantation.

## Platform assumptions

- An extension is an **in-process TypeScript module** exporting `Extension` (`id`, `name`,
  `version`, `activate(ctx)`, optional `deactivate()`), receiving a `HostContext` (`ctx`).
- `ctx` surfaces the platform primitives this extension uses: `store`, `config`, `health`,
  `incidents`, `log`, `bus` (pub/sub), `schedule`, `notify`, `api`, `commands`,
  `process` (safe launch/kill/restart of Pieces), `menu`, `dashboard`, `cli`, `pieces`.
- **Commands = verbs**; API routes = nouns. A command registered once dispatches identically
  from the dashboard page, the `pmon` CLI, and `POST /actions/:id`.
- Core owns the **single-instance / anti-dual-instance** Pieces lifecycle policy inside
  `process` (`open -a`, never `Popen`; pre-launch PID guard; duplicate killer). `doctor`
  never launches or kills Pieces directly — it always goes through `ctx.process`.
- `process` control is the only sanctioned way to stop/start Pieces; the same policy that
  prevents the dual-instance bug also makes a restore-time stop/start safe.
- Conventions: TS strict, ESM only, Node 22+, Biome, Vitest, no `any` (`unknown` + narrowing),
  no barrel files except the package entry point.

## Purpose & scope

`doctor` ships:

1. A **dashboard "fix-it" page** that lists detected problems (from health rollup + recent
   incidents + data-integrity signals) with a one-click repair action per problem.
2. Four **repair commands** (verbs), invokable from the page, CLI, or API: run
   gap-reconstruct, restore-from-backup, re-login (open Pieces to sign in), run integrity
   check.
3. A **`pmon doctor`** CLI namespace: `detect | fix | gaps | restore`.
4. **Incident records** for every repair performed (what, when, outcome).
5. **Settings**: default gap-reconstruct sources, lookback window, min-gap threshold.

Out of scope: producing the integrity/corruption signals themselves (that is
`data-integrity`), taking the snapshots (that is `backups`), and the process-supervision
loop (that is `watchdog`). `doctor` consumes and coordinates those, it does not replace them.

## Design

### Diagnostics

`doctor` builds a single ranked **problem list** by merging three signal sources into a
normalized `Problem` shape:

```ts
type ProblemKind =
  | 'corruption-suspected'   // data-integrity / DB size collapse
  | 'ltm-gap'                // gap-reconstruct detected gap
  | 'auth-lost'              // Pieces signed out
  | 'pieces-down'            // process not running / unhealthy
  | 'health-warn'            // any core health check in warn/crit
  | 'restart-loop';          // watchdog restart churn

interface Problem {
  id: string;                // stable key for dedup + deep-link target
  kind: ProblemKind;
  severity: 'warn' | 'crit';
  summary: string;
  detail?: unknown;
  detectedAt: number;
  suggestedAction: { commandId: string; params?: Record<string, unknown> };
}
```

Aggregation sources:

- **Health rollup** — `ctx.health` exposes the per-check status. Any check in `warn`/`crit`
  becomes a `health-warn` (or a more specific kind when the checkId is recognized, e.g. a
  Pieces-health check maps to `pieces-down`).
- **Recent incidents** — `ctx.incidents` query for recent records of kind
  `corruption-suspected`, `auth-lost`, `crash`, `restart`. Unresolved incidents within the
  lookback window become problems; the most recent wins on dedup by `kind`.
- **Data-integrity signals** — `data-integrity` emits on the bus (e.g.
  `data-integrity.suspect` with the size-collapse detail). `doctor` subscribes
  via `ctx.bus.on(...)` and folds the live signal into the list immediately (and persists a
  problem snapshot to `ctx.store` so the page is correct on cold load).
- **LTM gaps** — computed on demand by calling `detectGaps()` (see Source to reuse). Gaps are
  surfaced as `ltm-gap` problems whose `suggestedAction` is the gap-reconstruct command
  pre-filled with `from`/`to`.

Ranking: `crit` before `warn`, then most-recent `detectedAt`. The list is read by the
dashboard page and the `pmon doctor detect` command; it is recomputed on bus signals and on a
light `ctx.schedule` interval so the panel stays fresh.

### Repair actions

Each repair is a registered **command** (`ctx.commands.register`), so it dispatches the same
way from the fix-it page button, `pmon doctor fix`, and `POST /actions/:id`.

- **`doctor.gap-reconstruct`** — params `{ from?: string; to?: string; allGaps?: boolean;
  since?: string; sources?: string[]; minGapMinutes?: number; dryRun?: boolean }`. Resolves
  the window (explicit `from`/`to`, or `detectGaps()` for `allGaps`), then runs the
  gap-reconstruct pipeline (see Source to reuse). Long-running; streams progress (below).
  Defaults for `sources`/`since`/`minGapMinutes` come from settings.
- **`doctor.restore`** — params `{ backupId: string }`. Restores a `backups` snapshot over the
  live CouchBase Lite DB. **Destructive**; requires the watchdog stand-down handshake
  (below) and explicit confirmation. Records the restore as an incident.
- **`doctor.relogin`** — params `{}`. Opens the Pieces desktop app so the user can sign back
  in. Goes through `ctx.process` (`open -a "Pieces"`) — never a raw spawn — and falls back to
  a deep link if needed. Non-destructive; no stand-down required.
- **`doctor.integrity-check`** — params `{}`. Runs an integrity check (delegates to
  `data-integrity`'s check command if present, else a built-in `ltm-reader`-backed size/row
  sanity pass) and writes the result back into the problem list and an incident.

Every action records an incident via `ctx.incidents.record({ kind, severity, summary, data })`
on completion (success or failure) so the "when & why" trail is preserved — the missing piece
during the original disaster.

### Restore coordination

A restore overwrites the live DB, so **Pieces must be stopped first** and must **stay
stopped** until the restore completes. The danger is `watchdog`: its job is to relaunch Pieces
the moment it sees the process gone, which would corrupt a half-written restore or re-trigger
the dual-instance path. The handshake exists so watchdog stands down voluntarily rather than
fighting the restore.

Handshake (all over `ctx.bus` + `ctx.process`):

1. `doctor` emits **`doctor.restore-begin`** `{ restoreId, expectedDurationMs }`.
2. `watchdog` receives it, enters **stand-down**: it suspends its auto-relaunch loop and
   acknowledges with **`watchdog.standby-ack`** `{ restoreId }`. `doctor` waits for the ack
   (with a timeout; on timeout it aborts the restore and surfaces a problem rather than racing
   watchdog).
3. `doctor` calls **`ctx.process.stop()`** (core's safe kill) to bring Pieces down, and
   confirms via PID discovery that no Pieces instance is running.
4. `doctor` performs the file-level restore: snapshot the current DB aside (safety copy),
   write the chosen `backups` snapshot into place, verify with `ltm-reader` (open + row/size
   sanity) before committing.
5. `doctor` calls **`ctx.process.restart()`** (or `start()`) to bring Pieces back via the
   core `open -a` + PID-guard policy.
6. `doctor` emits **`doctor.restore-end`** `{ restoreId, ok }`. `watchdog` resumes its normal
   relaunch loop on receipt. A core/watchdog **dead-man timer** also auto-resumes watchdog if
   `restore-end` never arrives (e.g. `doctor` crashed mid-restore), so the system never gets
   stuck with watchdog permanently disabled.
7. `doctor` records a `restore` incident with the outcome and the safety-copy location.

**Progress streaming** for both restore and the (often multi-minute) gap-reconstruct run: the
command opens a per-run channel on the API/WS surface. `doctor` registers an endpoint under
`/api/ext/doctor/runs/:runId` and pushes progress frames over `WS /events` (and/or the
namespaced WS). The gap-reconstruct pipeline's stdout-style progress (per-source counts,
`injected/failed` running totals, summary-generation status) is adapted into structured
frames `{ runId, phase: 'collect'|'inject'|'summarize', done, total, failed }`. The fix-it
page subscribes and renders a live progress bar; the CLI prints the same frames as it streams.

### Contributions (HostContext)

- **`ctx.dashboard`** — registers the **fix-it page** (route `/doctor`, React island for the
  live problem list + per-problem action buttons + live progress bars). Accepts a
  `?problem=<id>` query param so deep-linked notifications open with the relevant problem
  pre-selected and its suggested action focused.
- **`ctx.commands`** — registers `doctor.gap-reconstruct`, `doctor.restore`, `doctor.relogin`,
  `doctor.integrity-check` (verbs; uniform dispatch across page/CLI/API).
- **`ctx.cli`** — grafts the **`pmon doctor`** namespace onto the CLI:
  - `pmon doctor detect` — print the aggregated problem list (exit non-zero if any `crit`).
  - `pmon doctor fix [--problem <id>] [--yes]` — run the suggested action for a problem (or all
    auto-fixable); `--yes` skips the destructive-action confirmation.
  - `pmon doctor gaps [--since <iso|Nd>] [--min-gap <min>] [--run] [--sources <list>]
    [--dry-run]` — detect gaps; with `--run`, dispatch `doctor.gap-reconstruct`.
  - `pmon doctor restore --backup <id> [--yes]` — dispatch `doctor.restore` with the
    stand-down handshake; `--yes` required (or interactive confirm) for the destructive write.
- **`ctx.incidents`** — records one incident per repair (`gap-reconstruct`, `restore`,
  `relogin`, `integrity-check`) with outcome and data.
- **`ctx.bus`** — subscribes to `data-integrity.*` problem signals; emits/consumes the restore
  handshake events (`doctor.restore-begin`, `watchdog.standby-ack`, `doctor.restore-end`).
- **`ctx.process`** — `stop()`/`start()`/`restart()`/PID-discovery for the restore stop-start
  and `open -a "Pieces"` for re-login. Never a raw spawn.
- **`ctx.config`** — settings: `defaultSources` (`['claude','screentime','arc','git']`),
  `lookbackDays` (default 30), `minGapMinutes` (default 60), `reconcileConcurrency`,
  `skipSummaries`, `gitRepos` (paths for the git source), `standbyAckTimeoutMs`.
- **`ctx.store`** — persists the last computed problem snapshot and per-run progress/outcome.
- **`ctx.health`** — read for rollup-derived problems; `doctor` may report its own
  `doctor:last-repair` check (warn if the most recent repair failed).
- **`ctx.schedule`** — light interval to recompute the problem list so the panel stays fresh.

## Source to reuse

From **`gap-reconstruct`** (`packages/gap-reconstruct/src/`):

- `runPipeline(options: PipelineOptions): Promise<void>` (`pipeline.ts`) — the backfill engine.
  `PipelineOptions = { from: Date; to: Date; sources: string[]; dryRun: boolean; limit?:
  number; concurrency: number; skipSummaries: boolean; repos?: string[]; portOverride?:
  number }`. Internally: `createSources()` → `collectAll()` → `dedup()` (priority
  `claude < screentime < git < arc`) → `injectEvents()` (concurrent `client.postEvent`) →
  `generateSummaries()` (`client.triggerSummary` per day). Also exported: `dedup(events)`.
- `detectGaps(since: Date, until: Date, minGapMs: number): Promise<Gap[]>` (`gap-detector.ts`)
  — discovers the port, health-checks, pulls events via `client.getEvents()`, returns
  `Gap[]` (`{ from: Date; to: Date }`) including leading/trailing gaps; an empty range is
  returned as one full-range gap. Also exported: `findGapsInTimeline(events, minGapMs)`.
- Source collectors in `sources/` (each `implements Source` = `{ name; collect(from, to):
  AsyncIterable<SourceEvent> }`): `ClaudeCodeSource` (`name: 'claude'`, tails
  `~/.claude/projects/**/*.jsonl`), `ScreenTimeSource` (`name: 'screentime'`,
  `knowledgeC.db`), `ArcHistorySource` (`name: 'arc'`, Arc `History` db),
  `GitLogSource(repos)` (`name: 'git'`, `git log --name-only`). Source string keys used by
  `createSources` / CLI: `claude,screentime,arc,git`.
- CLI option shape to mirror (from `cli.ts`): `--from`, `--to`, `--all-gaps`, `--since`
  (`Nd` or ISO), `--min-gap` (minutes → `minGapMs = min * 60_000`), `--sources`, `--dry-run`,
  `--limit`, `--concurrency` (default 5), `--skip-summaries`, `--repos`, `--port`.

**Reuse strategy:** call `runPipeline`/`detectGaps` directly. To stream progress instead of
relying on the pipeline's `console.log`, factor a progress callback into `PipelineOptions`
(small, additive change to `gap-reconstruct`) or wrap stdout — see open questions.

From **`ltm-reader`** (`packages/ltm-reader/src/`): `new LtmReader({ dbPath? })` over the live
CouchBase Lite DB (`~/Library/com.pieces.os/production/Pieces/couchbase.cblite2/db.sqlite3`),
with `count(collection)`, `stats()` (all collection row counts, `-1` on failure),
`getAllDocuments(...)`. Used by `doctor.integrity-check` and by the post-restore verification
step (open + row/size sanity before committing the restored DB).

From **`backups`** (sibling extension): `doctor.restore` consumes its snapshots. Expected
contract — `backups` exposes a list of snapshots (id, timestamp, size, db path) via its API/a
shared command, and `doctor` reads it to populate the restore picker and to resolve a
`backupId` to a snapshot file. The file-level write + safety-copy lives in `doctor` (it owns
the stop/restore/start sequence); `backups` owns capture/retention.

## Open questions

- **Restore safety / guardrails:** Where does the pre-restore safety copy live, and how long
  is it retained — own `doctor` retention, or hand it to `backups` as a synthetic snapshot?
  Should a restore refuse to run if the chosen snapshot is *smaller* than the current DB
  (guarding against restoring an already-collapsed backup over good data)?
- **Stand-down ack timeout & dead-man timer:** What are sane defaults for
  `standbyAckTimeoutMs` and the watchdog auto-resume dead-man timer, and which component owns
  the dead-man timer — core, `watchdog`, or `doctor`? If watchdog never acks, do we hard-abort
  or fall back to a core-level "I will hold watchdog down" lock?
- **Progress streaming mechanism:** Add a `onProgress?(frame)` callback to `PipelineOptions`
  (clean, but edits `gap-reconstruct`), or wrap/intercept the pipeline's `console.log`
  (no upstream change, but brittle string parsing)? Preference is the callback.
- **Destructive-action confirmation:** What is the confirmation UX across surfaces — the
  page needs a typed/explicit confirm modal; the CLI uses `--yes` or an interactive prompt;
  does `POST /actions/doctor.restore` require an extra confirm token beyond the standard
  bearer/CSRF, so a stray scripted call can't wipe the DB?
- **Auto-fix vs. user-initiated:** Should `doctor` ever auto-run a non-destructive repair
  (e.g. backfill a freshly detected gap) on a schedule, or always wait for a click/CLI verb?
- **Deep-link scheme:** confirm the `pmon://doctor?problem=<id>` deep-link form and how the
  notify action button hands off to the dashboard page (browser URL vs. custom scheme handled
  by the menu-bar app).

## Verification

- `pnpm build` and `pnpm test` green for the `doctor` extension package.
- **Diagnostics:** Vitest covers the aggregator — health `warn`/`crit` → problems, recent
  unresolved incidents → problems (dedup by kind, most-recent wins), a `data-integrity` bus
  signal folds in live and persists to `store`, and `detectGaps()` results surface as
  `ltm-gap` problems with a pre-filled `suggestedAction`. Ranking puts `crit` before `warn`.
- **Commands:** each of the four commands dispatches identically via `pmon doctor` and
  `POST /actions/:id`; `doctor.gap-reconstruct` with `dryRun` collects without injecting;
  every command records exactly one incident with the correct outcome.
- **Restore handshake (integration, mocked process/bus):** `doctor.restore-begin` is emitted
  and the restore blocks until `watchdog.standby-ack`; on ack-timeout the restore aborts and
  raises a problem; `ctx.process.stop()` is called and PID-clear is confirmed before any
  file write; `doctor.restore-end` is emitted and watchdog resumes; the dead-man timer
  auto-resumes watchdog when `restore-end` never fires. A restore over a verified-bad DB
  refuses (safety guardrail) per the resolved open question.
- **Progress streaming:** a long-running `doctor.gap-reconstruct` emits ordered
  `collect → inject → summarize` frames on `WS /events`; the page progress bar advances and
  the CLI prints the same frames.
- **End-to-end (local):** trigger a `data-integrity.suspect` signal → it appears on `/doctor`
  with a "Restore from backup" action → run a restore against a fixture snapshot →
  `ltm-reader` post-restore verification passes → Pieces restarts via `ctx.process` → an
  incident is recorded. `pmon doctor detect` exits non-zero while a `crit` problem is open and
  zero once cleared. `pmon doctor restore` refuses without `--yes`.
- **Re-login:** `doctor.relogin` invokes `ctx.process` `open -a "Pieces"` (asserted via mock),
  never a raw spawn.
