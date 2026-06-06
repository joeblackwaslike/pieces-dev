# Pieces LTM Injector

Injects IDE workstream events into PiecesOS Long-Term Memory on every interaction.

## Prerequisites

- [PiecesOS](https://docs.pieces.app/products/desktop/download) must be installed and running
- LTM must be enabled in PiecesOS settings

## Features

- **File events**: open, close
- **Tab events**: switch, with language and workspace context
- **Focus events**: application enter/leave, periodic check-in heartbeat
- **Clipboard**: copy events with content capture (truncated to 500 chars)
- **Git**: branch switches, new commits (requires VS Code git extension)
- **Terminal**: command activity (throttled to 1 event per 10s per terminal)
- **Debug**: session start/end
- **Claude Code**: real-time JSONL session parsing, file path extraction

## Settings

All settings are under `pieces-ltm-injector.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master on/off |
| `portOverride` | `null` | Skip port auto-discovery |
| `heartbeatInterval` | `30000` | Port re-probe interval (ms) |
| `checkInInterval` | `60000` | Check-in heartbeat interval (ms) |
| `queueSize` | `500` | Max queued events when disconnected |
| `debugLogging` | `false` | Log every event to output channel |
| `enableClaudeCodeIntegration` | `true` | Watch Claude Code sessions |
| `enableGitEvents` | `true` | Git branch/commit events |
| `enableTerminalEvents` | `true` | Terminal command events |

## Offline Resilience

When PiecesOS is unreachable, events are queued in a ring buffer (default 500). Events are automatically flushed when the connection is restored. The status bar shows queue depth.
