import { spawnSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { checkInEvent, type SourceEvent, tabSwitchEvent, VSCODE_APP } from '@pieces-dev/core';
import { roundTo5s } from './round.js';
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

const GIT_TIMEOUT_MS = 10000;

export class GitLogSource implements Source {
	readonly name = 'git';
	private readonly repos: string[];

	constructor(repos: string[]) {
		this.repos = repos;
	}

	async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
		if (this.repos.length === 0) {
			console.warn('GitLogSource: no repositories configured (pass --repos) — skipping git events');
			return;
		}
		for (const repo of this.repos) {
			yield* this.collectRepo(repo, from, to);
		}
	}

	private *collectRepo(repo: string, from: Date, to: Date): Iterable<SourceEvent> {
		// Use spawnSync with an argument array (no shell) so repo paths with
		// spaces, quotes, or shell metacharacters cannot break parsing or inject
		// commands.
		const result = spawnSync(
			'git',
			[
				'-C',
				repo,
				'log',
				`--after=${from.toISOString()}`,
				`--before=${to.toISOString()}`,
				'--format=%H|%aI|%s',
				'--name-only',
			],
			{ encoding: 'utf-8', timeout: GIT_TIMEOUT_MS },
		);

		if (result.error || result.status !== 0) {
			console.warn(`git log failed for ${repo} — skipping`);
			return;
		}

		const lines = result.stdout.split('\n');
		let currentCommit: { hash: string; date: Date; subject: string } | undefined;

		for (const line of lines) {
			// `git log --name-only` prints a blank line between the commit header
			// and its file list. Skip blanks WITHOUT clearing currentCommit —
			// commits are delimited by the next header line, not by blanks.
			if (!line.trim()) {
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
							event: checkInEvent(VSCODE_APP, `Committed: ${currentCommit.subject} in ${repoName}`),
							source: 'git',
							dedupKey: `check_in:${currentCommit.hash}:${roundTo5s(currentCommit.date)}`,
						};
						continue;
					}
				}
			}

			if (currentCommit) {
				const filePath = join(repo, line.trim());
				const ext = extname(line.trim());
				const language = LANGUAGE_MAP[ext];

				yield {
					timestamp: currentCommit.date,
					event: tabSwitchEvent(VSCODE_APP, filePath, language, repo),
					source: 'git',
					dedupKey: `tab_switch:${filePath}:${roundTo5s(currentCommit.date)}`,
				};
			}
		}
	}
}
