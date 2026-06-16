import {
	appEnterEvent,
	appLeaveEvent,
	checkInEvent,
	tabSwitchEvent,
	VSCODE_APP,
} from '@pieces-dev/core';
import * as vscode from 'vscode';
import type { EmitFn } from '../emit.js';

export function registerTabHandler(emit: EmitFn, checkInIntervalMs: number): vscode.Disposable[] {
	let checkInTimer: ReturnType<typeof setInterval> | undefined;

	function startCheckIn(): void {
		stopCheckIn();
		checkInTimer = setInterval(() => {
			emit(checkInEvent(VSCODE_APP, 'VS Code active'), 'check_in: heartbeat');
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
		emit(
			tabSwitchEvent(VSCODE_APP, doc.uri.fsPath, doc.languageId, folder?.uri.fsPath),
			`tab_switch: ${doc.uri.fsPath}`,
		);
	});

	const onFocus = vscode.window.onDidChangeWindowState((state) => {
		if (state.focused) {
			emit(appEnterEvent(VSCODE_APP, 'VS Code focused'), 'application_enter');
			startCheckIn();
		} else {
			emit(appLeaveEvent(VSCODE_APP, 'VS Code backgrounded'), 'application_leave');
			stopCheckIn();
		}
	});

	if (vscode.window.state.focused) {
		startCheckIn();
	}

	const dispose = new vscode.Disposable(() => stopCheckIn());
	return [onTabSwitch, onFocus, dispose];
}
