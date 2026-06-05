import * as vscode from 'vscode';
import {
  PiecesClient,
  VSCODE_APP,
  tabSwitchEvent,
  appEnterEvent,
  appLeaveEvent,
  checkInEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

export function registerTabHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
  checkInIntervalMs: number,
): vscode.Disposable[] {
  let checkInTimer: ReturnType<typeof setInterval> | undefined;

  function send(event: Record<string, unknown>, label: string): void {
    if (connected()) {
      client.postEvent(event);
      log(label);
    } else {
      queue.enqueue(event as { application: { id: string; name: string; version: string; platform: string }; trigger: Record<string, boolean> });
    }
  }

  function startCheckIn(): void {
    stopCheckIn();
    checkInTimer = setInterval(() => {
      send(
        checkInEvent(VSCODE_APP, 'VS Code active') as Record<string, unknown>,
        'check_in: heartbeat',
      );
    }, checkInIntervalMs);
  }

  function stopCheckIn(): void {
    if (checkInTimer) {
      clearInterval(checkInTimer);
      checkInTimer = undefined;
    }
  }

  const onTabSwitch = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    const doc = editor.document;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const event = tabSwitchEvent(
      VSCODE_APP,
      doc.uri.fsPath,
      doc.languageId,
      folder?.uri.fsPath,
    );
    send(event as Record<string, unknown>, `tab_switch: ${doc.uri.fsPath}`);
  });

  const onFocus = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      send(
        appEnterEvent(VSCODE_APP, 'VS Code focused') as Record<string, unknown>,
        'application_enter',
      );
      startCheckIn();
    } else {
      send(
        appLeaveEvent(VSCODE_APP, 'VS Code backgrounded') as Record<string, unknown>,
        'application_leave',
      );
      stopCheckIn();
    }
  });

  if (vscode.window.state.focused) {
    startCheckIn();
  }

  const dispose = new vscode.Disposable(() => stopCheckIn());
  return [onTabSwitch, onFocus, dispose];
}
