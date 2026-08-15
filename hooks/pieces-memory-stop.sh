#!/bin/bash
# pieces-memory-stop.sh
# Stop hook (async): extracts significant decisions/discoveries from the session
# transcript and pins them to Pieces as indefinite memories via create_pieces_memory.
#
# Uses --setting-sources "" isolation pattern (PM-005) — the subprocess loads
# no settings files (hooks, plugins, MCP suppressed), preventing session pollution.

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
PIECES_MCP_URL="http://localhost:$PORT/model_context_protocol/2025-03-26/mcp"

PROMPT="You are a background memory extractor running after a Claude Code session. Read the session transcript at: $TRANSCRIPT (it is a JSONL file — each line is one turn). Extract 0-4 items worth pinning permanently in Pieces. Focus only on: architectural decisions made, debugging breakthroughs (root cause + fix), surprising discoveries, or clearly completed milestones. For each item, call the create_pieces_memory tool with: summary (2-4 sentences of markdown covering what happened and why it matters), summary_description (one-line label, <80 chars), project=$CWD. Do NOT call it if the session had no significant decisions or if you cannot reach the Pieces MCP server. Output nothing else."

/opt/homebrew/bin/claude -p \
  --no-session-persistence \
  --setting-sources "" \
  --model claude-haiku-4-5-20251001 \
  --system-prompt "$PROMPT" \
  --strict-mcp-config \
  --mcp-config "{\"pieces\":{\"type\":\"http\",\"url\":\"$PIECES_MCP_URL\"}}" \
  --allowedTools "mcp__pieces__create_pieces_memory" \
  "Extract significant items from the session transcript and save them to Pieces." \
  > /dev/null 2>&1

CLAUDE_EXIT=$?

# Update cooldown timestamp only on successful extraction
if [[ "$CLAUDE_EXIT" -eq 0 ]]; then
  mkdir -p "$(dirname "$COOLDOWN_FILE")"
  date +%s > "$COOLDOWN_FILE"
fi

exit 0
