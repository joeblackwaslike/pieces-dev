# PM-005: Pieces Stop Hook Session Pollution — Fix Spec

## Problem

A Stop hook (`pieces-dev/hooks/pieces-memory-stop.sh`) has been spawning a headless `claude -p`
subprocess after every Claude Code session since 2026-06-17. Each `claude -p` creates a full
session — transcript, metadata, hook triggers — producing ~18,234 ghost sessions over 59 days.
cc-recall's SessionEnd hook then spawned another `claude -p` for each ghost (2x cascade), and
9 SessionStart hooks fired on each ghost, totaling ~36,468 ghost sessions and ~547,000 hook
invocations.

Ghost sessions polluted every session-indexing system: cc-recall (8,000–35,000 ghost entries,
up to 62% of 56,943 total), claude-mem (298 sdk_sessions, 148 observations, 112 summaries,
69 chroma embeddings), and session transcripts (~779 confirmed ghost JSONLs at ~600 MB across
185 project directories). Discovered when an agent asked to "refer to last session" surfaced
a ghost extractor's system prompt instead of real work.

Post-mortem: `postmortems/postmortems/005-pieces-stop-hook-session-pollution.md` (already written).

---

## Root Cause

The hook used bare `claude -p` to spawn an LLM session for transcript extraction. A bare
`claude -p` inherits the full session lifecycle: settings.json hooks (9 SessionStart + 3 Stop +
3 SessionEnd), plugin loading (claude-mem, cc-recall, lessons-learned, etc.), CLAUDE.md
discovery, and transcript persistence. None of these are needed for background extraction work,
and all produce pollution artifacts.

---

## Design Decision: `--setting-sources ""` Isolation Pattern

**Decided during session**: the hook should not be deleted — its intent (extracting significant
decisions into Pieces LTM) is valid. The mechanism is the problem.

**Rejected approaches**:
- `--bare` flag: requires `ANTHROPIC_API_KEY` auth, which changes the billing/auth mechanism.
  Not acceptable — existing Max subscription auth must be preserved.
- Direct `curl` to Anthropic Messages API + Pieces REST API: bypasses Claude Code entirely but
  requires API key and Pieces REST endpoint discovery for `create_pieces_memory`.
- `--no-session-persistence` alone: prevents transcript persistence but hooks still fire (~15
  wasted invocations per run).
- `CLAUDE_CONFIG_DIR` → minimal config directory: suppresses hooks/plugins by pointing at a
  directory with empty `settings.json`. Breaks Keychain auth — credentials are stored in macOS
  Keychain keyed by config directory path hash, so redirecting the config dir produces
  "Not logged in." Requires a separate `claude auth login` per config dir, which is fragile.
- `--settings '{"hooks": {}, "enabledPlugins": {}}'`: intended to override hooks/plugins via
  merge. Unreliable — `--settings` loads "additional" settings and merge behavior is
  undocumented; hooks may or may not be fully suppressed depending on merge strategy.

**Chosen approach**: `--setting-sources ""` — skip loading ALL settings files (user, project,
local). Combined with CLI isolation flags, this suppresses hooks, plugins, MCP servers, and
CLAUDE.md while preserving Keychain-based Max subscription auth (config dir unchanged).

| Layer | Mechanism | Effect |
| --- | --- | --- |
| Settings isolation | `--setting-sources ""` | No settings files loaded — zero hooks, zero plugins, zero MCP from config |
| Transcript isolation | `--no-session-persistence` | No JSONL transcript, no session directory on disk |
| MCP isolation | `--strict-mcp-config` + `--mcp-config` | Only Pieces MCP server loaded, ignores all others |
| Prompt isolation | `--system-prompt` | Replaces CLAUDE.md auto-discovery with hook-specific prompt only |
| Cost isolation | `--model claude-haiku-4-5-20251001` | Cheap model for background extraction, not interactive Opus |
| Auth | Existing Max subscription | Config dir unchanged → Keychain lookup succeeds → OAuth/Max billing preserved |

