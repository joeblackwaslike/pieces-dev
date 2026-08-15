# PM-005: Pieces Stop Hook Session Pollution Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Pieces memory stop hook that spawned ~36,468 ghost sessions by isolating the `claude -p` subprocess via `CLAUDE_CONFIG_DIR`, then clean up all pollution artifacts across cc-recall, claude-mem, and session transcripts.

**Architecture:** The fix replaces the bare `claude -p` invocation in `pieces-memory-stop.sh` with a fully isolated subprocess: `CLAUDE_CONFIG_DIR` points at a minimal config dir (no hooks, no plugins), combined with `--no-session-persistence`, `--strict-mcp-config`, `--system-prompt`, and `--model claude-haiku-4-5-20251001`. Auth stays on existing Max subscription — no API key changes. Gating logic prevents unnecessary runs.

**Tech Stack:** Bash, jq, sqlite3, `claude` CLI flags, GitHub CLI (`gh`)

**Spec:** `docs/superpowers/specs/2026-08-15-pieces-stop-hook-session-pollution-fix.md`

**Repos touched:**
- `pieces-dev` — hook rewrites (primary)
- `~/.claude/` — hook-config dir, claude-extras.md
- `agent-harness` (`~/.claude/AGENTS.md` symlink) — Shell/Scripts lesson
- `agent-skills` — reference doc
- `cc-recall` — GitHub issue only

---

## File Structure

### pieces-dev (this repo)

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `hooks/pieces-memory-stop.sh` | Rewrite with CLAUDE_CONFIG_DIR isolation + gating |
| Modify | `hooks/pieces-mcp-register.sh` | Add port-change + cooldown gating |

### ~/.claude/ (user config — not committed to pieces-dev)

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `hook-config/settings.json` | Minimal config: empty hooks, no plugins |
| Modify | `claude-extras.md` | Update "Pieces long-term memory" section |

### agent-harness (symlinked as ~/.claude/AGENTS.md)

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `AGENTS.md` (line ~227, Shell / Scripts section) | Add CLAUDE_CONFIG_DIR isolation rule |

### agent-skills

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `skills/working-with-claude-code/references/claude-config-dir-isolation.md` | Reference doc for side-effect-free hook pattern |

### Cleanup (scratchpad — not committed)

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | scratchpad `classify-ghost-sessions.sh` | Classification script for ghost session identification |

---

## Task 1: Create Minimal Hook Config Directory

**Files:**
- Create: `~/.claude/hook-config/settings.json`

- [ ] **Step 1: Create the directory and settings file**

```bash
mkdir -p ~/.claude/hook-config
```

Write `~/.claude/hook-config/settings.json`:

```json
{
  "hooks": {},
  "enabledPlugins": {}
}
```

- [ ] **Step 2: Verify the config is valid JSON**

Run: `jq . ~/.claude/hook-config/settings.json`

Expected: Pretty-printed JSON with empty hooks and enabledPlugins objects.

---

## Task 2: Rewrite `pieces-memory-stop.sh` with CLAUDE_CONFIG_DIR Isolation

**Files:**
- Modify: `hooks/pieces-memory-stop.sh`

- [ ] **Step 1: Read the current hook**

Read `hooks/pieces-memory-stop.sh` to confirm it matches the known state (bare `claude -p` on line 36-38, no isolation flags).

- [ ] **Step 2: Write the rewritten hook**

Replace the entire contents of `hooks/pieces-memory-stop.sh` with:

