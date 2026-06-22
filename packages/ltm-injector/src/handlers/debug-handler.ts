import { appEnterEvent, appLeaveEvent, VSCODE_APP } from '@pieces-dev/core';
import * as vscode from 'vscode';
import type { EmitFn } from '../emit.js';

export function registerDebugHandler(emit: EmitFn): vscode.Disposable[] {
	const onStart = vscode.debug.onDidStartDebugSession((session) => {
		emit(
			appEnterEvent(VSCODE_APP, `Debug: ${session.name} (${session.type})`),
			`debug: started ${session.name}`,
		);
	});

	const onEnd = vscode.debug.onDidTerminateDebugSession((session) => {
		emit(appLeaveEvent(VSCODE_APP, `Debug ended: ${session.name}`), `debug: ended ${session.name}`);
	});

	return [onStart, onEnd];
}