No minimal config directory needed — `--setting-sources ""` makes the settings.json hooks
entry irrelevant.

### Hook invocation pattern

```bash
PIECES_MCP_URL="http://localhost:$PORT/model_context_protocol/2025-03-26/mcp"

/opt/homebrew/bin/claude -p \
  --no-session-persistence \
  --setting-sources "" \
  --model claude-haiku-4-5-20251001 \
  --system-prompt "$PROMPT" \
  --strict-mcp-config \
  --mcp-config '{"pieces":{"type":"http","url":"'"$PIECES_MCP_URL"'"}}' \
  --allowedTools "mcp__pieces__create_pieces_memory" \
  "Extract significant items from the session transcript and save them to Pieces."
```

This pattern is reusable — any hook needing background LLM work should use it. cc-recall should
adopt it too (currently uses bare `claude -p` with manual workarounds: dedicated CWD + prompt
signature self-recognition + spawn-rate ceiling).

### Verified behavior (PM-005 implementation session)

Tested 2026-08-15 with `--setting-sources "" --no-session-persistence --strict-mcp-config
--system-prompt --model claude-haiku-4-5-20251001`:
- **Auth**: `claude auth status` confirms `claude.ai (max)` — Max subscription preserved
- **Hooks**: `settings.json` mtime unchanged after invocation — zero hook invocations
- **Sessions**: 0 new JSONL files created in `~/.claude/projects/`
- **Prompt**: system prompt applied correctly (test string echoed back verbatim)
- **Response**: model responded, confirming API call succeeded

---

## Deliverables

### D1. Rewrite `pieces-dev/hooks/pieces-memory-stop.sh`

Replace the bare `claude -p` invocation with the `--setting-sources ""` isolation pattern above.

Add gating logic:
- **Cooldown**: Skip if fewer than N minutes since last successful run (timestamp file at
  `~/.claude/logs/pieces-memory-last-run`)
- **Session duration check**: Skip sessions shorter than ~2 minutes of wall-clock time (use
  transcript timestamp span, not just line count)
- Keep existing guards: Pieces OS health check, 6-line minimum transcript check

### D2. Fix `pieces-dev/hooks/pieces-mcp-register.sh` gating

