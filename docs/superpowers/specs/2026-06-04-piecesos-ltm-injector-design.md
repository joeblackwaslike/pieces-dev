# PiecesOS LTM Injector + Gap Reconstructor — Design Spec

## Problem

PiecesOS Long-Term Memory (LTM-2.7) requires a continuous stream of workstream events to build its Timeline and power the `ask_pieces_ltm` MCP tool. The deprecated Pieces VS Code extension was the primary source of these events. It was uninstalled and cannot be reinstalled, leaving PiecesOS with zero IDE context capture. Additionally, a 9-day outage (May 26 – Jun 4 2026) left a complete gap in LTM coverage.

## Deliverables

1. **VS Code extension** (`@pieces-dev/ltm-injector`) — marketplace-published extension that permanently replaces the deprecated one, injecting workstream events on every IDE interaction plus extended events (git, terminal, debug, Claude Code sessions).
2. **Gap reconstructor CLI** (`@pieces-dev/gap-reconstruct`) — reusable CLI tool that backfills any PiecesOS gap period by synthesizing events from Claude Code transcripts, macOS Screen Time, Arc browser history, and git logs.

Both share a common core library (`@pieces-dev/core`) for PiecesOS API communication.

---

## API Surface (Confirmed via Probing)

PiecesOS v12.4.1 running on port 39312 (dynamic, discovered at runtime from range 39300–39315).

| Endpoint | Method | Status | Purpose |
|---|---|---|---|
| `/.well-known/health` | GET | 200 | Health check, returns `ok:<instance-id>` |
| `/user` | GET | 200 | Auth check, returns user object or 401 |
| `/applications` | GET | 200 | List registered client applications |
| `/workstream_events/create` | POST | **200** | Create event. Accepts `SeededWorkstreamEvent` body directly (no wrapper). |
| `/workstream_events/{id}/delete` | POST | **204** | Delete individual event (not DELETE method) |
| `/workstream_events` | GET | 200 | List all workstream events |
| `/workstream_summaries/create/summary` | POST | 412/200 | Trigger summary generation from time ranges (needs events to exist) |
| `/workstream_pattern_engine/ingestions/create` | POST | 500 | WPE ingestion disabled in v12.4.1 |

### Confirmed Payload Shape

Snake_case for trigger fields, camelCase for application fields:

```json
{
  "application": {
    "id": "24e066ee-81aa-4054-ba7a-74697135b086",
    "name": "VS_CODE",
    "version": "3.0.1",
    "platform": "MACOS",
    "onboarded": false,
    "privacy": "OPEN",
    "capabilities": "BLENDED",
    "mechanism": "MANUAL",
    "automaticUnload": false
  },
  "trigger": { "file_open": true },
  "context": {
    "ide": {
      "tabs": {
        "iterable": [{ "anchor": { "fullpath": "/abs/path/to/file.ts" }, "current": true }]
      },
      "modules": {
        "iterable": [{ "anchor": { "fullpath": "/repo/root" } }]
      }
    }
  },
  "readable": "Opened src/index.ts in myproject"
}
```

### Registered Application IDs

| ID | Name | Pre-registered |
|---|---|---|
| `24e066ee-81aa-4054-ba7a-74697135b086` | VS_CODE | Yes |
| `B960C645-A6CC-4654-932C-C38EBA6F54A6` | OS_SERVER | Yes |

Non-IDE apps (Arc, Obsidian, Claude Desktop, etc.) will be registered dynamically via `POST /applications` on first use, falling back to OS_SERVER if registration fails.

---

## Architecture: All-TypeScript Monorepo

### Repository Layout

