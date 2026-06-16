#!/bin/bash
# pieces-mcp-register.sh
# SessionStart hook: updates the Pieces MCP server URL in settings.json
# using the dynamic port Pieces OS picks at startup (39300-39333 range).

set -euo pipefail

PORT_FILE="$HOME/Library/com.pieces.os/production/Config/.port.txt"
SETTINGS="$HOME/.claude/settings.json"

# Nothing to do if Pieces isn't installed or hasn't started
[[ -f "$PORT_FILE" ]] || exit 0
PORT=$(tr -d '[:space:]' < "$PORT_FILE")
[[ -n "$PORT" ]] || exit 0

URL="http://localhost:$PORT/model_context_protocol/2025-03-26/mcp"

# Update (or add) the pieces MCP server entry in settings.json
TMP=$(mktemp)
jq --arg url "$URL" '.mcpServers.pieces = {"type": "http", "url": $url}' "$SETTINGS" > "$TMP" \
  && mv "$TMP" "$SETTINGS" \
  || rm -f "$TMP"

exit 0