```bash
#!/bin/bash
# pieces-memory-stop.sh
# Stop hook (async): extracts significant decisions/discoveries from the session
# transcript and pins them to Pieces as indefinite memories via create_pieces_memory.
#
# Uses CLAUDE_CONFIG_DIR isolation pattern (PM-005) — the subprocess loads a
# minimal config with no hooks/plugins, preventing session pollution.

set -uo pipefail

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

[[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 0

# --- Guard: Pieces OS health check ---
PORT_FILE="$HOME/Library/com.pieces.os/production/Config/.port.txt"
[[ -f "$PORT_FILE" ]] || exit 0
PORT=$(tr -d '[:space:]' < "$PORT_FILE")
[[ -n "$PORT" ]] || exit 0
curl -sf --max-time 2 "http://localhost:$PORT/.well-known/health" > /dev/null 2>&1 || exit 0

# --- Guard: minimum transcript length ---
MSG_COUNT=$(wc -l < "$TRANSCRIPT" 2>/dev/null || echo 0)
[[ "$MSG_COUNT" -lt 6 ]] && exit 0

# --- Guard: cooldown (skip if last run < 3 min ago) ---
COOLDOWN_FILE="$HOME/.claude/logs/pieces-memory-last-run"
if [[ -f "$COOLDOWN_FILE" ]]; then
  LAST_RUN=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  ELAPSED=$(( NOW - LAST_RUN ))
  [[ "$ELAPSED" -lt 180 ]] && exit 0
fi

# --- Guard: session duration >= 2 minutes ---
FIRST_TS=$(head -1 "$TRANSCRIPT" | jq -r '.timestamp // empty' 2>/dev/null)
LAST_TS=$(tail -1 "$TRANSCRIPT" | jq -r '.timestamp // empty' 2>/dev/null)
if [[ -n "$FIRST_TS" && -n "$LAST_TS" ]]; then
  FIRST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${FIRST_TS%%.*}" +%s 2>/dev/null || echo 0)
  LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_TS%%.*}" +%s 2>/dev/null || echo 0)
  DURATION=$(( LAST_EPOCH - FIRST_EPOCH ))
  [[ "$DURATION" -lt 120 ]] && exit 0
fi

# --- Isolated claude -p invocation ---
HOOK_CONFIG="$HOME/.claude/hook-config"
PIECES_MCP_URL="http://localhost:$PORT/model_context_protocol/2025-03-26/mcp"

PROMPT="You are a background memory extractor running after a Claude Code session. Read the session transcript at: $TRANSCRIPT (it is a JSONL file — each line is one turn). Extract 0-4 items worth pinning permanently in Pieces. Focus only on: architectural decisions made, debugging breakthroughs (root cause + fix), surprising discoveries, or clearly completed milestones. For each item, call the create_pieces_memory tool with: summary (2-4 sentences of markdown covering what happened and why it matters), summary_description (one-line label, <80 chars), project=$CWD. Do NOT call it if the session had no significant decisions or if you cannot reach the Pieces MCP server. Output nothing else."

CLAUDE_CONFIG_DIR="$HOOK_CONFIG" \
  /opt/homebrew/bin/claude -p \
  --no-session-persistence \
  --model claude-haiku-4-5-20251001 \
  --system-prompt "$PROMPT" \
  --strict-mcp-config \
  --mcp-config "{\"pieces\":{\"type\":\"http\",\"url\":\"$PIECES_MCP_URL\"}}" \
  --allowedTools "mcp__pieces__create_pieces_memory" \
  "Extract significant items from the session transcript and save them to Pieces." \
  > /dev/null 2>&1

# Update cooldown timestamp on success
mkdir -p "$(dirname "$COOLDOWN_FILE")"
date +%s > "$COOLDOWN_FILE"

exit 0
```

- [ ] **Step 3: Verify the script is syntactically valid**

Run: `bash -n hooks/pieces-memory-stop.sh`

Expected: No output (clean parse).

- [ ] **Step 4: Verify the script is executable**

Run: `ls -la hooks/pieces-memory-stop.sh`

Expected: `-rwxr-xr-x` permissions. If not, run `chmod +x hooks/pieces-memory-stop.sh`.

---

## Task 3: Add Gating to `pieces-mcp-register.sh`

**Files:**
- Modify: `hooks/pieces-mcp-register.sh`

- [ ] **Step 1: Read the current script**

Read `hooks/pieces-mcp-register.sh` to confirm it unconditionally rewrites `settings.json` on every SessionStart.

- [ ] **Step 2: Write the gated version**

Replace the entire contents of `hooks/pieces-mcp-register.sh` with:

