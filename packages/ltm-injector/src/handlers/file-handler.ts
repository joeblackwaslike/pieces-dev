import { fileCloseEvent, fileOpenEvent, VSCODE_APP } from '@pieces-dev/core';
import * as vscode from 'vscode';
import type { EmitFn } from '../emit.js';

const DEBOUNCE_MS = 2000;
const SKIP_SCHEMES = new Set(['untitled', 'output', 'vscode', 'git', 'debug']);

export function registerFileHandler(emit: EmitFn): vscode.Disposable[] {
	const recentOpens = new Map<string, number>();

	const onOpen = vscode.workspace.onDidOpenTextDocument((doc) => {
		if (SKIP_SCHEMES.has(doc.uri.scheme)) return;

		const path = doc.uri.fsPath;
		const now = Date.now();
		const last = recentOpens.get(path);
		if (last && now - last < DEBOUNCE_MS) return;
		recentOpens.set(path, now);

		const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
		emit(fileOpenEvent(VSCODE_APP, path, doc.languageId, folder?.uri.fsPath), `file_open: ${path}`);
	});

	const onClose = vscode.workspace.onDidCloseTextDocument((doc) => {
		if (SKIP_SCHEMES.has(doc.uri.scheme)) return;

		const path = doc.uri.fsPath;
		const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
		emit(
			fileCloseEvent(VSCODE_APP, path, doc.languageId, folder?.uri.fsPath),
			`file_close: ${path}`,
		);
	});

	return [onOpen, onClose];
}