- Only rewrite `settings.json` if the port has actually changed since the last write
- Add a per-N-minutes cooldown (don't re-run if last successful run was < 5 min ago)

### D3. ~~Create `~/.claude/hook-config/settings.json`~~ (superseded)

No longer needed. `--setting-sources ""` skips loading all settings files, making a separate
config directory unnecessary. Auth stays on the default `~/.claude/` config dir (Keychain lookup
succeeds). `CLAUDE_CONFIG_DIR` was rejected because it breaks Keychain auth — see rejected
approaches above.

### D4. Update `~/.claude/claude-extras.md`

Rewrite the "Pieces long-term memory" section to reflect the new mechanism — not deletion,
but update to describe the isolation pattern, gating logic, and cheap model.

### D5. Clean up ghost log files

Delete `~/.claude/logs/pieces-memory-*.log` (18,234 files, 856 KB). Pure artifacts.

### D6. Clean up ghost sessions — comprehensive classification and deletion

Build a classification script that scans session transcripts across all project directories and
identifies ghosts by first-message content patterns:

1. **Pieces-memory**: Contains "background memory extractor"
2. **cc-recall indexer**: Starts with `INDEXER_PROMPT_SIGNATURE` ("You are indexing a Claude Code
   session transcript so it can be found later by what\nwas DONE, ASKED, and QUESTIONED.")
3. **"Human: \<system-reminder\>"** title pattern: validate against actual transcript content
   first — check a statistically representative random sample (100+, not first 10) before
   adding to the deletion set
4. **Other patterns discovered**: If classification reveals additional ghost sources (ClaudeBar
   probes, claude-mem observers, etc.), document each separately for independent investigation —
   do NOT bulk-delete an unidentified pattern

Script outputs a manifest of ghost session IDs, source pattern, and project directory.
Use this manifest to drive cleanup across all surfaces:

- **cc-recall** (`~/.claude/cc-recall/index.db`): Delete matching entries, VACUUM. Back up first.
- **claude-mem** (`~/.claude-mem/claude-mem.db`): Delete ghost sdk_sessions (by `user_prompt
  LIKE '%background memory extractor%'`), then cascade to observations, session_summaries, and
  chroma embeddings by FK/content. Back up first.
- **Session transcripts** (`~/.claude/projects/*/`): Delete ghost JSONL files and UUID
  directories identified by the manifest.
- **"Untitled session" surge** (23,517 post-2026-06-17 vs 466 before): Full classification
  against transcripts, not sampling. Tag each with its source pattern or "real." If a different
  pollution source emerges, investigate separately.

### D7. Pieces annotations — leave in place

The 60 DESCRIPTION-type and 36 SUMMARY-type AUTOMATIC annotations in Pieces are correctly
stored within Pieces' LTM data model:

- Pieces organizes LTM through **workstream summaries** — periodic summaries of activity events
- Each summary has annotations linked via `summaries_annotation_description` junction table
- `create_pieces_memory` creates DESCRIPTION annotations attached to workstream summaries
- Content is valid — real work summaries from real transcripts
- Correctly typed (AUTOMATIC/DESCRIPTION), correctly linked, not orphaned

No migration or deletion needed. The problem was the delivery mechanism, not the data.

### D8. File cc-recall CWD `/` cleanup as GitHub issue

The `-` project directory (`~/.claude/projects/-/`) has 31,156 JSONL files and 31,943 session
directories at 4.0 GB from cc-recall v0.1.0 indexer (used CWD `/`; v0.2.1+ uses dedicated
CWD). File a GitHub issue against cc-recall to:
1. Clean up the 31K ghost sessions
2. Remove matching entries from cc-recall's index
3. Adopt the `CLAUDE_CONFIG_DIR` isolation pattern for `runClaudeHeadless`

### D9. Emit lessons

**AGENTS.md** (Shell / Scripts section): Add a rule about `CLAUDE_CONFIG_DIR` isolation for
hooks that spawn `claude -p`.

**lessons-learned database**: Formal lesson entry with tool/trigger/problem/solution/tags.

**agent-skills**: Reference document for the "side-effect-free LLM call from hooks" design
pattern — `--setting-sources ""`, flags, motivating incident, adoption guidance.

### D10. Commit and push

- pieces-dev: hook rewrite, `pieces-mcp-register.sh` gating
- postmortems: PM-005 (already written)
- agent-harness: AGENTS.md lesson
- lessons-learned: formal lesson entry
- agent-skills: reference doc
- cc-recall: GitHub issue filed

---

## Verification

1. `pieces-memory-stop.sh` uses `--setting-sources ""` + `--no-session-persistence --strict-mcp-config --system-prompt`
2. `pieces-mcp-register.sh` has port-change + cooldown gating
3. `claude-extras.md` reflects the new mechanism
4. `~/.claude/logs/pieces-memory-*.log` deleted
5. `sqlite3 ~/.claude/cc-recall/index.db "SELECT COUNT(*) FROM sessions"` — significant
   reduction from 56,943
6. `sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM sdk_sessions WHERE user_prompt
   LIKE '%background memory extractor%'"` — returns 0
7. End a session → no new ghost sessions appear
8. End a session with Pieces OS running → hook creates a Pieces memory via the isolated pattern

---

## Non-goals

- Deleting the hook entirely (intent is valid, mechanism was wrong)
- Switching auth mechanisms (no `--bare`, no `ANTHROPIC_API_KEY`)
- Migrating Pieces annotations (they're correctly stored)
- Cleaning cc-recall CWD `/` sessions in this PR (filed as separate GitHub issue)