```
pieces-dev/
├── package.json                    (workspace root)
├── pnpm-workspace.yaml
├── tsconfig.base.json              (shared strict TS config)
├── biome.json
├── .gitignore
├── CLAUDE.md
├── packages/
│   ├── core/                       (@pieces-dev/core)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts            (all PiecesOS API types)
│   │       ├── client.ts           (PiecesClient: port discovery + HTTP)
│   │       ├── event-builder.ts    (factory functions for each event type)
│   │       ├── port-discovery.ts   (probe + lsof fallback)
│   │       └── app-registry.ts     (register/cache application IDs)
│   ├── ltm-injector/               (@pieces-dev/ltm-injector — VS Code ext)
│   │   ├── package.json            (extension manifest + contributes)
│   │   ├── tsconfig.json
│   │   ├── esbuild.mjs
│   │   ├── .vscodeignore
│   │   ├── CHANGELOG.md
│   │   ├── LICENSE
│   │   ├── README.md
│   │   ├── icon.png                (128x128)
│   │   └── src/
│   │       ├── extension.ts        (activate/deactivate)
│   │       ├── event-queue.ts      (ring buffer for offline queueing)
│   │       ├── status-bar.ts       (connection status indicator)
│   │       └── handlers/
│   │           ├── file-handler.ts
│   │           ├── tab-handler.ts
│   │           ├── clipboard-handler.ts
│   │           ├── git-handler.ts
│   │           ├── terminal-handler.ts
│   │           ├── debug-handler.ts
│   │           └── claude-code-handler.ts
│   └── gap-reconstruct/            (@pieces-dev/gap-reconstruct — CLI)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── cli.ts              (Commander entry point)
│           ├── pipeline.ts         (collect → dedup → sort → inject)
│           ├── summarizer.ts       (trigger per-day summary generation)
│           └── sources/
│               ├── types.ts        (Source interface, SourceEvent type)
│               ├── claude-code.ts
│               ├── screen-time.ts
│               ├── arc-history.ts
│               └── git-log.ts
└── tools/
    └── gap_analysis.py             (reference script, not part of build)
```

### Tooling

- **Package manager**: pnpm workspaces
- **TypeScript**: 5.x strict mode, `noUncheckedIndexedAccess: true`
- **Bundling**: esbuild (extension), tsx (CLI scripts)
- **Formatting**: Biome
- **Testing**: Vitest for core + CLI, `@vscode/test-electron` for extension
- **Node**: 22+ LTS (built-in fetch, no external HTTP dependency)

---

## Package: `@pieces-dev/core`

### Types (`types.ts`)

```typescript
type EmbeddedModelSchema = {
  migration: number
  semantic: string
}

type Application = {
  id: string
  name: string
  version: string
  platform: 'MACOS' | 'WINDOWS' | 'LINUX'
  onboarded: boolean
  privacy: 'OPEN' | 'PRIVATE'
  capabilities?: 'BLENDED' | 'LOCAL' | 'CLOUD'
  mechanism?: 'MANUAL' | 'INTERNAL'
  automaticUnload?: boolean
}

type WorkstreamEventTrigger = {
  file_open?: boolean
  file_close?: boolean
  tab_open?: boolean
  tab_close?: boolean
  tab_enter?: boolean
  tab_leave?: boolean
  tab_switch?: boolean
  application_enter?: boolean
  application_leave?: boolean
  application_switch?: boolean
  check_in?: boolean
  copy?: boolean
  paste?: boolean
  url_changed?: boolean
  native_screenshot?: boolean
}

type IDETab = {
  anchor: { fullpath: string }
  current?: boolean
  classification?: { specific: string }
}

type ProjectModule = {
  anchor: { fullpath: string }
}

type WorkstreamEventContextIDE = {
  tabs?: { iterable: IDETab[] }
  modules?: { iterable: ProjectModule[] }
  name?: string
}

type WorkstreamEventContextBrowser = {
  tabs?: { iterable: Array<{ anchor: { fullpath: string }; current?: boolean }> }
}

type WorkstreamEventContext = {
  ide?: WorkstreamEventContextIDE
  browser?: WorkstreamEventContextBrowser
  native_clipboard?: { text: string }
}

type SeededWorkstreamEvent = {
  application: Application
  trigger: WorkstreamEventTrigger
  readable?: string
  context?: WorkstreamEventContext
  schema?: EmbeddedModelSchema
}

type WorkstreamEvent = SeededWorkstreamEvent & {
  id: string
  created: { value: string }
  updated: { value: string }
}
```