```bash
#!/bin/bash
# pieces-mcp-register.sh
# SessionStart hook: updates the Pieces MCP server URL in settings.json
# using the dynamic port Pieces OS picks at startup (39300-39333 range).
#
# Gating (PM-005): only writes if the port has actually changed since last
# write, and skips if last successful run was < 5 minutes ago.

set -euo pipefail

PORT_FILE="$HOME/Library/com.pieces.os/production/Config/.port.txt"
SETTINGS="$HOME/.claude/settings.json"
COOLDOWN_FILE="$HOME/.claude/logs/pieces-mcp-register-last-run"

# Nothing to do if Pieces isn't installed or hasn't started
[[ -f "$PORT_FILE" ]] || exit 0
PORT=$(tr -d '[:space:]' < "$PORT_FILE")
[[ -n "$PORT" ]] || exit 0

URL="http://localhost:$PORT/model_context_protocol/2025-03-26/mcp"

# --- Guard: cooldown (skip if last run < 5 min ago) ---
if [[ -f "$COOLDOWN_FILE" ]]; then
  LAST_RUN=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  ELAPSED=$(( NOW - LAST_RUN ))
  [[ "$ELAPSED" -lt 300 ]] && exit 0
fi

# --- Guard: port unchanged ---
if [[ -f "$SETTINGS" ]]; then
  CURRENT_URL=$(jq -r '.mcpServers.pieces.url // ""' "$SETTINGS" 2>/dev/null)
  [[ "$CURRENT_URL" == "$URL" ]] && exit 0
fi

# Initialize settings.json if it does not exist yet, so jq has valid input.
mkdir -p "$(dirname "$SETTINGS")"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

# Update (or add) the pieces MCP server entry in settings.json
TMP=$(mktemp)
jq --arg url "$URL" '.mcpServers.pieces = {"type": "http", "url": $url}' "$SETTINGS" > "$TMP" \
  && mv "$TMP" "$SETTINGS" \
  || rm -f "$TMP"

# Update cooldown timestamp
mkdir -p "$(dirname "$COOLDOWN_FILE")"
date +%s > "$COOLDOWN_FILE"

exit 0
```

- [ ] **Step 3: Verify syntax**

Run: `bash -n hooks/pieces-mcp-register.sh`

Expected: No output (clean parse).

---

## Task 4: Behavioral Verification — No Ghost Sessions

This task verifies the fix works end-to-end. It does NOT use TDD (no test framework for async bash hooks) — it's a manual behavioral check.

- [ ] **Step 1: Count current sessions as baseline**

Run:
```bash
BEFORE=$(find ~/.claude/projects -name "*.jsonl" -newer hooks/pieces-memory-stop.sh 2>/dev/null | wc -l)
echo "Sessions before test: $BEFORE"
```

- [ ] **Step 2: Verify hook-config prevents hook cascade**

Run (dry test — simulates what the hook does without actually calling claude):
```bash
# Verify CLAUDE_CONFIG_DIR loads the minimal config, not ~/.claude/settings.json
CLAUDE_CONFIG_DIR="$HOME/.claude/hook-config" \
  /opt/homebrew/bin/claude -p \
  --no-session-persistence \
  --model claude-haiku-4-5-20251001 \
  --system-prompt "Reply with exactly: ISOLATION_TEST_OK" \
  --strict-mcp-config \
  --mcp-config '{}' \
  "test" 2>/dev/null
```

Expected: Outputs `ISOLATION_TEST_OK` and exits. No new session directories or JSONL files appear in `~/.claude/projects/`.

- [ ] **Step 3: Verify no new sessions were created**

Run:
```bash
AFTER=$(find ~/.claude/projects -name "*.jsonl" -newer hooks/pieces-memory-stop.sh 2>/dev/null | wc -l)
echo "Sessions after test: $AFTER (should equal $BEFORE or be 0 new)"
```

Expected: Same count as before (or 0 new files newer than the hook file).

- [ ] **Step 4: Commit pieces-dev changes**

```bash
git add hooks/pieces-memory-stop.sh hooks/pieces-mcp-register.sh
git commit -m "$(cat <<'EOF'
fix(hooks): isolate pieces-memory-stop.sh to prevent ghost session pollution

Replace bare `claude -p` with CLAUDE_CONFIG_DIR isolation pattern:
- CLAUDE_CONFIG_DIR → ~/.claude/hook-config/ (no hooks, no plugins)
- --no-session-persistence (no transcript on disk)
- --strict-mcp-config + --mcp-config (Pieces MCP only)
- --system-prompt (replaces CLAUDE.md auto-discovery)
- --model claude-haiku-4-5-20251001 (cost isolation)

Add gating to both hooks:
- pieces-memory-stop.sh: cooldown (3 min), session duration (>= 2 min)
- pieces-mcp-register.sh: port-change check, cooldown (5 min)

Fixes PM-005. See docs/superpowers/specs/2026-08-15-pieces-stop-hook-session-pollution-fix.md
EOF
)"
```

