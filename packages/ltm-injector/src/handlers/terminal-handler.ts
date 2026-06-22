import { checkInEvent, VSCODE_APP } from '@pieces-dev/core';
import * as vscode from 'vscode';
import type { EmitFn } from '../emit.js';

/**
 * Captures terminal *lifecycle* (open/close) only — never terminal contents.
 *
 * The previous implementation read raw terminal output via the proposed
 * `onDidWriteTerminalData` API, which (a) isn't available in stable VS Code and
 * (b) captured passwords, tokens, and other secrets printed to the terminal —
 * a blocker for marketplace publishing. Lifecycle events carry no sensitive
 * data and use only stable APIs.
 */
export function registerTerminalHandler(emit: EmitFn): vscode.Disposable[] {
	const onOpen = vscode.window.onDidOpenTerminal((terminal) => {
		emit(
			checkInEvent(VSCODE_APP, `Opened terminal: ${terminal.name}`),
			`terminal_open: ${terminal.name}`,
		);
	});

	const onClose = vscode.window.onDidCloseTerminal((terminal) => {
		emit(
			checkInEvent(VSCODE_APP, `Closed terminal: ${terminal.name}`),
			`terminal_close: ${terminal.name}`,
		);
	});

	return [onOpen, onClose];
}
