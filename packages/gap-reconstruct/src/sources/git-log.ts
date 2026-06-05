import { execSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import {
  type SourceEvent,
  VSCODE_APP,
  checkInEvent,
  tabSwitchEvent,
} from '@pieces-dev/core';
import type { Source } from './types.js';

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.json': 'json',
  '.md': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sql': 'sql',
  '.sh': 'shellscript',
  '.css': 'css',
  '.html': 'html',
};

export class GitLogSource implements Source {
  readonly name = 'git';
  private readonly repos: string[];

  constructor(repos: string[]) {
    this.repos = repos;
  }

  async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
    for (const repo of this.repos) {
      yield* this.collectRepo(repo, from, to);
    }
  }

  private *collectRepo(
    repo: string,
    from: Date,
    to: Date,
  ): Iterable<SourceEvent> {
    let output: string;
    try {
      output = execSync(
        `git -C "${repo}" log --after="${from.toISOString()}" --before="${to.toISOString()}" --format="%H|%aI|%s" --name-only`,
        { encoding: 'utf-8', timeout: 10000 },
      );
    } catch {
      console.warn(`git log failed for ${repo} — skipping`);
      return;
    }

    const lines = output.split('\n');
    let currentCommit: { hash: string; date: Date; subject: string } | undefined;

    for (const line of lines) {
      if (!line.trim()) {
        currentCommit = undefined;
        continue;
      }

      const pipeIdx = line.indexOf('|');
      if (pipeIdx > 0 && line.indexOf('|', pipeIdx + 1) > 0) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const date = new Date(parts[1]!);
          if (!Number.isNaN(date.getTime())) {
            currentCommit = {
              hash: parts[0]!,
              date,
              subject: parts.slice(2).join('|'),
            };

            const repoName = basename(repo);
            yield {
              timestamp: currentCommit.date,
              event: checkInEvent(
                VSCODE_APP,
                `Committed: ${currentCommit.subject} in ${repoName}`,
              ),
              source: 'git',
              dedupKey: `check_in:${currentCommit.hash}:${this.roundTo5s(currentCommit.date)}`,
            };
            continue;
          }
        }
      }

      if (currentCommit && line.trim()) {
        const filePath = join(repo, line.trim());
        const ext = extname(line.trim());
        const language = LANGUAGE_MAP[ext];

        yield {
          timestamp: currentCommit.date,
          event: tabSwitchEvent(VSCODE_APP, filePath, language, repo),
          source: 'git',
          dedupKey: `tab_switch:${filePath}:${this.roundTo5s(currentCommit.date)}`,
        };
      }
    }
  }

  private roundTo5s(date: Date): number {
    return Math.round(date.getTime() / 5000) * 5000;
  }
}
