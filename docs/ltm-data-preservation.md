# LTM Data Preservation: Solving Pieces OS Event Pruning

## The Problem

Pieces OS permanently deletes readable workstream event data from its CouchBase Lite document store after ~5 days on the free plan. The compiled Dart binary performs hard purges (not soft deletes) — no TTL field, no tombstones, no configuration. The data is irrecoverable once gone.

### What's Lost

| Data | Stored In | Retention | Recoverable? |
|------|-----------|-----------|-------------|
| Event text (readable, clipboard, context) | CouchBase Lite | ~5 days | No — hard purged |
| Window titles, browser URLs | CouchBase Lite | ~5 days | No — hard purged |
| AI annotations, hints, summaries | CouchBase Lite | ~5 days | No — hard purged |
| FTS index entries | CouchBase Lite | Mirrors docs | No — purged with docs |
| 512-dim vector embeddings | Vector DB (SQLite) | ~9 months | Yes, but no text content |
| UUID + timestamps | Vector DB | ~9 months | Yes, but metadata only |

### Evidence

- CouchBase Lite sequence numbers range 480–120,186 (~120K documents created over time)
- Only 19,583 documents remain (~5 days), 11 tombstones
- Vector DB retains 123,976 entries spanning 285 days — but they're opaque float arrays
- The API returns exactly what CouchBase Lite contains — no server-side filter, the data simply doesn't exist anymore

### Key Constraint

The pruning logic is compiled into the Pieces OS Dart/Flutter AOT binary at `/Applications/Pieces OS.app/`. It is not configurable, not exposed via API, and not visible in the SDK. Any solution must work *around* the binary, not modify it.

---

## Solution Space

### Tier 1: Interception (Capture Before Pruning)

These approaches capture event data before Pieces OS prunes it, building a parallel archive.

#### 1A. Real-Time Event Stream Interception

**How:** Our `ltm-injector` VS Code extension already captures IDE events (file edits, tabs, clipboard, terminal, git, debug sessions) and sends them to the Pieces API. Fork the event pipeline so events are simultaneously written to our own persistent store before (or in addition to) being sent to Pieces.

**Pros:**
- Already partially built — `ltm-injector` captures most event categories
- Zero-latency capture — events archived at creation time, not after
- No dependency on Pieces OS database format or internals
- Survives Pieces OS updates

**Cons:**
- Only captures events from VS Code — misses browser activity, other IDEs, non-extension sources
- Doesn't capture Pieces' AI-generated derivatives (annotations, hints, summaries)
- Requires the extension to be running

**Coverage:** ~60-70% of events (IDE-originating only)

#### 1B. API Polling Archive

**How:** A daemon/cron job that polls the Pieces REST API (port 39301) every N minutes, fetching all workstream events and writing new ones to a local archive (NDJSON, SQLite, or similar).

**Pros:**
- Captures ALL event types, including non-IDE sources (browser, other apps)
- Captures AI-generated content (annotations, hints, summaries)
- Simple to implement — just HTTP GET + dedup
- No database format coupling

**Cons:**
- Race condition — if pruning happens between polls, data is lost
- Polling frequency vs. system load tradeoff (every 1 min? 5 min? 1 hour?)
- API returns ~19K events — parsing the full set each poll is wasteful
- Need smart deduplication by event ID

**Coverage:** ~95%+ if polling frequency is high enough (sub-hourly)

**Risk:** The pruning schedule is unknown. If Pieces prunes daily, hourly polling is fine. If it prunes continuously or on event insertion, there's a window where events could be captured by Pieces and pruned before our next poll.

#### 1C. CouchBase Lite Database Polling

**How:** Use our `ltm-reader` tool to directly read the CouchBase Lite SQLite database on a schedule, extracting and archiving all documents. Reads the Fleece-encoded bodies via FFI to libcblite.

**Pros:**
- Reads the authoritative data source, not a filtered API view
- Gets the raw Fleece documents with all fields
- `ltm-reader` already works

**Cons:**
- Same race condition as API polling — pruned between reads = lost
- Coupled to CouchBase Lite's Fleece encoding and SharedKeys format
- Requires Pieces OS to be installed (for libcblite.dylib FFI)
- Could break on Pieces OS updates if they change the schema or SharedKeys

**Coverage:** ~95%+ with frequent enough polling

#### 1D. SQLite Change Notification / WAL Monitoring

**How:** Monitor the CouchBase Lite SQLite database's Write-Ahead Log (WAL) for changes in real time. When new rows appear in `kv_.workstream\Events`, immediately read and archive them. When rows are deleted, we've already captured them.

**Pros:**
- Near-zero latency — captures events as they're written
- Captures deletions too — we can log what was pruned and when
- No polling overhead

