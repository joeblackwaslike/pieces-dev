import * as vscode from 'vscode';
import { PiecesClient, VSCODE_APP, copyEvent } from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

export function registerClipboardHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const cmd = vscode.commands.registerCommand(
    'pieces-ltm-injector.clipboardCopy',
    async () => {
      await vscode.commands.executeCommand(
        'editor.action.clipboardCopyAction',
      );

      const text = await vscode.env.clipboard.readText();
      if (!text) return;

      const event = copyEvent(VSCODE_APP, text);

      if (connected()) {
        client.postEvent(event as Record<string, unknown>);
        log(`copy: ${text.slice(0, 50)}...`);
      } else {
        queue.enqueue(event);
      }
    },
  );

  return [cmd];
}
