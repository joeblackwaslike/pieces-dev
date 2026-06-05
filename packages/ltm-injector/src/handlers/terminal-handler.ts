import * as vscode from 'vscode';
import { PiecesClient, VSCODE_APP, checkInEvent } from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

const THROTTLE_MS = 10000;

export function registerTerminalHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const lastEvent = new Map<number, number>();

  const sub = vscode.window.onDidWriteTerminalData((e) => {
    const termId = e.terminal.processId ?? 0;
    const now = Date.now();
    const last = lastEvent.get(termId as number);
    if (last && now - last < THROTTLE_MS) return;
    lastEvent.set(termId as number, now);

    const text = e.data.trim().slice(0, 100);
    if (!text) return;

    const event = checkInEvent(VSCODE_APP, `Terminal: ${text}`);

    if (connected()) {
      client.postEvent(event as Record<string, unknown>);
      log(`terminal: ${text.slice(0, 50)}`);
    } else {
      queue.enqueue(event);
    }
  });

  return [sub];
}
