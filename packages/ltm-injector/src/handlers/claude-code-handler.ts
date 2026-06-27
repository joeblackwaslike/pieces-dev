import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { checkInEvent, fileOpenEvent, OS_SERVER_APP } from '@pieces-dev/core';
import * as vscode from 'vscode';
import type { EmitFn, LogFn } from '../emit.js';

const CLAUDE_PROJECTS = join(homedir(), '.claude/projects');
const TAIL_INTERVAL_MS = 2000;

export function registerClaudeCodeHandler(emit: EmitFn, log: LogFn): vscode.Disposable[] {
	const watchedFiles = new Set<string>();
	const fileSizes = new Map<string, number>();
	// Track every tailFile poll timer so they can all be cleared on dispose —
	// otherwise they keep firing after the extension deactivates.
	const fileIntervals = new Map<string, ReturnType<typeof setInterval>>();

	let watcher: ReturnType<typeof watch> | undefined;

	try {
		watcher = watch(CLAUDE_PROJECTS, { recursive: true }, (_eventType, filename) => {
			if (!filename?.endsWith('.jsonl')) return;
			if (filename.includes('subagent')) return;

			const fullPath = join(CLAUDE_PROJECTS, filename);
			if (watchedFiles.has(fullPath)) return;
			watchedFiles.add(fullPath);

			void tailFile(fullPath);
		});
	} catch (err) {
		log(`Claude Code projects directory not watchable — skipping: ${err}`);
		return [];
	}

	function stopTailing(filePath: string): void {
		const interval = fileIntervals.get(filePath);
		if (interval) {
			clearInterval(interval);
			fileIntervals.delete(filePath);
		}
		watchedFiles.delete(filePath);
	}

	async function tailFile(filePath: string): Promise<void> {
		try {
			const content = await readFile(filePath, 'utf-8');
			fileSizes.set(filePath, content.length);

			const checkInterval = setInterval(async () => {
				try {
					const newContent = await readFile(filePath, 'utf-8');
					const prevSize = fileSizes.get(filePath) ?? 0;
					if (newContent.length <= prevSize) return;

					const newPart = newContent.slice(prevSize);
					// Only consume up to the last complete line. A trailing partial line
					// (no newline yet) must stay unconsumed so the rest can append to it
					// on the next poll — otherwise advancing to EOF would split and lose
					// that record.
					const lastNewline = newPart.lastIndexOf('\n');
					if (lastNewline === -1) return;
					fileSizes.set(filePath, prevSize + lastNewline + 1);

					for (const line of newPart.slice(0, lastNewline).split('\n').filter(Boolean)) {
						processLine(line, filePath);
					}
				} catch (err) {
					log(`claude-code: stopped tailing ${basename(filePath)}: ${err}`);
					stopTailing(filePath);
				}
			}, TAIL_INTERVAL_MS);

			fileIntervals.set(filePath, checkInterval);
		} catch (err) {
			log(`claude-code: could not read ${basename(filePath)}: ${err}`);
			watchedFiles.delete(filePath);
		}
	}

	function processLine(line: string, sessionPath: string): void {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Partial/truncated trailing line while tailing — expected; skip.
			return;
		}

		if (parsed.type !== 'assistant') return;

		const content = parsed.content;
		if (!Array.isArray(content)) return;

		const project = inferProject(sessionPath);

		for (const block of content) {
			if (
				typeof block !== 'object' ||
				block === null ||
				(block as Record<string, unknown>).type !== 'tool_use'
			) {
				continue;
			}

			const toolUse = block as { name?: string; input?: Record<string, unknown> };
			const input = toolUse.input;
			if (!input) continue;

			if (toolUse.name === 'Read' || toolUse.name === 'Edit' || toolUse.name === 'Write') {
				const fp = (input.file_path as string | undefined) ?? (input.path as string | undefined);
				if (fp && !isOpenInVSCode(fp)) {
					emit(fileOpenEvent(OS_SERVER_APP, fp), `claude-code: ${toolUse.name} ${basename(fp)}`);
				}
			}

			if (toolUse.name === 'Bash') {
				const cmd = input.command as string | undefined;
				if (cmd) {
					emit(
						checkInEvent(OS_SERVER_APP, `Claude Code: ${cmd.slice(0, 100)}`),
						`claude-code: bash in ${project}`,
					);
				}
			}
		}
	}

	function isOpenInVSCode(filePath: string): boolean {
		return vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === filePath);
	}

	function inferProject(sessionPath: string): string {
		// Split on both separators so the 'projects' segment is found on Windows
		// (backslash paths) too. The result is a best-effort label only.
		const parts = sessionPath.split(/[/\\]/);
		const projIdx = parts.indexOf('projects');
		if (projIdx >= 0 && parts[projIdx + 1]) {
			return parts[projIdx + 1]?.replace(/-/g, '/');
		}
		return 'unknown';
	}

	const dispose = new vscode.Disposable(() => {
		watcher?.close();
		for (const interval of fileIntervals.values()) {
			clearInterval(interval);
		}
		fileIntervals.clear();
		watchedFiles.clear();
	});

	return [dispose];
}
