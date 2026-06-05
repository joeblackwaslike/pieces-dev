import * as vscode from 'vscode';
import {
  PiecesClient,
  VSCODE_APP,
  fileOpenEvent,
  fileCloseEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

const DEBOUNCE_MS = 2000;
const SKIP_SCHEMES = new Set(['untitled', 'output', 'vscode', 'git', 'debug']);

export function registerFileHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const recentOpens = new Map<string, number>();

  const onOpen = vscode.workspace.onDidOpenTextDocument((doc) => {
    if (SKIP_SCHEMES.has(doc.uri.scheme)) return;

    const path = doc.uri.fsPath;
    const now = Date.now();
    const last = recentOpens.get(path);
    if (last && now - last < DEBOUNCE_MS) return;
    recentOpens.set(path, now);

    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const event = fileOpenEvent(
      VSCODE_APP,
      path,
      doc.languageId,
      folder?.uri.fsPath,
    );

    if (connected()) {
      client.postEvent(event as Record<string, unknown>);
      log(`file_open: ${path}`);
    } else {
      queue.enqueue(event);
    }
  });

  const onClose = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (SKIP_SCHEMES.has(doc.uri.scheme)) return;

    const path = doc.uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const event = fileCloseEvent(
      VSCODE_APP,
      path,
      doc.languageId,
      folder?.uri.fsPath,
    );

    if (connected()) {
      client.postEvent(event as Record<string, unknown>);
      log(`file_close: ${path}`);
    } else {
      queue.enqueue(event);
    }
  });

  return [onOpen, onClose];
}
