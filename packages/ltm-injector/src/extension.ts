import { discoverPort, PiecesClient } from '@pieces-dev/core';
import * as vscode from 'vscode';
import type { EmitFn } from './emit.js';
import { EventQueue } from './event-queue.js';
import { registerClaudeCodeHandler } from './handlers/claude-code-handler.js';
import { registerClipboardHandler } from './handlers/clipboard-handler.js';
import { registerDebugHandler } from './handlers/debug-handler.js';
import { registerFileHandler } from './handlers/file-handler.js';
import { registerGitHandler } from './handlers/git-handler.js';
import { registerTabHandler } from './handlers/tab-handler.js';
import { registerTerminalHandler } from './handlers/terminal-handler.js';

let client: PiecesClient | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let isConnected = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
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
			statusBar.text = depth > 0 ? `$(warning) Pieces (${depth} queued)` : '$(warning) Pieces';
			statusBar.tooltip = 'PiecesOS disconnected';
			statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
		statusBar.show();
	}

	/**
	 * Single send/queue path shared by every handler. Reads the live `client`
	 * each call so reconnects are picked up, and falls back to the queue on
	 * disconnect or a failed post.
	 */
	const emit: EmitFn = (event, label) => {
		if (isConnected && client) {
			void client
				.postEvent(event as Record<string, unknown>)
				.then((id) => {
					if (id === null) {
						isConnected = false;
						queue.enqueue(event);
						updateStatus();
					} else {
						log(label);
					}
				})
				.catch((err) => {
					isConnected = false;
					queue.enqueue(event);
					updateStatus();
					log(`emit failed: ${err}`);
				});
		} else {
			queue.enqueue(event);
			updateStatus();
		}
	};

	async function connect(): Promise<void> {
		try {
			const port = await discoverPort(portOverride ? { portOverride } : undefined);

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
		} catch (err) {
			isConnected = false;
			output.appendLine(`PiecesOS connection attempt failed: ${err}`);
			updateStatus();
		}
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

	context.subscriptions.push(
		new vscode.Disposable(() => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
		}),
	);

	// Register handlers unconditionally. They route through `emit`, which queues
	// events until a connection is established — so capture works even when
	// PiecesOS is offline at startup and only comes up later.
	context.subscriptions.push(
		...registerFileHandler(emit),
		...registerTabHandler(emit, checkInMs),
		...registerDebugHandler(emit),
	);

	if (config.get<boolean>('enableClipboardCapture', true)) {
		context.subscriptions.push(...registerClipboardHandler(emit));
	}

	if (config.get<boolean>('enableGitEvents', true)) {
		context.subscriptions.push(...(await registerGitHandler(emit, log)));
	}

	if (config.get<boolean>('enableTerminalEvents', true)) {
		context.subscriptions.push(...registerTerminalHandler(emit));
	}

	if (config.get<boolean>('enableClaudeCodeIntegration', true)) {
		context.subscriptions.push(...registerClaudeCodeHandler(emit, log));
	}

	updateStatus();
}

export function deactivate(): void {
	if (heartbeatTimer) clearInterval(heartbeatTimer);
}
