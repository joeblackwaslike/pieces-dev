import * as vscode from 'vscode';
import {
  PiecesClient,
  VSCODE_APP,
  appEnterEvent,
  appLeaveEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

export function registerDebugHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  function send(event: Record<string, unknown>, label: string): void {
    if (connected()) {
      client.postEvent(event);
      log(label);
    } else {
      queue.enqueue(event as { application: { id: string; name: string; version: string; platform: string }; trigger: Record<string, boolean> });
    }
  }

  const onStart = vscode.debug.onDidStartDebugSession((session) => {
    send(
      appEnterEvent(
        VSCODE_APP,
        `Debug: ${session.name} (${session.type})`,
      ) as Record<string, unknown>,
      `debug: started ${session.name}`,
    );
  });

  const onEnd = vscode.debug.onDidTerminateDebugSession((session) => {
    send(
      appLeaveEvent(
        VSCODE_APP,
        `Debug ended: ${session.name}`,
      ) as Record<string, unknown>,
      `debug: ended ${session.name}`,
    );
  });

  return [onStart, onEnd];
}