---

## Task 5: Update `claude-extras.md` Pieces Section

**Files:**
- Modify: `~/.claude/claude-extras.md` (lines 122-126)

- [ ] **Step 1: Replace the "Pieces long-term memory" section**

Replace lines 122-126 in `~/.claude/claude-extras.md`:

Old:
```markdown
## Pieces long-term memory

A `Stop` hook (`~/.claude/hooks/pieces-memory-stop.sh`) fires async after every session,
reads the transcript, and calls `create_pieces_memory` for significant items. No manual
action needed; exits silently if Pieces OS is down or the session is trivial.
```

New:
```markdown
## Pieces long-term memory

A `Stop` hook (`pieces-dev/hooks/pieces-memory-stop.sh`) fires async after every session,
reads the transcript, and calls `create_pieces_memory` for significant items via an
isolated `claude -p` subprocess (`CLAUDE_CONFIG_DIR` → `~/.claude/hook-config/`,
`--no-session-persistence`, `--strict-mcp-config`, `--system-prompt`,
`--model claude-haiku-4-5-20251001`). Gated by: Pieces OS health, 6-line minimum,
3-minute cooldown, 2-minute session duration. Exits silently if any gate fails.
```

- [ ] **Step 2: Verify the edit**

Read the section back to confirm it renders correctly and mentions CLAUDE_CONFIG_DIR, --no-session-persistence, --system-prompt, and the gating logic.

---

## Task 6: Add CLAUDE_CONFIG_DIR Lesson to AGENTS.md

**Files:**
- Modify: `~/.claude/AGENTS.md` (Shell / Scripts section, after line 227)

- [ ] **Step 1: Add the lesson as a new bullet**

After the Biome `.code-workspace` bullet (line 223-227), add:

```markdown
- Hooks that spawn `claude -p` for background LLM work: set `CLAUDE_CONFIG_DIR` to a
  minimal config directory (empty hooks, no plugins) + `--no-session-persistence` +
  `--strict-mcp-config` + `--system-prompt`. A bare `claude -p` inherits all hooks/plugins
  and creates ghost sessions that pollute every indexing system. Diagnosed 2026-08-15 in
  PM-005: 36,468 ghost sessions over 59 days from one Stop hook.
```

- [ ] **Step 2: Commit and push agent-harness**

The AGENTS.md is symlinked from the agent-harness repo. Navigate to it and commit:

```bash
cd ~/github/joeblackwaslike/agent-harness
git add AGENTS.md
git commit -m "fix(shell): add CLAUDE_CONFIG_DIR isolation rule for hooks spawning claude -p

PM-005: a bare claude -p in a Stop hook created 36,468 ghost sessions by inheriting
all hooks/plugins. Rule: always use CLAUDE_CONFIG_DIR + --no-session-persistence +
--strict-mcp-config + --system-prompt for background LLM work from hooks."
git push
```

---

## Task 7: Create Agent-Skills Reference Doc

**Files:**
- Create: `skills/working-with-claude-code/references/claude-config-dir-isolation.md` in `~/github/joeblackwaslike/agent-skills`

- [ ] **Step 1: Write the reference document**

Create `~/github/joeblackwaslike/agent-skills/skills/working-with-claude-code/references/claude-config-dir-isolation.md`:

```markdown
# Side-Effect-Free `claude -p` from Hooks

## Problem

A bare `claude -p` subprocess inherits the full session lifecycle: settings.json hooks
(SessionStart, Stop, SessionEnd), plugin loading (claude-mem, cc-recall, etc.), CLAUDE.md
auto-discovery, and transcript persistence. When spawned from a hook, this creates a cascade:
each ghost session triggers the same hooks, which spawn more sessions.

**PM-005 impact:** 36,468 ghost sessions, ~547,000 hook invocations, pollution across cc-recall,
claude-mem, and session transcripts over 59 days.

## Solution: CLAUDE_CONFIG_DIR Isolation Pattern

```bash
HOOK_CONFIG="$HOME/.claude/hook-config"  # minimal config dir

