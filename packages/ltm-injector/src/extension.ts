import * as vscode from 'vscode';
import { PiecesClient, discoverPort } from '@pieces-dev/core';
import { EventQueue } from './event-queue.js';
import { registerFileHandler } from './handlers/file-handler.js';
import { registerTabHandler } from './handlers/tab-handler.js';
import { registerClipboardHandler } from './handlers/clipboard-handler.js';

let client: PiecesClient | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let isConnected = false;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('pieces-ltm-injector');
  if (!config.get<boolean>('enabled', true)) return;

  const output = vscode.window.createOutputChannel('Pieces LTM Injector');
  context.subscriptions.push(output);

  const queueSize = config.get<number>('queueSize', 500);
  const queue = new EventQueue(queueSize);

  const portOverride = config.get<number | null>('portOverride', null);
  const heartbeatMs = config.get<number>('heartbeatInterval', 30000);
  const checkInMs = config.get<number>('checkInInterval', 60000);
  const debugLogging = config.get<boolean>('debugLogging', false);

  const log = (msg: string) => {
    if (debugLogging) {
      output.appendLine(`[${new Date().toISOString()}] ${msg}`);
    }
  };

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusBar.command = 'pieces-ltm-injector.showOutput';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('pieces-ltm-injector.showOutput', () => {
      output.show();
    }),
  );

  function updateStatus(): void {
    if (isConnected) {
      statusBar.text = '$(plug) Pieces';
      statusBar.tooltip = 'PiecesOS connected';
      statusBar.backgroundColor = undefined;
    } else {
      const depth = queue.size;
      statusBar.text = depth > 0
        ? `$(warning) Pieces (${depth} queued)`
        : '$(warning) Pieces';
      statusBar.tooltip = 'PiecesOS disconnected';
      statusBar.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    }
    statusBar.show();
  }

  async function connect(): Promise<void> {
    const port = await discoverPort(
      portOverride ? { portOverride } : undefined,
    );

    if (port) {
      client = new PiecesClient(port);
      const healthy = await client.checkHealth();
      if (healthy) {
        isConnected = true;
        output.appendLine(`Connected to PiecesOS on port ${port}`);
        updateStatus();

        await queue.drain(async (event) => {
          await client!.postEvent(event as Record<string, unknown>);
        });
        return;
      }
    }

    isConnected = false;
    output.appendLine('PiecesOS not found — events will be queued');
    updateStatus();
  }

  await connect();

  heartbeatTimer = setInterval(async () => {
    if (!isConnected) {
      await connect();
    } else if (client) {
      const healthy = await client.checkHealth();
      if (!healthy) {
        isConnected = false;
        output.appendLine('PiecesOS connection lost');
        updateStatus();
      }
    }
  }, heartbeatMs);

  context.subscriptions.push(new vscode.Disposable(() => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }));

  const connected = () => isConnected && client !== undefined;

  if (client) {
    context.subscriptions.push(
      ...registerFileHandler(client, queue, connected, log),
      ...registerTabHandler(client, queue, connected, log, checkInMs),
      ...registerClipboardHandler(client, queue, connected, log),
    );
  }
}

export function deactivate(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}