### PiecesClient (`client.ts`)

Stateful client managing connection to PiecesOS.

**State**: `connected | disconnected | auth-failed`

**Construction**: `new PiecesClient(options?: { portOverride?: number, heartbeatMs?: number })`

**Methods**:
- `connect(): Promise<void>` — discover port, health check, auth check. Starts heartbeat timer.
- `postEvent(event: SeededWorkstreamEvent): Promise<string | null>` — POST to `/workstream_events/create`, returns event ID on success, null on failure. 3s `AbortSignal.timeout`.
- `deleteEvent(id: string): Promise<boolean>` — POST to `/workstream_events/{id}/delete`.
- `getEvents(from?: Date, to?: Date): Promise<WorkstreamEvent[]>` — GET `/workstream_events`, client-side filter by timestamp range.
- `triggerSummary(from: Date, to: Date): Promise<boolean>` — POST `/workstream_summaries/create/summary` with `anonymous_ranges`.
- `registerApplication(registration: Partial<Application>): Promise<Application>` — POST `/applications`, caches result.
- `dispose(): void` — clear heartbeat, clean up.

**Events** (EventEmitter pattern):
- `connectionChange(state: 'connected' | 'disconnected' | 'auth-failed')` — fired on state transitions.

All HTTP uses Node 22+ built-in `fetch`. No external HTTP library.

### Port Discovery (`port-discovery.ts`)

1. If `portOverride` is set, use it directly.
2. Try cached port → `GET /.well-known/health` → return if 200.
3. Probe ports 39300–39315 sequentially, 500ms timeout each. First 200 wins, cache it.
4. lsof fallback: find PiecesOS PID via `pgrep -f "Pieces OS"`, parse `lsof -p <pid> -i -a` for listening port.
5. Return `null` if all fail.

### EventBuilder (`event-builder.ts`)

Factory functions returning typed `SeededWorkstreamEvent`:

- `fileOpenEvent(app, filePath, language?, repoRoot?)`
- `fileCloseEvent(app, filePath, language?, repoRoot?)`
- `tabSwitchEvent(app, filePath, language?, repoRoot?)`
- `checkInEvent(app, readable?)`
- `appEnterEvent(app, readable?)`
- `appLeaveEvent(app, readable?)`
- `urlChangedEvent(app, url, title?)`
- `copyEvent(app, text)`

Each populates the correct `trigger` field and builds the appropriate `context` (IDE for file events, browser for URL events, clipboard for copy events).

### App Registry (`app-registry.ts`)

Maps macOS bundle IDs to PiecesOS Application objects.

Pre-registered apps (use known IDs):
- `com.microsoft.VSCodeInsiders` → VS_CODE (`24e066ee-...`)
- OS_SERVER (`B960C645-...`)

Dynamic registration for:
- `company.thebrowser.Browser` → ARC_BROWSER
- `md.obsidian` → OBSIDIAN
- `com.anthropic.claudefordesktop` → CLAUDE_DESKTOP
- `com.hnc.Discord` → DISCORD
- `com.google.Chrome` → CHROME
- `dev.warp.Warp-Stable` → WARP_TERMINAL
- `com.openai.codex` → CHATGPT
- `com.apple.mail` → APPLE_MAIL

On first use, calls `POST /applications` to register. Caches the returned ID. Falls back to OS_SERVER with the app name in `readable` if registration fails.

---

## Package: `@pieces-dev/gap-reconstruct`

### CLI Interface

Entry: `npx @pieces-dev/gap-reconstruct` or `pnpm --filter gap-reconstruct start`

```
gap-reconstruct \
  --from "2026-05-26T02:43:00Z" \
  --to "2026-06-04T08:52:00Z" \
  --sources claude,screentime,arc,git \
  --dry-run \
  --limit 100 \
  --concurrency 5 \
  --skip-summaries \
  --repos ~/github/joeblackwaslike/project1,~/github/joeblackwaslike/project2
```