CLAUDE_CONFIG_DIR="$HOOK_CONFIG" \
  claude -p \
  --no-session-persistence \
  --model claude-haiku-4-5-20251001 \
  --system-prompt "$PROMPT" \
  --strict-mcp-config \
  --mcp-config '{"server-name":{"type":"http","url":"..."}}' \
  --allowedTools "mcp__server-name__tool_name" \
  "Your input here"
```

## Flag Reference

| Flag | Purpose |
|------|---------|
| `CLAUDE_CONFIG_DIR` (env var) | Points at a directory with a minimal `settings.json` — empty hooks, no plugins. Prevents hook cascade and plugin loading. |
| `--no-session-persistence` | No JSONL transcript written, no session directory created on disk. |
| `--strict-mcp-config` | Only MCP servers from `--mcp-config` are loaded — ignores settings.json MCP entries. |
| `--mcp-config` | Inline JSON specifying exactly which MCP servers the subprocess needs. |
| `--system-prompt` | Replaces CLAUDE.md auto-discovery with the given prompt. CLAUDE.md walks up from CWD, not from config dir, so `CLAUDE_CONFIG_DIR` alone does not suppress it. |
| `--model` | Cost isolation — use a cheap model for background work. |
| `--allowedTools` | Restrict tool access to only what the hook needs. |

## Minimal Config Directory

Create `~/.claude/hook-config/settings.json`:

```json
{
  "hooks": {},
  "enabledPlugins": {}
}
```

## Why Not `--bare`?

`--bare` skips hooks, plugins, CLAUDE.md, and auto-memory — exactly the isolation needed.
But it requires `ANTHROPIC_API_KEY` environment variable auth, which changes the billing
mechanism. If the user has a Max subscription (OAuth/keychain), `--bare` forces a different
auth path. `CLAUDE_CONFIG_DIR` achieves the same isolation while preserving existing auth.

## Adoption Guidance

Any hook or background script that spawns `claude -p` should use this pattern. Known
adopters:

- **pieces-dev** `pieces-memory-stop.sh` — adopted in PM-005 fix
- **cc-recall** `runClaudeHeadless` — should adopt (currently uses dedicated CWD + self-recognition workarounds)
```

- [ ] **Step 2: Commit and push agent-skills**

```bash
cd ~/github/joeblackwaslike/agent-skills
git add skills/working-with-claude-code/references/claude-config-dir-isolation.md
git commit -m "docs: add CLAUDE_CONFIG_DIR isolation pattern reference

Side-effect-free claude -p from hooks — flag reference, minimal config setup,
motivating incident (PM-005), and adoption guidance."
git push
```

---

## Task 8: Ghost Session Classification Script

**Files:**
- Create: scratchpad `classify-ghost-sessions.sh` (temporary, not committed)

This script scans ALL session transcripts, classifies ghost sessions by first-message
content, and outputs a manifest for cleanup.

- [ ] **Step 1: Write the classification script**

Write to `$SCRATCHPAD/classify-ghost-sessions.sh`:

