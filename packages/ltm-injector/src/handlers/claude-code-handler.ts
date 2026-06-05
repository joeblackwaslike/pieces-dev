import * as vscode from 'vscode';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import {
  PiecesClient,
  OS_SERVER_APP,
  fileOpenEvent,
  checkInEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

const CLAUDE_PROJECTS = join(homedir(), '.claude/projects');

export function registerClaudeCodeHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const watchedFiles = new Set<string>();
  const fileSizes = new Map<string, number>();

  function send(event: Record<string, unknown>, label: string): void {
    if (connected()) {
      client.postEvent(event);
      log(label);
    } else {
      queue.enqueue(event as { application: { id: string; name: string; version: string; platform: string }; trigger: Record<string, boolean> });
    }
  }

  let watcher: ReturnType<typeof watch> | undefined;

  try {
    watcher = watch(CLAUDE_PROJECTS, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      if (filename.includes('subagent')) return;

      const fullPath = join(CLAUDE_PROJECTS, filename);
      if (watchedFiles.has(fullPath)) return;
      watchedFiles.add(fullPath);

      tailFile(fullPath);
    });
  } catch {
    log('Claude Code projects directory not found — skipping');
    return [];
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
          fileSizes.set(filePath, newContent.length);

          for (const line of newPart.split('\n').filter(Boolean)) {
            processLine(line, filePath);
          }
        } catch {
          clearInterval(checkInterval);
          watchedFiles.delete(filePath);
        }
      }, 2000);
    } catch {
      watchedFiles.delete(filePath);
    }
  }

  function processLine(line: string, sessionPath: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
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

      if (
        toolUse.name === 'Read' ||
        toolUse.name === 'Edit' ||
        toolUse.name === 'Write'
      ) {
        const fp =
          (input.file_path as string | undefined) ??
          (input.path as string | undefined);
        if (fp && !isOpenInVSCode(fp)) {
          send(
            fileOpenEvent(OS_SERVER_APP, fp) as Record<string, unknown>,
            `claude-code: ${toolUse.name} ${basename(fp)}`,
          );
        }
      }

      if (toolUse.name === 'Bash') {
        const cmd = input.command as string | undefined;
        if (cmd) {
          send(
            checkInEvent(
              OS_SERVER_APP,
              `Claude Code: ${cmd.slice(0, 100)}`,
            ) as Record<string, unknown>,
            `claude-code: bash in ${project}`,
          );
        }
      }
    }
  }

  function isOpenInVSCode(filePath: string): boolean {
    return vscode.workspace.textDocuments.some(
      (doc) => doc.uri.fsPath === filePath,
    );
  }

  function inferProject(sessionPath: string): string {
    const parts = sessionPath.split('/');
    const projIdx = parts.indexOf('projects');
    if (projIdx >= 0 && parts[projIdx + 1]) {
      return parts[projIdx + 1]!.replace(/-/g, '/');
    }
    return 'unknown';
  }

  const dispose = new vscode.Disposable(() => {
    watcher?.close();
  });

  return [dispose];
}
