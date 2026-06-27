# Plan: Pieces OS 9-Month Retention — Prevention Strategy

## Context

Pieces OS has a hard, non-configurable 9-month TTL on all locally-stored data: workstream events, workstream summaries, copilot conversations, and code assets are auto-deleted once they age past 9 months. There is one exception: data pinned with `create_pieces_memory` has no expiry.

The `pieces-dev` project (`/Users/joe/github/joeblackwaslike/pieces-dev/`) already exists and partially addresses this via continuous event injection (`ltm-injector`) and gap reconstruction (`gap-reconstruct`), but neither of those constitutes a true backup against the retention cliff.

---

## Phase 0 — Rescue existing data immediately

Before building any automation, there are up to 9 months of context currently in Pieces that may already be approaching the TTL cliff. This needs to be addressed now, not after the tooling is built.

### Step 0a — Full export NOW

With Pieces OS running, hit `GET http://localhost:1000/database/export` once manually (or via `curl`) and save the JSON to a safe location (Google Drive, external drive). This captures everything currently stored: assets, conversations, workstream summaries, annotations. Size will be large — pipe through `gzip`.

```bash
curl http://localhost:1000/database/export | gzip > ~/Desktop/pieces-rescue-$(date +%Y-%m-%d).json.gz
```

Also copy the raw SQLite DB as insurance:

```bash
cp ~/Library/com.pieces.pfd/production/pieces_client_sqlite.db ~/Desktop/pieces-rescue-$(date +%Y-%m-%d).db
```

### Step 0b — Assess what's already gone

Query the SQLite DB to find the oldest surviving records and determine if anything has already been deleted:

```bash
sqlite3 ~/Library/com.pieces.pfd/production/pieces_client_sqlite.db \
  "SELECT MIN(created), MAX(created) FROM workstream_summaries"
```

If the oldest record is recent (< 9 months), data may already have been purged — this tells you the gap to reconstruct.

### Step 0c — Reconstruct historical gaps via `gap-reconstruct`

The `gap-reconstruct` tool in `pieces-dev` is specifically designed for this: it synthesizes workstream events from Claude Code session transcripts, macOS Screen Time, Arc browser history, and git logs. This re-injects historical context back into Pieces, giving it a fresh TTL. Run this against the full available history to fill any gaps left by prior deletions.

### Step 0d — Bulk-import claude-mem history as Pieces memories

The claude-mem observation store has no retention limit and contains structured summaries of every session going back to when it was set up. These observations are exactly the kind of "key context" that `create_pieces_memory` is meant to store. A one-time bulk import script can:

1. Query all claude-mem observations via `get_observations` MCP tool
2. POST each as a Pieces memory via the Pieces REST API
3. This creates a permanent, indefinite archive of all captured session context

This is the highest-leverage recovery action: it's durable by design and doesn't depend on Pieces OS's retention policy at all.

---

## Three-Layer Defense (ongoing)

### Layer 1 — Automated indefinite pinning (two sub-approaches)

**1a — CLAUDE.md instruction (immediate, zero-build)**

Add a rule to `~/.claude/CLAUDE.md` that instructs Claude to call `create_pieces_memory` at the end of every session for: architectural decisions, debugging breakthroughs, significant discoveries, completed features. Claude follows this automatically every session as long as Pieces OS is running and the MCP server is connected. This fires even without explicit user action.

**1b — claude-mem → Pieces bridge script (build)**

The claude-mem observation store is a local PostgreSQL database with no retention limit — it already captures session-level context automatically. A scheduled bridge script can query recent claude-mem observations and post each as a Pieces memory via the Pieces OS REST API. This runs without any active Claude session, covering gaps between sessions and ensuring all captured context flows into the indefinite Pieces memory store.

Schedule: daily via launchd at low-impact hour (e.g., 3am). Only post observations created since the last successful run (tracked in a small state file).

### Layer 2 — Regular export/snapshot backup (build this)

The Pieces OS REST API exposes `GET /database/export` which returns a full `ExportedDatabase` JSON covering all assets, conversations, workstream summaries, tags, annotations, anchors, persons, and websites.

Additionally, the raw SQLite database can be copied directly:

- Path: `~/Library/com.pieces.pfd/production/pieces_client_sqlite.db` (~1.3 GB)

