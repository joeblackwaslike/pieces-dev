import { describe, expect, it } from 'vitest';
import {
  appEnterEvent,
  appLeaveEvent,
  checkInEvent,
  copyEvent,
  fileCloseEvent,
  fileOpenEvent,
  tabSwitchEvent,
  urlChangedEvent,
} from '../event-builder.js';

const APP = {
  id: '24e066ee-81aa-4054-ba7a-74697135b086',
  name: 'VS_CODE',
  version: '3.0.1',
  platform: 'MACOS' as const,
  onboarded: false,
  privacy: 'OPEN' as const,
  capabilities: 'BLENDED' as const,
  mechanism: 'MANUAL' as const,
  automaticUnload: false,
};

describe('event-builder', () => {
  it('fileOpenEvent sets trigger and IDE context', () => {
    const evt = fileOpenEvent(APP, '/repo/src/index.ts', 'typescript', '/repo');
    expect(evt.trigger).toEqual({ file_open: true });
    expect(evt.context?.ide?.tabs?.iterable[0]?.anchor.fullpath).toBe('/repo/src/index.ts');
    expect(evt.context?.ide?.modules?.iterable[0]?.anchor.fullpath).toBe('/repo');
    expect(evt.readable).toContain('index.ts');
  });

  it('fileCloseEvent sets file_close trigger', () => {
    const evt = fileCloseEvent(APP, '/repo/src/index.ts');
    expect(evt.trigger).toEqual({ file_close: true });
  });

  it('tabSwitchEvent sets tab_switch trigger', () => {
    const evt = tabSwitchEvent(APP, '/repo/src/app.ts', 'typescript', '/repo');
    expect(evt.trigger).toEqual({ tab_switch: true });
  });

  it('checkInEvent sets check_in trigger', () => {
    const evt = checkInEvent(APP, 'Heartbeat');
    expect(evt.trigger).toEqual({ check_in: true });
    expect(evt.readable).toBe('Heartbeat');
  });

  it('appEnterEvent sets application_enter trigger', () => {
    const evt = appEnterEvent(APP, 'VS Code focused');
    expect(evt.trigger).toEqual({ application_enter: true });
  });

  it('appLeaveEvent sets application_leave trigger', () => {
    const evt = appLeaveEvent(APP, 'VS Code backgrounded');
    expect(evt.trigger).toEqual({ application_leave: true });
  });

  it('urlChangedEvent sets url_changed and browser context', () => {
    const evt = urlChangedEvent(APP, 'https://github.com/pieces-app', 'Pieces App');
    expect(evt.trigger).toEqual({ url_changed: true });
    expect(evt.context?.browser?.tabs?.iterable[0]?.anchor.fullpath).toBe(
      'https://github.com/pieces-app',
    );
  });

  it('copyEvent sets copy trigger and clipboard context', () => {
    const evt = copyEvent(APP, 'const x = 42;');
    expect(evt.trigger).toEqual({ copy: true });
    expect(evt.context?.native_clipboard?.text).toBe('const x = 42;');
  });

  it('copyEvent truncates text longer than 500 chars', () => {
    const longText = 'a'.repeat(600);
    const evt = copyEvent(APP, longText);
    expect(evt.context?.native_clipboard?.text.length).toBe(500);
  });
});
