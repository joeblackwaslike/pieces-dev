import { basename } from 'node:path';
import type { Application, WorkstreamEventInput } from './types.js';

const CLIPBOARD_MAX_LENGTH = 500;
const READABLE_MAX_LENGTH = 50;

function ideContext(
	filePath: string,
	language?: string,
	repoRoot?: string,
): WorkstreamEventInput['context'] {
	const ide: NonNullable<NonNullable<WorkstreamEventInput['context']>['ide']> = {
		tabs: {
			iterable: [
				{
					anchor: { fullpath: filePath, type: 'FILE' },
					current: true,
					...(language ? { classification: { specific: language } } : {}),
				},
			],
		},
	};

	if (repoRoot) {
		ide.modules = {
			iterable: [{ anchor: { fullpath: repoRoot, type: 'DIRECTORY' } }],
		};
	}

	return { ide };
}

export function fileOpenEvent(
	app: Application,
	filePath: string,
	language?: string,
	repoRoot?: string,
): WorkstreamEventInput {
	return {
		application: app,
		trigger: { file_open: true },
		context: ideContext(filePath, language, repoRoot),
		readable: `Opened ${basename(filePath)}${repoRoot ? ` in ${basename(repoRoot)}` : ''}`,
	};
}

export function fileCloseEvent(
	app: Application,
	filePath: string,
	language?: string,
	repoRoot?: string,
): WorkstreamEventInput {
	return {
		application: app,
		trigger: { file_close: true },
		context: ideContext(filePath, language, repoRoot),
		readable: `Closed ${basename(filePath)}`,
	};
}

export function tabSwitchEvent(
	app: Application,
	filePath: string,
	language?: string,
	repoRoot?: string,
): WorkstreamEventInput {
	return {
		application: app,
		trigger: { tab_switch: true },
		context: ideContext(filePath, language, repoRoot),
		readable: `Switched to ${basename(filePath)}${repoRoot ? ` in ${basename(repoRoot)}` : ''}`,
	};
}

export function checkInEvent(app: Application, readable?: string): WorkstreamEventInput {
	return {
		application: app,
		trigger: { check_in: true },
		readable,
	};
}

export function appEnterEvent(app: Application, readable?: string): WorkstreamEventInput {
	return {
		application: app,
		trigger: { application_enter: true },
		readable,
	};
}

export function appLeaveEvent(app: Application, readable?: string): WorkstreamEventInput {
	return {
		application: app,
		trigger: { application_leave: true },
		readable,
	};
}

/**
 * Extract a hostname for the `readable` label without throwing. `new URL()`
 * raises a TypeError on relative, internal (`about:blank`,
 * `chrome-extension://…`), or otherwise malformed URLs — falling back to the
 * raw string keeps a single bad URL from failing event creation.
 */
function safeHostname(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

export function urlChangedEvent(
	app: Application,
	url: string,
	title?: string,
): WorkstreamEventInput {
	return {
		application: app,
		trigger: { url_changed: true },
		context: {
			browser: {
				tabs: {
					iterable: [{ anchor: { fullpath: url }, current: true }],
				},
			},
		},
		readable: title ? `Browsing: ${title}` : `Visited: ${safeHostname(url)}`,
	};
}

export function copyEvent(app: Application, text: string): WorkstreamEventInput {
	return {
		application: app,
		trigger: { copy: true },
		context: {
			native_clipboard: {
				text: text.slice(0, CLIPBOARD_MAX_LENGTH),
			},
		},
		readable: `Copied ${text.slice(0, READABLE_MAX_LENGTH)}${text.length > READABLE_MAX_LENGTH ? '…' : ''}`,
	};
}
