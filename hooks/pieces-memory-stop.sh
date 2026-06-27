#!/bin/bash
# pieces-memory-stop.sh
# Stop hook (async): extracts significant decisions/discoveries from the session
# transcript and pins them to Pieces as indefinite memories via create_pieces_memory.
#
# Guards:
#   - Skips if Pieces OS REST API is not responding (not running)
#   - Skips short sessions (< 6 transcript messages) to avoid recursive firing
#     when claude -p subprocesses trigger their own Stop hooks

set -uo pipefail

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

[[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 0

# Skip if Pieces OS is not running. Pieces binds a dynamic port (39300+),
# recorded in .port.txt — read it instead of assuming a fixed port.
PORT_FILE="$HOME/Library/com.pieces.os/production/Config/.port.txt"
[[ -f "$PORT_FILE" ]] || exit 0
PORT=$(tr -d '[:space:]' < "$PORT_FILE")
[[ -n "$PORT" ]] || exit 0
curl -sf --max-time 2 "http://localhost:$PORT/.well-known/health" > /dev/null 2>&1 || exit 0

# Skip short sessions (guards against recursive firing from claude -p subprocesses)
MSG_COUNT=$(wc -l < "$TRANSCRIPT" 2>/dev/null || echo 0)
[[ "$MSG_COUNT" -lt 6 ]] && exit 0

PROMPT="You are a background memory extractor running after a Claude Code session. Read the session transcript at: $TRANSCRIPT (it is a JSONL file — each line is one turn). Extract 0-4 items worth pinning permanently in Pieces. Focus only on: architectural decisions made, debugging breakthroughs (root cause + fix), surprising discoveries, or clearly completed milestones. For each item, call the create_pieces_memory tool with: summary (2-4 sentences of markdown covering what happened and why it matters), summary_description (one-line label, <80 chars), project=$CWD. Do NOT call it if the session had no significant decisions or if you cannot reach the Pieces MCP server. Output nothing else."

LOG="$HOME/.claude/logs/pieces-memory-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$(dirname "$LOG")"

/opt/homebrew/bin/claude -p "$PROMPT" \
  --allowedTools "mcp__pieces__create_pieces_memory" \
  > "$LOG" 2>&1

exit 0
