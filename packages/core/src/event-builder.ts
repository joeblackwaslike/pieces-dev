import { basename } from 'node:path';

type Application = {
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

type SeededWorkstreamEvent = {
  application: Application;
  trigger: Record<string, boolean>;
  readable?: string;
  context?: {
    ide?: {
      tabs?: { iterable: Array<{ anchor: { fullpath: string }; current?: boolean; classification?: { specific: string } }> };
      modules?: { iterable: Array<{ anchor: { fullpath: string } }> };
      name?: string;
    };
    browser?: {
      tabs?: { iterable: Array<{ anchor: { fullpath: string }; current?: boolean }> };
    };
    native_clipboard?: { text: string };
  };
};

const CLIPBOARD_MAX_LENGTH = 500;

function ideContext(
  filePath: string,
  language?: string,
  repoRoot?: string,
): SeededWorkstreamEvent['context'] {
  const tab: Record<string, unknown> = {
    anchor: { fullpath: filePath },
    current: true,
  };
  if (language) {
    tab.classification = { specific: language };
  }

  const ctx: NonNullable<SeededWorkstreamEvent['context']> = {
    ide: {
      tabs: { iterable: [tab as { anchor: { fullpath: string }; current: boolean }] },
    },
  };

  if (repoRoot) {
    ctx.ide!.modules = { iterable: [{ anchor: { fullpath: repoRoot } }] };
  }

  return ctx;
}

export function fileOpenEvent(
  app: Application,
  filePath: string,
  language?: string,
  repoRoot?: string,
): SeededWorkstreamEvent {
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
): SeededWorkstreamEvent {
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
): SeededWorkstreamEvent {
  return {
    application: app,
    trigger: { tab_switch: true },
    context: ideContext(filePath, language, repoRoot),
    readable: `Switched to ${basename(filePath)}${repoRoot ? ` in ${basename(repoRoot)}` : ''}`,
  };
}

export function checkInEvent(
  app: Application,
  readable?: string,
): SeededWorkstreamEvent {
  return {
    application: app,
    trigger: { check_in: true },
    readable,
  };
}

export function appEnterEvent(
  app: Application,
  readable?: string,
): SeededWorkstreamEvent {
  return {
    application: app,
    trigger: { application_enter: true },
    readable,
  };
}

export function appLeaveEvent(
  app: Application,
  readable?: string,
): SeededWorkstreamEvent {
  return {
    application: app,
    trigger: { application_leave: true },
    readable,
  };
}

export function urlChangedEvent(
  app: Application,
  url: string,
  title?: string,
): SeededWorkstreamEvent {
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
    readable: title ? `Browsing: ${title}` : `Visited: ${new URL(url).hostname}`,
  };
}

export function copyEvent(
  app: Application,
  text: string,
): SeededWorkstreamEvent {
  return {
    application: app,
    trigger: { copy: true },
    context: {
      native_clipboard: {
        text: text.slice(0, CLIPBOARD_MAX_LENGTH),
      },
    },
    readable: `Copied ${text.slice(0, 50)}${text.length > 50 ? '…' : ''}`,
  };
}