```bash
#!/bin/bash
# classify-ghost-sessions.sh
# Scans all session transcripts and classifies ghost sessions by content pattern.
# Outputs a TSV manifest: session_id \t pattern \t project_dir \t transcript_path

set -uo pipefail

PROJECTS_DIR="$HOME/.claude/projects"
MANIFEST="$1"

if [[ -z "$MANIFEST" ]]; then
  echo "Usage: $0 <output-manifest.tsv>" >&2
  exit 1
fi

> "$MANIFEST"

TOTAL=0
PIECES_GHOST=0
CCRECALL_GHOST=0
SYSREMINDER_ONLY=0
OTHER=0
REAL=0

find "$PROJECTS_DIR" -name "*.jsonl" -type f | while read -r JSONL; do
  TOTAL=$((TOTAL + 1))

  # Extract session_id from filename
  SESSION_ID=$(basename "$JSONL" .jsonl)

  # Extract project dir (parent of the JSONL)
  PROJECT_DIR=$(dirname "$JSONL")

  # Read first few lines to classify
  FIRST_LINES=$(head -5 "$JSONL" 2>/dev/null)
  [[ -z "$FIRST_LINES" ]] && continue

  # Pattern 1: Pieces memory extractor ghost
  if echo "$FIRST_LINES" | grep -q "background memory extractor"; then
    echo -e "${SESSION_ID}\tpieces-memory-ghost\t${PROJECT_DIR}\t${JSONL}" >> "$MANIFEST"
    PIECES_GHOST=$((PIECES_GHOST + 1))
    continue
  fi

  # Pattern 2: cc-recall indexer ghost
  if echo "$FIRST_LINES" | grep -q "You are indexing a Claude Code session transcript"; then
    echo -e "${SESSION_ID}\tcc-recall-indexer-ghost\t${PROJECT_DIR}\t${JSONL}" >> "$MANIFEST"
    CCRECALL_GHOST=$((CCRECALL_GHOST + 1))
    continue
  fi

  # Pattern 3: system-reminder-only sessions (potential ghosts)
  # These need validation — check if the ONLY human content is system-reminder tags
  LINE_COUNT=$(wc -l < "$JSONL" 2>/dev/null || echo 0)
  if [[ "$LINE_COUNT" -le 5 ]]; then
    HAS_REAL_USER=$(head -10 "$JSONL" | jq -r 'select(.type == "human" or .type == "user") | .message.content[]? | select(.type == "text") | .text' 2>/dev/null | grep -v '<system-reminder>' | grep -v '^$' | head -1)
    if [[ -z "$HAS_REAL_USER" ]]; then
      echo -e "${SESSION_ID}\tsystem-reminder-only\t${PROJECT_DIR}\t${JSONL}" >> "$MANIFEST"
      SYSREMINDER_ONLY=$((SYSREMINDER_ONLY + 1))
      continue
    fi
  fi

  REAL=$((REAL + 1))
done

echo "--- Classification Summary ---" >&2
echo "Total transcripts scanned: $TOTAL" >&2
echo "Pieces memory ghosts: $PIECES_GHOST" >&2
echo "cc-recall indexer ghosts: $CCRECALL_GHOST" >&2
echo "System-reminder-only (needs validation): $SYSREMINDER_ONLY" >&2
echo "Real sessions: $REAL" >&2
echo "Manifest written to: $MANIFEST" >&2
```

- [ ] **Step 2: Run the classification**

Run:
```bash
chmod +x "$SCRATCHPAD/classify-ghost-sessions.sh"
bash "$SCRATCHPAD/classify-ghost-sessions.sh" "$SCRATCHPAD/ghost-manifest.tsv"
```

Expected: Summary printed to stderr showing counts per pattern. Manifest TSV written.

- [ ] **Step 3: Validate system-reminder-only pattern with random sample**

Run:
```bash
# Sample 100+ system-reminder-only entries and inspect
grep "system-reminder-only" "$SCRATCHPAD/ghost-manifest.tsv" | shuf | head -100 | while IFS=$'\t' read -r SID PAT PDIR TPATH; do
  echo "=== $SID ==="
  head -3 "$TPATH" | jq -r '.message.content[]?.text // empty' 2>/dev/null | head -5
  echo
done > "$SCRATCHPAD/sysreminder-sample.txt"
wc -l "$SCRATCHPAD/sysreminder-sample.txt"
```

Review the sample output. Only proceed to delete system-reminder-only entries if the
sample confirms they are genuinely ghost sessions, not real work. If ambiguous, exclude
this pattern from the deletion manifest.

- [ ] **Step 4: Review manifest for unexpected patterns**

Run:
```bash
cut -f2 "$SCRATCHPAD/ghost-manifest.tsv" | sort | uniq -c | sort -rn
```

If any pattern other than `pieces-memory-ghost` and `cc-recall-indexer-ghost` has a high
count, investigate individually before including in cleanup. Document any new patterns
discovered.

---

## Task 9: Execute Ghost Session Cleanup

**Files:**
- Modify: `~/.claude/cc-recall/index.db` (after backup)
- Modify: `~/.claude-mem/claude-mem.db` (after backup)
- Delete: ghost JSONL files from manifest

