import { copyEvent, VSCODE_APP } from '@pieces-dev/core';
import * as vscode from 'vscode';
import type { EmitFn } from '../emit.js';

export function registerClipboardHandler(emit: EmitFn): vscode.Disposable[] {
	const cmd = vscode.commands.registerCommand('pieces-ltm-injector.clipboardCopy', async () => {
		// Run the real copy first so the user's copy always works, then
		// capture what landed on the clipboard.
		await vscode.commands.executeCommand('editor.action.clipboardCopyAction');

		const text = await vscode.env.clipboard.readText();
		if (!text) return;

		emit(copyEvent(VSCODE_APP, text), `copy: ${text.slice(0, 50)}`);
	});

	return [cmd];
}