**Cons:**
- Extremely fragile — WAL format is an SQLite internal, not a stable API
- CouchBase Lite may checkpoint the WAL at any time, making changes invisible
- Read contention with the running Pieces OS process
- macOS file locking semantics could cause issues
- Would need to parse SQLite WAL format directly

**Coverage:** Theoretically 100%, practically too fragile to rely on

#### 1E. Filesystem Event Monitoring (FSEvents / kqueue)

**How:** Use macOS FSEvents API to watch the CouchBase Lite database directory for file modifications. When the DB file changes, diff the current state against our last snapshot.

**Pros:**
- OS-level notification, no polling
- Well-supported on macOS

**Cons:**
- FSEvents tells you *a file changed*, not *what changed inside it*
- Still need to open the SQLite DB to read the actual content
- Diffing a 159 MB database file on every write is expensive
- Same race condition if Pieces writes + prunes in one transaction

**Coverage:** Similar to 1C but with lower latency notification

---

### Tier 2: Replication (Mirror the Database)

These approaches create a live replica of the CouchBase Lite database that Pieces OS can't prune.

#### 2A. CouchBase Lite Replication Protocol

**How:** CouchBase Lite supports a replication protocol (WebSocket-based) for syncing databases between peers. Stand up a replication target (CouchBase Server, CouchBase Lite peer, or Sync Gateway) that Pieces OS replicates to. Our replica retains everything; Pieces prunes its own copy.

**Pros:**
- Built into CouchBase Lite — designed for exactly this use case
- Gets all documents, revisions, and deletions in real time
- No polling, no race conditions
- Our replica is a full CouchBase Lite database — same query capabilities

**Cons:**
- Pieces OS would need to be configured to replicate to our target — we don't control its replication config
- The replication config is in the compiled Dart binary
- CouchBase Sync Gateway is a heavy dependency
- May need commercial CouchBase licensing for Sync Gateway

**Coverage:** 100% if we could configure it — but we almost certainly can't

**Verdict:** Architecturally perfect, practically impossible without modifying Pieces OS config.

#### 2B. SQLite-Level Database Replication

**How:** Use a tool like Litestream or rqlite to create a continuous replica of the SQLite database file. Litestream streams WAL changes to S3/local, giving point-in-time restore.

**Pros:**
- Captures every database state change including deletions
- Point-in-time restore means we can recover any document at any time
- Litestream is battle-tested for SQLite replication
- No CouchBase-specific tooling needed

**Cons:**
- CouchBase Lite's SQLite database uses Fleece encoding — restoring old snapshots still requires Fleece decoding
- Litestream may conflict with CouchBase Lite's own WAL management
- Storage grows unbounded (every state change is preserved)
- Recovery requires restoring a full database snapshot and querying it

**Coverage:** 100% — every write is captured, including pre-prune state

**This is a strong candidate.** Litestream can run as a background process, continuously replicating the SQLite WAL to local storage. Even if Pieces prunes a document, we can restore the database to a point before the prune and extract the document.

#### 2C. Periodic SQLite Snapshots

**How:** Copy the entire CouchBase Lite SQLite database file on a schedule (hourly/daily). Keep N snapshots. When data is pruned, restore from the most recent snapshot that still has it.

**Pros:**
- Dead simple — just `cp db.sqlite3 archive/db-$(date).sqlite3`
- No special tooling
- Each snapshot is independently queryable

**Cons:**
- 159 MB per snapshot, ~4 GB/day at hourly frequency
- Same race condition as polling — prune between snapshots = lost
- Need to manage snapshot rotation and storage
- Querying across snapshots to find a specific document is tedious

**Coverage:** High, but dependent on snapshot frequency

---

### Tier 3: Bypass (Replace the Query Layer)

These approaches accept that Pieces prunes its own database, and build a separate query layer over preserved data.

#### 3A. Parallel Event Database + Custom API

**How:** Combine interception (Tier 1) with a custom query API. All captured events go into our own database (SQLite, PostgreSQL, or even a CouchBase Lite instance we control). Build a REST/MCP API that serves the full history. Redirect LTM queries (from Claude Code, Copilot, etc.) to our API instead of Pieces.

**Pros:**
- Complete control over retention, schema, and query capabilities
- Can add features Pieces doesn't have (full-text search over all history, custom embeddings, date range queries)
- The MCP tools that Claude Code uses could point to our API
- Future-proof — independent of Pieces OS changes

**Cons:**
- Significant engineering effort
- Need to maintain our own embedding pipeline if we want vector search over old events
- Doesn't benefit from Pieces' AI features (auto-annotations, summaries, hints) unless we replicate those too
- Two sources of truth — need to merge recent Pieces data with our archive

**Coverage:** 100% of captured events, but dependent on capture completeness (Tier 1)

#### 3B. MCP Server Wrapper

**How:** Build an MCP server that wraps the Pieces MCP tools, adding a local archive layer. When a query comes in:
1. Query our archive for full history
2. Query Pieces for recent data (last 5 days)
3. Merge and deduplicate results
4. Return the combined result

