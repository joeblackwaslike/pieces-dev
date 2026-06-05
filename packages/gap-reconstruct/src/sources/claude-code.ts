import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  type SourceEvent,
  OS_SERVER_APP,
  fileOpenEvent,
  checkInEvent,
  appEnterEvent,
  appLeaveEvent,
} from '@pieces-dev/core';
import type { Source } from './types.js';

const CLAUDE_PROJECTS_DIR = join(
  process.env.HOME ?? '',
  '.claude/projects',
);

export class ClaudeCodeSource implements Source {
  readonly name = 'claude';
  private readonly projectsDir: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? CLAUDE_PROJECTS_DIR;
  }

  async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
    const jsonlFiles = await this.findJsonlFiles();

    for (const filePath of jsonlFiles) {
      yield* this.parseSession(filePath, from, to);
    }
  }

  private async findJsonlFiles(): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(this.projectsDir, {
        recursive: true,
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.endsWith('.jsonl') &&
          !entry.parentPath.includes('subagent')
        ) {
          files.push(join(entry.parentPath, entry.name));
        }
      }
    } catch {
      // Directory not found — no Claude Code sessions
    }

    return files;
  }

  private async *parseSession(
    filePath: string,
    from: Date,
    to: Date,
  ): AsyncIterable<SourceEvent> {
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    let sessionStartEmitted = false;
    let lastTimestamp: Date | undefined;
    const repoRoot = this.inferRepoRoot(filePath);

    for await (const line of rl) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const ts = this.extractTimestamp(parsed);
      if (!ts || ts < from || ts > to) continue;

      lastTimestamp = ts;

      if (!sessionStartEmitted && (parsed.type === 'human' || parsed.type === 'user')) {
        sessionStartEmitted = true;
        yield {
          timestamp: ts,
          event: appEnterEvent(
            OS_SERVER_APP,
            `Claude Code session in ${repoRoot ? basename(repoRoot) : 'unknown'}`,
          ),
          source: 'claude',
          dedupKey: `application_enter:claude-code:${this.roundTo5s(ts)}`,
        };
      }

      if (parsed.type === 'assistant') {
        yield* this.extractToolUseEvents(parsed, ts, repoRoot);
      }
    }

    if (lastTimestamp && sessionStartEmitted) {
      yield {
        timestamp: lastTimestamp,
        event: appLeaveEvent(OS_SERVER_APP, 'Claude Code session ended'),
        source: 'claude',
        dedupKey: `application_leave:claude-code:${this.roundTo5s(lastTimestamp)}`,
      };
    }
  }

  private *extractToolUseEvents(
    parsed: Record<string, unknown>,
    ts: Date,
    repoRoot: string | undefined,
  ): Iterable<SourceEvent> {
    const content = parsed.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        typeof block !== 'object' ||
        block === null ||
        (block as Record<string, unknown>).type !== 'tool_use'
      ) {
        continue;
      }

      const toolUse = block as { name?: string; input?: Record<string, unknown> };
      const toolName = toolUse.name;
      const input = toolUse.input;

      if (!toolName || !input) continue;

      if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
        const filePath =
          (input.file_path as string | undefined) ??
          (input.path as string | undefined);
        if (filePath) {
          yield {
            timestamp: ts,
            event: fileOpenEvent(OS_SERVER_APP, filePath, undefined, repoRoot),
            source: 'claude',
            dedupKey: `file_open:${filePath}:${this.roundTo5s(ts)}`,
          };
        }
      }

      if (toolName === 'Bash') {
        const cmd = input.command as string | undefined;
        if (cmd) {
          yield {
            timestamp: ts,
            event: checkInEvent(
              OS_SERVER_APP,
              `Terminal: ${cmd.slice(0, 100)}`,
            ),
            source: 'claude',
            dedupKey: `check_in:bash:${this.roundTo5s(ts)}`,
          };
        }
      }
    }
  }

  private extractTimestamp(
    parsed: Record<string, unknown>,
  ): Date | undefined {
    const raw = parsed.timestamp as string | undefined;
    if (!raw) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  private inferRepoRoot(sessionPath: string): string | undefined {
    const parts = sessionPath.split('/');
    const projectsIdx = parts.indexOf('projects');
    if (projectsIdx < 0) return undefined;
    const encoded = parts[projectsIdx + 1];
    if (!encoded) return undefined;
    return encoded.replace(/-/g, '/');
  }

  private roundTo5s(date: Date): number {
    return Math.round(date.getTime() / 5000) * 5000;
  }
}
