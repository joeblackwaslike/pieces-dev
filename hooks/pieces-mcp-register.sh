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

# --- Guard: port unchanged ---
if [[ -f "$SETTINGS" ]]; then
  CURRENT_URL=$(jq -r '.mcpServers.pieces.url // ""' "$SETTINGS" 2>/dev/null)
  [[ "$CURRENT_URL" == "$URL" ]] && exit 0
fi

# --- Guard: cooldown (skip if last run < 5 min ago) ---
# Placed AFTER port-change check so a Pieces OS restart on a new port
# bypasses cooldown and immediately registers the new endpoint.
if [[ -f "$COOLDOWN_FILE" ]]; then
  LAST_RUN=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  ELAPSED=$(( NOW - LAST_RUN ))
  [[ "$ELAPSED" -lt 300 ]] && exit 0
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
