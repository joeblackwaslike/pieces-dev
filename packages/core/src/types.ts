import type * as Pieces from '@pieces.app/pieces-os-client';

export type { Pieces };

export type ConnectionState = 'connected' | 'disconnected' | 'auth-failed';

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
  event: Pieces.SeededWorkstreamEvent;
  source: SourceName;
  dedupKey: string;
};