**Build**: a TypeScript export script in `packages/exporter/` that:

1. Hits `GET http://localhost:1000/database/export`
2. Writes the JSON response to a timestamped file: `~/Library/com.pieces.pfd/backups/YYYY-MM-DD.json.gz`
3. Optionally copies the raw SQLite DB alongside it
4. Prunes backups older than 12 months (keeping at least the 3 most recent regardless)
5. Exits non-zero if Pieces OS is not running (don't silently skip)

**Schedule**: monthly via launchd plist at `~/Library/LaunchAgents/com.joe.pieces-backup.plist`, running on the 1st of each month.

**Storage**: back up to Google Drive via the existing `backup-to-drive.sh` script in `mac-bootstrap`, or to a dedicated directory in `pieces-dev/backups/` (with `.gitignore` for large files, keeping only manifests).

### Layer 3 — Keep data alive via `ltm-injector` (already in progress)

The `ltm-injector` VS Code extension continuously injects workstream events as you work, keeping recent activity perpetually within the 9-month window. Completing this work means the 9-month cliff only threatens historical data during periods of complete inactivity. This is a complement to Layer 2, not a replacement.

---

## Update Cadence for the Procedure Itself

The export schema (`ExportedDatabase`) may change across Pieces OS major versions.

Keeping the procedure current:

- **What to update**: the export script's response type (if `/database/export` schema changes), and the `working-with-pieces` skill reference docs
- **When**: after any Pieces OS major version bump — check the app's release notes or `GET /health` version field in the export script header
- **How**: the existing `make update-working-with-pieces` target runs the fetch script; the export script should log the Pieces OS version in each backup manifest so drift is detectable
- **Cadence for docs**: weekly auto-update already handled by CI

---

## Implementation Plan

### Phase 0: Rescue existing data (do this first)

1. Start Pieces OS if not running
2. Run the manual `curl` export + SQLite copy → save to Google Drive
3. Query SQLite to see how far back data survives
4. Run `gap-reconstruct` against full available Claude Code transcript history
5. Write + run a one-time bulk claude-mem → Pieces memories import script

### Phase 1: Export script (new package in `pieces-dev`)

- **Package**: `packages/exporter/` with `src/export.ts`
- **Core logic**:
  - `PiecesClient` from `@pieces-dev/core` for port discovery
  - `fetch` to call `GET /database/export`
  - `zlib` to gzip the output
  - `fs` to write timestamped file + copy SQLite DB
  - CLI entry: `pieces-export` (no args needed, reads port from `PiecesClient`)
- **Output manifest**: each backup writes a `manifest.json` with: timestamp, Pieces OS version, asset count, conversation count, export size

### Phase 2: launchd plist

- File: `~/Library/LaunchAgents/com.joe.pieces-backup.plist`
- Runs: absolute path to compiled `pieces-export` binary
- Schedule: `StartCalendarInterval` → day 1, hour 2 (2am on the 1st of each month)
- StdOut/StdErr: log to `~/Library/Logs/pieces-backup.log`
- Add setup step to `mac-bootstrap`

### Phase 3: Pruning + Google Drive sync

- Add pruning logic in export script: keep last 3 + any from the past 12 months
- Wire into `backup-to-drive.sh` in `mac-bootstrap`: rsync `~/Library/com.pieces.pfd/backups/` to the existing Drive backup destination

---

## Files to Create/Modify

| Path | Action |
| --- | --- |
| `packages/exporter/src/export.ts` | Create — main export logic |
| `packages/exporter/package.json` | Create — package manifest |
| `~/Library/LaunchAgents/com.joe.pieces-backup.plist` | Create — launchd schedule |
| `mac-bootstrap/scripts/backup-to-drive.sh` | Modify — add Pieces backup dir to rsync |
| `mac-bootstrap/setup/pieces.sh` | Create or modify — register launchd plist |

---

## Verification

1. Run `pieces-export` manually with Pieces OS running → confirm file written to `~/Library/com.pieces.pfd/backups/`
2. Check `manifest.json` contains expected asset/conversation counts vs. what's visible in the Pieces Desktop app
3. Confirm gzip file opens correctly
4. Test launchd by running `launchctl start com.joe.pieces-backup` and checking the log
5. Confirm Google Drive sync picks up the new backup directory