| Flag | Default | Purpose |
|---|---|---|
| `--from` | required | Gap start (ISO8601) |
| `--to` | required | Gap end (ISO8601) |
| `--sources` | `claude,screentime,arc,git` | Comma-separated source list |
| `--dry-run` | false | Collect and display without injecting |
| `--limit N` | unlimited | Inject only first N events |
| `--concurrency N` | 5 | Parallel injection requests |
| `--skip-summaries` | false | Don't trigger summary generation after injection |
| `--repos` | auto-discovered | Override repo list for git source |

### Source Interface

```typescript
type SourceEvent = {
  timestamp: Date
  event: SeededWorkstreamEvent
  source: 'claude' | 'screentime' | 'arc' | 'git'
  dedupKey: string
}

type Source = {
  name: string
  collect(from: Date, to: Date): AsyncIterable<SourceEvent>
}
```

`dedupKey` format: `{trigger}:{path_or_url}:{timestamp_rounded_to_5s}`. Cross-source priority when keys collide: `claude > screentime > git > arc`.

### Source: Claude Code (`sources/claude-code.ts`)

Parses `~/.claude/projects/**/*.jsonl`.

- Scans for `.jsonl` files modified within or after the gap window
- Skips paths containing `subagent`
- For each file, reads line-by-line, parses JSON
- Filters events by timestamp within `--from`/`--to`
- From `assistant` messages with `tool_use` blocks:
  - Read/Edit/Write: extract `file_path` or `path` → `fileOpenEvent`
  - Bash: extract working directory or command → `checkInEvent`
- Session boundaries (first user message → `appEnterEvent`, last → `appLeaveEvent`)
- Readable: "Editing {filename} in {repo}" or "Claude Code session in {repo}"

### Source: Screen Time (`sources/screen-time.ts`)

Queries `~/Library/Application Support/Knowledge/knowledgeC.db` via `better-sqlite3`.

- CoreData epoch: `timestamp + 978307200` → Unix seconds
- SQL: `SELECT ZSTARTDATE, ZENDDATE, ZVALUESTRING FROM ZOBJECT WHERE ZSTREAMNAME = '/app/usage' AND ZSTARTDATE >= ? AND ZSTARTDATE <= ?`
- For ALL apps in results (not just VS Code):
  - Resolve bundle ID through app registry → Application object
  - `appEnterEvent` at session start
  - `appLeaveEvent` at session end
  - For VS Code sessions only: `checkInEvent` every 60s within the window
- Readable: "{app_name} active" / "{app_name} backgrounded"

### Source: Arc History (`sources/arc-history.ts`)

Queries `~/Library/Application Support/Arc/User Data/Default/History` via `better-sqlite3`.

- Chrome timestamp: `microseconds / 1_000_000 - 11_644_473_600` → Unix seconds
- SQL: `SELECT url, title, last_visit_time FROM urls WHERE last_visit_time > ? ORDER BY last_visit_time`
- Cross-references with Screen Time Arc sessions — only emits URL events during active Arc focus windows
- Each URL visit → `urlChangedEvent` with browser context
- Readable: "Browsing: {title}" or "Visited: {domain}"

### Source: Git Log (`sources/git-log.ts`)

Shells out to `git log` for each discovered repo.

- Repo list: auto-discovered from Claude Code source (repos that had sessions), or `--repos` override
- Command: `git -C <repo> log --after=<from> --before=<to> --format="%H|%aI|%s" --name-only`
- Each commit → `checkInEvent` with readable "Committed: {subject} in {repo}"
- Each file in the commit → `tabSwitchEvent` with IDE context (file path, language, repo root)

### Pipeline (`pipeline.ts`)

```
1. Collect    → run all enabled sources concurrently via AsyncIterable
2. Merge      → interleave into single time-ordered stream
3. Dedup      → 5s sliding window on dedupKey, higher-priority source wins
4. Idempotency → query GET /workstream_events for the time window; warn and skip if events exist
5. Inject     → POST events with bounded concurrency, console progress
6. Summarize  → POST /workstream_summaries/create/summary per calendar day
```