- [ ] **Step 1: Back up databases**

```bash
cp ~/.claude/cc-recall/index.db ~/.claude/cc-recall/index.db.bak-$(date +%Y%m%d)
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.bak-$(date +%Y%m%d)
```

- [ ] **Step 2: Count cc-recall entries before cleanup**

```bash
sqlite3 ~/.claude/cc-recall/index.db "SELECT COUNT(*) FROM sessions"
```

Record the count for verification.

- [ ] **Step 3: Delete pieces-memory ghosts from cc-recall**

```bash
# Extract pieces-memory ghost session IDs from manifest
grep "pieces-memory-ghost" "$SCRATCHPAD/ghost-manifest.tsv" | cut -f1 | while read -r SID; do
  sqlite3 ~/.claude/cc-recall/index.db "DELETE FROM sessions WHERE session_id = '$SID';"
done
sqlite3 ~/.claude/cc-recall/index.db "VACUUM;"
```

- [ ] **Step 4: Delete cc-recall indexer ghosts from cc-recall**

```bash
grep "cc-recall-indexer-ghost" "$SCRATCHPAD/ghost-manifest.tsv" | cut -f1 | while read -r SID; do
  sqlite3 ~/.claude/cc-recall/index.db "DELETE FROM sessions WHERE session_id = '$SID';"
done
sqlite3 ~/.claude/cc-recall/index.db "VACUUM;"
```

- [ ] **Step 5: Clean claude-mem ghost entries**

```bash
# Delete ghost sdk_sessions by user_prompt pattern
sqlite3 ~/.claude-mem/claude-mem.db "DELETE FROM sdk_sessions WHERE user_prompt LIKE '%background memory extractor%';"
# Cascade cleanup — delete orphaned observations, summaries, embeddings
# (Check FK structure first to determine cascade approach)
sqlite3 ~/.claude-mem/claude-mem.db ".schema" | grep -A5 "CREATE TABLE"
```

Adapt cascade deletions based on actual schema. The goal is zero rows matching
`user_prompt LIKE '%background memory extractor%'`.

- [ ] **Step 6: Delete ghost transcript files**

```bash
# Only delete confirmed ghost patterns (pieces-memory-ghost and cc-recall-indexer-ghost)
grep -E "(pieces-memory-ghost|cc-recall-indexer-ghost)" "$SCRATCHPAD/ghost-manifest.tsv" | cut -f4 | while read -r TPATH; do
  rm -f "$TPATH"
done
```

Also delete empty UUID session directories:
```bash
grep -E "(pieces-memory-ghost|cc-recall-indexer-ghost)" "$SCRATCHPAD/ghost-manifest.tsv" | cut -f4 | while read -r TPATH; do
  SESSION_DIR="${TPATH%.jsonl}"
  [[ -d "$SESSION_DIR" ]] && rm -rf "$SESSION_DIR"
done
```

- [ ] **Step 7: Verify cleanup**

```bash
# cc-recall count should be significantly lower
sqlite3 ~/.claude/cc-recall/index.db "SELECT COUNT(*) FROM sessions"

# claude-mem should have zero ghost entries
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM sdk_sessions WHERE user_prompt LIKE '%background memory extractor%'"

# Spot-check: no pieces-memory ghost transcripts should exist
find ~/.claude/projects -name "*.jsonl" -exec grep -l "background memory extractor" {} \; | head -5
```

Expected:
- cc-recall count significantly reduced from baseline
- claude-mem query returns 0
- No ghost transcripts found by grep

---

## Task 10: File cc-recall GitHub Issue

- [ ] **Step 1: Create the issue**

