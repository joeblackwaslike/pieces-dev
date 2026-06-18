export type ConnectionState = 'connected' | 'disconnected' | 'auth-failed';

/**
 * Anchor classification accepted by PiecesOS `SeededAnchor.type`.
 * The SDK marks `type` as required on every anchor.
 */
export type AnchorType = 'FILE' | 'DIRECTORY' | 'UNKNOWN';

/**
 * Canonical application descriptor. Defined once here and reused by
 * `app-registry` and `event-builder` so the shape cannot drift. Identity
 * fields are required; the PiecesOS metadata fields are optional so callers
 * can build minimal apps (the registry constants still supply them all).
 */
export type Application = {
	id: string;
	name: string;
	version: string;
	platform: 'MACOS' | 'WINDOWS' | 'LINUX';
	onboarded?: boolean;
	privacy?: 'OPEN' | 'PRIVATE';
	capabilities?: 'BLENDED' | 'LOCAL' | 'CLOUD';
	mechanism?: 'MANUAL' | 'INTERNAL';
	automaticUnload?: boolean;
};

type IdeAnchor = { fullpath: string; type: AnchorType };

/**
 * Simplified payload accepted by `POST /workstream_events/create`. This is a
 * deliberate subset of the SDK `SeededWorkstreamEvent` covering only the
 * fields the event builders populate. Defined once here rather than re-declared
 * per builder module.
 */
export type WorkstreamEventInput = {
	application: Application;
	trigger: Partial<Record<TriggerKey, true>>;
	readable?: string;
	context?: {
		ide?: {
			tabs?: {
				iterable: Array<{
					anchor: IdeAnchor;
					current?: boolean;
					classification?: { specific: string };
				}>;
			};
			modules?: { iterable: Array<{ anchor: IdeAnchor }> };
			name?: string;
		};
		browser?: {
			tabs?: { iterable: Array<{ anchor: { fullpath: string }; current?: boolean }> };
		};
		native_clipboard?: { text: string };
	};
};

export type TriggerKey =
	| 'file_open'
	| 'file_close'
	| 'tab_open'
	| 'tab_close'
	| 'tab_enter'
	| 'tab_leave'
	| 'tab_switch'
	| 'application_enter'
	| 'application_leave'
	| 'application_switch'
	| 'check_in'
	| 'copy'
	| 'paste'
	| 'url_changed'
	| 'native_screenshot';

export type SourceName = 'claude' | 'screentime' | 'arc' | 'git';

export type SourceEvent = {
	timestamp: Date;
	/** The payload our event builders produce and post to PiecesOS. */
	event: WorkstreamEventInput;
	source: SourceName;
	dedupKey: string;
};