**Pros:**
- Drop-in replacement for the Pieces MCP server in Claude Code config
- Transparent to consumers — they query one MCP endpoint
- Gets the best of both: Pieces' real-time processing + our long-term archive
- Minimal behavior change for existing workflows

**Cons:**
- Need to maintain schema compatibility with Pieces MCP tools
- Merge/dedup logic can be complex
- Still depends on Tier 1 capture for the archive data

**Coverage:** As complete as the underlying archive

---

### Tier 4: Nuclear Options

#### 4A. Binary Patching

**How:** Reverse-engineer the compiled Dart AOT binary to find the pruning routine and NOP it out.

**Verdict:** Fragile, breaks on every update, legally questionable, high effort. Not viable.

#### 4B. Upgrade to Pro

**How:** Pay for Pieces Pro ($20/month).

**Pros:** Officially extends retention to "up to 9 months." Zero engineering effort.

**Cons:** 
- Doesn't guarantee the pruning stops — "up to 9 months" is vague
- Creates ongoing cost dependency
- Doesn't solve the problem if you cancel
- Still subject to whatever Pieces decides the retention window is

**Verdict:** May be part of a combined solution, but doesn't solve the fundamental problem of control.

---

## Recommended Investigation Path

Before committing to any solution, we need to answer these open questions:

### Open Question 1: What exactly triggers pruning?

Is it time-based (cron inside the binary)? Event-count-based (prune oldest when > N)? Triggered by a cloud sync acknowledgment? Understanding the trigger determines whether polling-based solutions have a safe window or not.

**How to investigate:** Monitor the CouchBase Lite database continuously for an hour, logging row counts every 10 seconds. Watch for the exact moment documents disappear.

### Open Question 2: Does Pieces cloud store full documents?

If `joeblack.pieces.cloud` has the full event text (not just embeddings), then the cloud might serve as an inadvertent backup. A Pro upgrade + cloud restore could recover history.

**How to investigate:** Check the cloud allocation API, or test if the Pieces web app at `joeblack.pieces.cloud` shows events older than 5 days.

### Open Question 3: Does the pruning respect database locks?

If we hold a read lock on the SQLite database (e.g., an open `ltm-reader` connection), does Pieces defer pruning? If so, a persistent reader process could delay pruning indefinitely.

**How to investigate:** Open a long-lived read transaction on the CouchBase Lite DB and monitor whether row counts stay stable.

### Open Question 4: Is pruning tied to free tier specifically?

The vector DB retains 9 months regardless. Does Pro simply extend the CouchBase Lite retention window, or does it disable pruning entirely?

**How to investigate:** Would require a Pro trial or finding someone with Pro to compare their CouchBase Lite retention.

### Open Question 5: Can we intercept at the network layer?

If events flow through the Pieces API before being stored, a local reverse proxy (mitmproxy, transparent proxy) could capture the raw event payloads in transit.

**How to investigate:** Check if Pieces OS makes localhost calls to itself, or if the event capture pipeline is entirely in-process.

---

## Evaluation Matrix

| Solution | Coverage | Latency | Complexity | Fragility | Survives Updates |
|----------|----------|---------|------------|-----------|-----------------|
| 1A. Event stream fork | 60-70% | Zero | Low | Low | Yes |
| 1B. API polling | 95% | Minutes | Low | Low | Yes |
| 1C. DB polling (ltm-reader) | 95% | Minutes | Medium | Medium | Mostly |
| 1D. WAL monitoring | 100% | Seconds | High | Very High | No |
| 1E. FSEvents monitor | 95% | Seconds | Medium | Medium | Mostly |
| 2A. CBL replication | 100% | Real-time | High | Low | Yes |
| 2B. Litestream replication | 100% | Real-time | Medium | Medium | Mostly |
| 2C. Periodic snapshots | 90% | Hours | Trivial | Low | Yes |
| 3A. Parallel DB + API | 100% | Zero | High | Low | Yes |
| 3B. MCP wrapper | 100% | Zero | Medium | Low | Yes |
| 4A. Binary patching | 100% | N/A | Very High | Extreme | No |
| 4B. Pro upgrade | Unknown | N/A | Zero | Low | Yes |

---

## Leading Candidates

Based on the tradeoffs, the most promising path appears to be a combination:

1. **Litestream (2B)** for guaranteed capture — continuous SQLite WAL replication means no data loss regardless of pruning timing
2. **API polling (1B)** as a parallel, format-independent archive — human-readable JSON, no Fleece decoding needed
3. **MCP wrapper (3B)** as the query layer — transparent to Claude Code, merges archive + live data

But we should answer the open questions first — particularly #1 (pruning trigger) and #3 (lock behavior), since the answers could simplify or eliminate entire solution categories.