```bash
gh issue create \
  --repo joeblackwaslike/cc-recall \
  --title "Clean up CWD / ghost sessions and adopt CLAUDE_CONFIG_DIR isolation" \
  --body "$(cat <<'EOF'
## Problem

The `-` project directory (`~/.claude/projects/-/`) has 31,156 JSONL files and 31,943
session directories at 4.0 GB from cc-recall v0.1.0 indexer sessions that used CWD `/`.
v0.2.1+ uses a dedicated CWD (`~/.claude/cc-recall/indexer/`), but the old sessions
remain.

Additionally, `runClaudeHeadless` still uses bare `claude -p` with manual workarounds
(dedicated CWD + prompt signature self-recognition + spawn-rate ceiling) instead of the
`CLAUDE_CONFIG_DIR` isolation pattern.

## Tasks

1. **Cleanup:** Delete 31K ghost sessions from `~/.claude/projects/-/` and matching
   entries from cc-recall's index.db
2. **Adopt isolation pattern:** Replace `runClaudeHeadless` bare `claude -p` with
   `CLAUDE_CONFIG_DIR` + `--no-session-persistence` + `--strict-mcp-config` +
   `--system-prompt` (see `agent-skills/skills/working-with-claude-code/references/claude-config-dir-isolation.md`)
3. Remove the self-recognition and dedicated CWD workarounds that become unnecessary

## Context

- PM-005 post-mortem: `postmortems/postmortems/005-pieces-stop-hook-session-pollution.md`
- Isolation pattern reference: `agent-skills/skills/working-with-claude-code/references/claude-config-dir-isolation.md`
EOF
)"
```

- [ ] **Step 2: Record the issue URL**

Save the returned issue URL for reference.

---

## Task 11: Emit Lessons-Learned Formal Entry

- [ ] **Step 1: Emit the lesson tag**

Output the following lesson tag in the response:

```
#lesson
tool: Bash
trigger: claude -p invocation from a Stop/SessionEnd hook
problem: A bare `claude -p` inherits all hooks, plugins, CLAUDE.md, and transcript persistence. When spawned from a hook, each ghost session triggers the same hooks, creating a cascade. PM-005: 36,468 ghost sessions, ~547K hook invocations, pollution across cc-recall/claude-mem/transcripts over 59 days.
solution: Use CLAUDE_CONFIG_DIR isolation pattern — point at a minimal config dir (empty hooks, no plugins) + --no-session-persistence + --strict-mcp-config + --system-prompt + --model. Never use --bare (requires API key auth). See agent-skills/skills/working-with-claude-code/references/claude-config-dir-isolation.md.
tags: tool:claude-cli, tool:hooks, severity:data-pollution, category:session-isolation
#/lesson
```

---

## Task 12: Push pieces-dev and Verify

- [ ] **Step 1: Push pieces-dev**

```bash
cd ~/github/joeblackwaslike/pieces-dev
git push
```

- [ ] **Step 2: Final verification checklist**

Run all verification checks from the spec:

```bash
# 1. pieces-memory-stop.sh uses isolation pattern
grep -q "CLAUDE_CONFIG_DIR" hooks/pieces-memory-stop.sh && echo "✓ CLAUDE_CONFIG_DIR" || echo "✗ CLAUDE_CONFIG_DIR"
grep -q "no-session-persistence" hooks/pieces-memory-stop.sh && echo "✓ --no-session-persistence" || echo "✗ --no-session-persistence"
grep -q "strict-mcp-config" hooks/pieces-memory-stop.sh && echo "✓ --strict-mcp-config" || echo "✗ --strict-mcp-config"
grep -q "system-prompt" hooks/pieces-memory-stop.sh && echo "✓ --system-prompt" || echo "✗ --system-prompt"

# 2. pieces-mcp-register.sh has gating
grep -q "COOLDOWN_FILE" hooks/pieces-mcp-register.sh && echo "✓ cooldown gating" || echo "✗ cooldown gating"
grep -q "CURRENT_URL" hooks/pieces-mcp-register.sh && echo "✓ port-change check" || echo "✗ port-change check"

# 3. claude-extras.md updated
grep -q "CLAUDE_CONFIG_DIR" ~/.claude/claude-extras.md && echo "✓ claude-extras.md" || echo "✗ claude-extras.md"

# 4. hook-config exists
[[ -f ~/.claude/hook-config/settings.json ]] && echo "✓ hook-config" || echo "✗ hook-config"

# 5. cc-recall reduction
sqlite3 ~/.claude/cc-recall/index.db "SELECT COUNT(*) FROM sessions"

# 6. claude-mem clean
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM sdk_sessions WHERE user_prompt LIKE '%background memory extractor%'"
```

Expected: All checks pass with ✓. cc-recall count significantly reduced. claude-mem ghost count is 0.