### Dry-Run Output

```
Gap window: 2026-05-26T02:43:00Z → 2026-06-04T08:52:00Z (9d 6h 9m)

Sources:
  claude:     4,218 events (28 repos, 398 sessions)
  screentime: 2,771 events (9 apps, 773 VS Code sessions)
  arc:          412 events (URLs during active browsing)
  git:          891 events (commits + files across 28 repos)

After dedup:  6,847 events

Top apps by event count:
  VS Code Insiders    3,902
  Arc Browser           412
  Claude Desktop        298
  Obsidian              187
  ...

Daily distribution:
  May 26:   482 events
  May 27:   891 events
  ...
```

---

## Package: `@pieces-dev/ltm-injector` (VS Code Extension)

### Activation

Event: `onStartupFinished`. Extension creates a PiecesClient (from `@pieces-dev/core`), an EventQueue, registers all handlers, and pushes disposables into `context.subscriptions`.

### EventQueue (`event-queue.ts`)

Ring buffer (default 500, configurable) that absorbs events when PiecesOS is unreachable.

- `enqueue(event: SeededWorkstreamEvent)`: add to buffer, drop oldest if full
- `drain(callback: (event) => Promise<void>)`: flush all queued events FIFO
- Auto-drain triggered on client `connectionChange` → `connected`

Hot path (PiecesOS connected): handler calls `client.postEvent()` directly, bypassing queue.
Cold path (disconnected): handler calls `queue.enqueue()`.

### Handlers

#### `file-handler.ts` — Core
- `onDidOpenTextDocument` → `fileOpenEvent` (skip untitled, output, git-scheme docs)
- `onDidCloseTextDocument` → `fileCloseEvent`
- Debounce: skip duplicate opens of the same file within 2s

#### `tab-handler.ts` — Core
- `onDidChangeActiveTextEditor` → `tabSwitchEvent` with new file's path and language
- `onDidChangeWindowState` → `appEnterEvent` (focused: true) / `appLeaveEvent` (focused: false)
- Check-in timer: `setInterval(60s)` while focused, cleared on `application_leave`, restarted on `application_enter`

#### `clipboard-handler.ts` — Core
- Override `editor.action.clipboardCopyAction` command
- Execute original copy, read `vscode.env.clipboard`, emit `copyEvent`
- Truncate clipboard text to 500 chars in payload

#### `git-handler.ts` — Extended
- Acquire `vscode.git` extension API
- Watch `repository.state.onDidChange`:
  - HEAD commit changed → `checkInEvent` with "Committed: {message}"
  - HEAD name changed → `tabSwitchEvent` with "Switched to branch {name}"
- Graceful skip if git extension unavailable

#### `terminal-handler.ts` — Extended
- `onDidWriteTerminalData` → buffer, detect command boundaries
- `checkInEvent` with "Terminal: {first 100 chars}"
- Throttle: max 1 event per 10s per terminal instance

#### `debug-handler.ts` — Extended
- `onDidStartDebugSession` → `appEnterEvent` with "Debug: {name} ({type})"
- `onDidTerminateDebugSession` → `appLeaveEvent` with "Debug ended: {name}"

#### `claude-code-handler.ts` — Extended
- `fs.watch` (recursive) on `~/.claude/projects/` for new `.jsonl` files
- Tail new files: read appended lines, parse JSON
- Extract from assistant `tool_use` blocks:
  - Read/Edit/Write file paths → `fileOpenEvent` (only for files NOT currently open in VS Code, to avoid duplication)
  - Bash commands → `checkInEvent` with working directory
- Session detection (first user message) → `checkInEvent` with "Claude Code: {project}"
- Configurable: `pieces-ltm-injector.enableClaudeCodeIntegration` (default: true)

### Status Bar

Status bar item (left-aligned, low priority):
- Connected: `$(plug) Pieces` — green
- Disconnected: `$(warning) Pieces (42 queued)` — yellow, shows queue depth
- Auth failed: `$(error) Pieces` — red
- Click action: open "Pieces LTM Injector" output channel

### Output Channel

"Pieces LTM Injector" — always logs connection state changes and errors. When `debugLogging` is enabled, also logs every event (timestamp, trigger, readable).

### Extension Settings

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `enabled` | boolean | true | Master on/off |
| `portOverride` | number | null | Skip port discovery, use this port |
| `heartbeatInterval` | number | 30000 | Port re-probe interval (ms) |
| `checkInInterval` | number | 60000 | Check-in heartbeat interval (ms) |
| `queueSize` | number | 500 | Max queued events when disconnected |
| `debugLogging` | boolean | false | Verbose event logging to output channel |
| `enableClaudeCodeIntegration` | boolean | true | Watch Claude Code sessions |
| `enableGitEvents` | boolean | true | Git branch/commit detection |
| `enableTerminalEvents` | boolean | true | Terminal command events |

### Marketplace Metadata

- Publisher: TBD (Joe's VS Code marketplace publisher ID)
- Display name: "Pieces LTM Injector"
- Description: "Injects IDE workstream events into PiecesOS Long-Term Memory"
- Categories: `["Other"]`
- Icon: 128x128 PNG
- README: features, prerequisites (PiecesOS running), config reference, screenshots
- CHANGELOG: keep-a-changelog format
- LICENSE: MIT
- `.vscodeignore`: exclude test/, src/ (bundled), node_modules/

---

## Error Handling

### Extension
- All event POSTs are fire-and-forget with 3s timeout — never block the VS Code UI thread
- Connection failures → queue events, retry on next heartbeat
- Auth failures → stop posting, show red status bar, resume when auth restored
- Handler registration failures → log and skip that handler, don't crash the extension
- git extension unavailable → skip git handler silently

### Gap Reconstructor
- Source parse errors → log warning, skip that event, continue
- Injection failures → retry once after 1s, then skip and log
- SQLite DB locked → retry with 500ms delay up to 3 times
- Missing source DB (e.g., Arc not installed) → warn and skip that source
- Idempotency check failure → warn and ask for `--force` flag

---

## Testing Strategy

### `@pieces-dev/core`
- Vitest unit tests for event builder factories (correct payload shapes)
- Vitest unit tests for port discovery logic (mock fetch responses)
- Integration test: POST a real event to PiecesOS, verify via GET, delete it

### `@pieces-dev/gap-reconstruct`
- Vitest unit tests per source parser (fixture JSONL files, SQLite test DBs)
- Pipeline unit tests (dedup, sort, merge logic)
- Integration test: dry-run with real data sources, verify event counts

### `@pieces-dev/ltm-injector`
- Vitest unit tests for EventQueue (ring buffer behavior, drain ordering)
- `@vscode/test-electron` integration: activate extension in Extension Dev Host, open a file, verify event posted
- Manual verification: install .vsix, interact with VS Code, check events via `curl /workstream_events`

---

## Verification Checklist

### Gap Reconstructor
1. `--dry-run` produces expected event counts and distribution
2. Single-day injection creates events visible in `GET /workstream_events`
3. Summary generation for injected day produces summary in `GET /workstream_summaries`
4. Pieces Desktop Timeline shows backfilled day
5. Re-running same window skips (idempotency)
6. Full gap injection + summary generation completes without errors

### VS Code Extension
1. `pnpm build` compiles with zero errors
2. Extension Host: open file → event appears in PiecesOS
3. Extension Host: switch tabs → tab_switch event
4. Extension Host: focus/unfocus window → application_enter/leave
5. Output channel shows connection status and event log
6. Kill PiecesOS → events queue → restart → queue drains
7. `vsce package` produces valid .vsix
8. Marketplace metadata renders correctly (README, icon, settings)

### End-to-End
- `ask_pieces_ltm` returns relevant context for queries about the gap period
- Pieces Desktop Timeline shows continuous coverage from pre-gap through present
- Extension + gap reconstructor events coexist without conflicts
