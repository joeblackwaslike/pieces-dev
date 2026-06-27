# PiecesOS LTM Injector + Gap Reconstructor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two packages in the `pieces-dev` monorepo — a VS Code extension that permanently captures IDE workstream events into PiecesOS LTM, and a reusable CLI tool that backfills gaps in LTM coverage from multiple data sources.

**Architecture:** pnpm monorepo with three packages under `packages/`: `core` (shared PiecesOS client, event builder, port discovery wrapping the official `@pieces.app/pieces-os-client` SDK), `ltm-injector` (VS Code extension), and `gap-reconstruct` (Commander CLI). The official TS SDK provides all API types; `core` adds port discovery (read `~/.port.txt`), event builder factories, and an app registry. Both consumer packages import from `core`.

**Tech Stack:** TypeScript 5.x strict, pnpm workspaces, Node 22+ (built-in fetch), `@pieces.app/pieces-os-client` SDK, esbuild (extension bundling), Commander (CLI), `better-sqlite3` (Screen Time + Arc History), Biome (formatting), Vitest (testing), `@vscode/test-electron` (extension integration tests).

**Key API facts:**
- PiecesOS REST API runs on dynamic port 39300–39333, stored in `~/Library/com.pieces.os/production/Config/.port.txt`
- Port 1000 does NOT respond on this install — always use the dynamic port
- `POST /workstream_events/create` accepts `SeededWorkstreamEvent` directly (no wrapper)
- `POST /workstream_events/{id}/delete` uses POST method (not DELETE), returns 204
- Trigger fields are snake_case (`file_open`), application fields are camelCase (`automaticUnload`)

**Design spec:** `docs/superpowers/specs/2026-06-04-piecesos-ltm-injector-design.md`

---

## Task 1: Monorepo Scaffolding

**Files:**
- Create: `package.json` (workspace root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `.gitignore`
- Create: `CLAUDE.md`

- [ ] **Step 1: Initialize git repo**

```bash
cd /Users/joe/github/joeblackwaslike/pieces-dev
git init
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "pieces-dev",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.12.1",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "biome check .",
    "format": "biome check --write ."
  }
}
```

- [ ] **Step 3: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false
  }
}
```

- [ ] **Step 5: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all"
    }
  }
}
```

- [ ] **Step 6: Create `.gitignore`**

```gitignore
node_modules/
dist/
out/
*.vsix
.vscode-test/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 7: Create `CLAUDE.md`**

```markdown
# pieces-dev

pnpm monorepo for PiecesOS developer tools.

## Packages

- `packages/core` — shared PiecesOS client, event builder, port discovery
- `packages/ltm-injector` — VS Code extension for IDE workstream event capture
- `packages/gap-reconstruct` — CLI tool to backfill LTM gaps from multiple sources

## Commands

- `pnpm install` — install all dependencies
- `pnpm build` — build all packages
- `pnpm test` — run all tests
- `pnpm lint` — check formatting and lint rules
- `pnpm format` — auto-fix formatting

## Conventions

- TypeScript strict mode, ESM only
- Node 22+ (built-in fetch, no polyfills)
- Biome for formatting (not Prettier)
- Vitest for testing
- No `any` — use `unknown` + narrowing
- No barrel files except package entry points
```

- [ ] **Step 8: Copy gap analysis reference script**

```bash
mkdir -p tools
cp ~/Library/Logs/PiecesOS/gap_analysis.py tools/gap_analysis.py
```

- [ ] **Step 9: Install pnpm and initialize**

```bash
pnpm install
```

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json biome.json .gitignore CLAUDE.md tools/gap_analysis.py
git commit -m "chore: scaffold pnpm monorepo"
```

---

## Task 2: `@pieces-dev/core` — Package Setup + Types

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/types.ts`

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@pieces-dev/core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@pieces.app/pieces-os-client": "^4.1.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/core/src/types.ts`**

This file re-exports key types from the official SDK and defines thin helpers for our specific use cases. The SDK types use the naming conventions from the OpenAPI spec.

```typescript
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
```

- [ ] **Step 4: Create `packages/core/src/index.ts`**

```typescript
export * from './types.js';
```

Note: This is the barrel entry point for the package. Additional modules will be added to exports as they are built.

- [ ] **Step 5: Run build to verify types compile**

```bash
cd /Users/joe/github/joeblackwaslike/pieces-dev
pnpm install
pnpm --filter @pieces-dev/core build
```

Expected: Build succeeds with no errors. If the SDK types don't export `SeededWorkstreamEvent` by that exact name, check the SDK's actual exports and adjust the import.

- [ ] **Step 6: Commit**

```bash
git add packages/core/
git commit -m "feat(core): scaffold package with SDK type re-exports"
```

---

## Task 3: `@pieces-dev/core` — Port Discovery

**Files:**
- Create: `packages/core/src/port-discovery.ts`
- Create: `packages/core/src/__tests__/port-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { discoverPort } from '../port-discovery.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

describe('discoverPort', () => {
  it('reads port from .port.txt file', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('39312\n');

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('ok:uuid') });
    vi.stubGlobal('fetch', mockFetch);

    const port = await discoverPort();
    expect(port).toBe(39312);

    vi.unstubAllGlobals();
  });

  it('returns override port without reading file', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('ok:uuid') });
    vi.stubGlobal('fetch', mockFetch);

    const port = await discoverPort({ portOverride: 39300 });
    expect(port).toBe(39300);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:39300/.well-known/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    vi.unstubAllGlobals();
  });

  it('returns null when file missing and health check fails', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const port = await discoverPort();
    expect(port).toBeNull();

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/port-discovery.test.ts
```

Expected: FAIL — `discoverPort` does not exist.

- [ ] **Step 3: Implement port discovery**

```typescript
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT_FILE_PATH = join(
  homedir(),
  'Library/com.pieces.os/production/Config/.port.txt',
);
const HEALTH_TIMEOUT_MS = 2000;
const PORT_RANGE_START = 39300;
const PORT_RANGE_END = 39333;

export type PortDiscoveryOptions = {
  portOverride?: number;
};

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/.well-known/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function discoverPort(
  options?: PortDiscoveryOptions,
): Promise<number | null> {
  if (options?.portOverride) {
    const healthy = await checkHealth(options.portOverride);
    return healthy ? options.portOverride : null;
  }

  try {
    const content = await readFile(PORT_FILE_PATH, 'utf-8');
    const port = Number.parseInt(content.trim(), 10);
    if (!Number.isNaN(port) && (await checkHealth(port))) {
      return port;
    }
  } catch {
    // .port.txt missing or unreadable — fall through to probe
  }

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await checkHealth(port)) {
      return port;
    }
  }

  return null;
}
```

- [ ] **Step 4: Add export to `index.ts`**

Add this line to `packages/core/src/index.ts`:

```typescript
export { discoverPort, type PortDiscoveryOptions } from './port-discovery.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/port-discovery.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/port-discovery.ts packages/core/src/__tests__/port-discovery.test.ts packages/core/src/index.ts
git commit -m "feat(core): add port discovery — reads .port.txt with probe fallback"
```

---

## Task 4: `@pieces-dev/core` — PiecesClient

**Files:**
- Create: `packages/core/src/client.ts`
- Create: `packages/core/src/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiecesClient } from '../client.js';

describe('PiecesClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('postEvent sends SeededWorkstreamEvent and returns event id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'evt-123' }),
    });

    const client = new PiecesClient(39312);
    const id = await client.postEvent({
      application: { id: 'app-1', name: 'VS_CODE', version: '1.0', platform: 'MACOS' },
      trigger: { check_in: true },
      readable: 'test',
    });

    expect(id).toBe('evt-123');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:39312/workstream_events/create',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('postEvent returns null on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new PiecesClient(39312);
    const id = await client.postEvent({
      application: { id: 'app-1', name: 'VS_CODE', version: '1.0', platform: 'MACOS' },
      trigger: { check_in: true },
    });

    expect(id).toBeNull();
  });

  it('deleteEvent posts to correct URL and returns true on 204', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204 });

    const client = new PiecesClient(39312);
    const result = await client.deleteEvent('evt-123');

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:39312/workstream_events/evt-123/delete',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('triggerSummary sends time range', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    const client = new PiecesClient(39312);
    const from = new Date('2026-05-27T00:00:00Z');
    const to = new Date('2026-05-27T23:59:59Z');
    const result = await client.triggerSummary(from, to);

    expect(result).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty('anonymous_ranges');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/client.test.ts
```

Expected: FAIL — `PiecesClient` does not exist.

- [ ] **Step 3: Implement PiecesClient**

```typescript
const POST_TIMEOUT_MS = 3000;

export class PiecesClient {
  private readonly baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://localhost:${port}`;
  }

  async postEvent(event: Record<string, unknown>): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/workstream_events/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { id?: string };
      return data.id ?? null;
    } catch {
      return null;
    }
  }

  async deleteEvent(id: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/workstream_events/${id}/delete`, {
        method: 'POST',
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getEvents(): Promise<unknown[]> {
    try {
      const res = await fetch(`${this.baseUrl}/workstream_events`, {
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { iterable?: unknown[] };
      return data.iterable ?? [];
    } catch {
      return [];
    }
  }

  async triggerSummary(from: Date, to: Date): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/workstream_summaries/create/summary`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            anonymous_ranges: [
              {
                from: from.toISOString(),
                to: to.toISOString(),
                between: true,
              },
            ],
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/.well-known/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Add export to `index.ts`**

Add to `packages/core/src/index.ts`:

```typescript
export { PiecesClient } from './client.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/client.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/client.ts packages/core/src/__tests__/client.test.ts packages/core/src/index.ts
git commit -m "feat(core): add PiecesClient — event CRUD, summary trigger, health check"
```

---

## Task 5: `@pieces-dev/core` — Event Builder

**Files:**
- Create: `packages/core/src/event-builder.ts`
- Create: `packages/core/src/__tests__/event-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/event-builder.test.ts
```

Expected: FAIL — functions not found.

- [ ] **Step 3: Implement event builder**

```typescript
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
```

- [ ] **Step 4: Add export to `index.ts`**

Add to `packages/core/src/index.ts`:

```typescript
export {
  fileOpenEvent,
  fileCloseEvent,
  tabSwitchEvent,
  checkInEvent,
  appEnterEvent,
  appLeaveEvent,
  urlChangedEvent,
  copyEvent,
} from './event-builder.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/event-builder.test.ts
```

Expected: All 9 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/event-builder.ts packages/core/src/__tests__/event-builder.test.ts packages/core/src/index.ts
git commit -m "feat(core): add event builder factories for all workstream trigger types"
```

---

## Task 6: `@pieces-dev/core` — App Registry

**Files:**
- Create: `packages/core/src/app-registry.ts`
- Create: `packages/core/src/__tests__/app-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { VSCODE_APP, OS_SERVER_APP, getAppDisplayName } from '../app-registry.js';

describe('app-registry', () => {
  it('exports VS_CODE application with known ID', () => {
    expect(VSCODE_APP.id).toBe('24e066ee-81aa-4054-ba7a-74697135b086');
    expect(VSCODE_APP.name).toBe('VS_CODE');
    expect(VSCODE_APP.platform).toBe('MACOS');
  });

  it('exports OS_SERVER application with known ID', () => {
    expect(OS_SERVER_APP.id).toBe('B960C645-A6CC-4654-932C-C38EBA6F54A6');
    expect(OS_SERVER_APP.name).toBe('OS_SERVER');
  });

  it('maps known bundle IDs to display names', () => {
    expect(getAppDisplayName('com.microsoft.VSCodeInsiders')).toBe('VS Code Insiders');
    expect(getAppDisplayName('company.thebrowser.Browser')).toBe('Arc Browser');
    expect(getAppDisplayName('md.obsidian')).toBe('Obsidian');
  });

  it('returns bundle ID for unknown apps', () => {
    expect(getAppDisplayName('com.unknown.app')).toBe('com.unknown.app');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/app-registry.test.ts
```

Expected: FAIL — exports not found.

- [ ] **Step 3: Implement app registry**

```typescript
type Application = {
  id: string;
  name: string;
  version: string;
  platform: 'MACOS' | 'WINDOWS' | 'LINUX';
  onboarded: boolean;
  privacy: 'OPEN' | 'PRIVATE';
  capabilities: 'BLENDED' | 'LOCAL' | 'CLOUD';
  mechanism: 'MANUAL' | 'INTERNAL';
  automaticUnload: boolean;
};

export const VSCODE_APP: Application = {
  id: '24e066ee-81aa-4054-ba7a-74697135b086',
  name: 'VS_CODE',
  version: '3.0.1',
  platform: 'MACOS',
  onboarded: false,
  privacy: 'OPEN',
  capabilities: 'BLENDED',
  mechanism: 'MANUAL',
  automaticUnload: false,
};

export const OS_SERVER_APP: Application = {
  id: 'B960C645-A6CC-4654-932C-C38EBA6F54A6',
  name: 'OS_SERVER',
  version: '1.0.0',
  platform: 'MACOS',
  onboarded: false,
  privacy: 'OPEN',
  capabilities: 'BLENDED',
  mechanism: 'MANUAL',
  automaticUnload: false,
};

const BUNDLE_ID_DISPLAY_NAMES: Record<string, string> = {
  'com.microsoft.VSCodeInsiders': 'VS Code Insiders',
  'com.microsoft.VSCode': 'VS Code',
  'company.thebrowser.Browser': 'Arc Browser',
  'md.obsidian': 'Obsidian',
  'com.anthropic.claudefordesktop': 'Claude Desktop',
  'com.hnc.Discord': 'Discord',
  'com.google.Chrome': 'Chrome',
  'dev.warp.Warp-Stable': 'Warp Terminal',
  'com.openai.codex': 'ChatGPT',
  'com.apple.mail': 'Apple Mail',
  'com.apple.Safari': 'Safari',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.apple.Terminal': 'Terminal',
  'com.github.wez.wezterm': 'WezTerm',
  'com.googlecode.iterm2': 'iTerm2',
};

export function getAppDisplayName(bundleId: string): string {
  return BUNDLE_ID_DISPLAY_NAMES[bundleId] ?? bundleId;
}
```

- [ ] **Step 4: Add export to `index.ts`**

Add to `packages/core/src/index.ts`:

```typescript
export { VSCODE_APP, OS_SERVER_APP, getAppDisplayName } from './app-registry.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/app-registry.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 6: Run full core test suite**

```bash
pnpm --filter @pieces-dev/core test
```

Expected: All tests across all 3 test files PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/app-registry.ts packages/core/src/__tests__/app-registry.test.ts packages/core/src/index.ts
git commit -m "feat(core): add app registry with pre-registered IDs and bundle ID mapping"
```

---

## Task 7: `@pieces-dev/core` — Integration Test

**Files:**
- Create: `packages/core/src/__tests__/integration.test.ts`

This test hits the real PiecesOS instance. It should be skipped in CI (or when PiecesOS is not running).

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, expect, it } from 'vitest';
import { discoverPort } from '../port-discovery.js';
import { PiecesClient } from '../client.js';
import { checkInEvent } from '../event-builder.js';
import { VSCODE_APP } from '../app-registry.js';

describe('integration: PiecesOS', () => {
  it('discovers port, posts event, verifies, deletes', async () => {
    const port = await discoverPort();
    if (!port) {
      console.log('PiecesOS not running — skipping integration test');
      return;
    }

    const client = new PiecesClient(port);

    const healthy = await client.checkHealth();
    expect(healthy).toBe(true);

    const event = checkInEvent(VSCODE_APP, 'Integration test — safe to delete');
    const eventId = await client.postEvent(event);
    expect(eventId).toBeTruthy();

    const deleted = await client.deleteEvent(eventId!);
    expect(deleted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
pnpm --filter @pieces-dev/core test -- src/__tests__/integration.test.ts
```

Expected: PASS if PiecesOS is running. The test creates one event and immediately deletes it.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/integration.test.ts
git commit -m "test(core): add integration test — posts and deletes a real event"
```

---

## Task 8: `@pieces-dev/gap-reconstruct` — Package Setup + CLI Skeleton

**Files:**
- Create: `packages/gap-reconstruct/package.json`
- Create: `packages/gap-reconstruct/tsconfig.json`
- Create: `packages/gap-reconstruct/src/cli.ts`
- Create: `packages/gap-reconstruct/src/pipeline.ts`

- [ ] **Step 1: Create `packages/gap-reconstruct/package.json`**

```json
{
  "name": "@pieces-dev/gap-reconstruct",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "gap-reconstruct": "dist/cli.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "start": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@pieces-dev/core": "workspace:*",
    "commander": "^13.0.0",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "typescript": "^5.8.0",
    "tsx": "^4.19.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: Create `packages/gap-reconstruct/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/gap-reconstruct/src/cli.ts`**

Uses subcommands: `detect` (find gaps), `run` (backfill a specific gap), `run --all-gaps` (detect + backfill all).

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { runPipeline } from './pipeline.js';
import { detectGaps } from './gap-detector.js';

const program = new Command();

program
  .name('gap-reconstruct')
  .description('Detect and backfill PiecesOS LTM gaps from multiple data sources')
  .version('0.1.0');

program
  .command('detect')
  .description('Scan PiecesOS events to find gaps in LTM coverage')
  .option('--min-gap <minutes>', 'Minimum gap duration to report (minutes)', Number.parseInt, 60)
  .option('--since <iso>', 'How far back to scan (ISO 8601 or relative like "30d")')
  .action(async (opts) => {
    const minGapMs = (opts.minGap as number) * 60 * 1000;
    const since = opts.since ? parseSince(opts.since as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const gaps = await detectGaps(since, new Date(), minGapMs);

    if (gaps.length === 0) {
      console.log('No gaps found.');
      return;
    }

    console.log(`Found ${gaps.length} gap(s):\n`);
    for (const gap of gaps) {
      const durationH = Math.round((gap.to.getTime() - gap.from.getTime()) / (1000 * 60 * 60) * 10) / 10;
      console.log(`  ${gap.from.toISOString()} → ${gap.to.toISOString()}  (${durationH}h)`);
    }

    console.log(`\nTo backfill a specific gap:`);
    console.log(`  gap-reconstruct run --from <start> --to <end>`);
    console.log(`\nTo backfill all gaps:`);
    console.log(`  gap-reconstruct run --all-gaps --since ${since.toISOString()}`);
  });

program
  .command('run')
  .description('Backfill a gap period with events from data sources')
  .option('--from <iso>', 'Gap start (ISO 8601)')
  .option('--to <iso>', 'Gap end (ISO 8601)')
  .option('--all-gaps', 'Detect and backfill all gaps', false)
  .option('--since <iso>', 'How far back to scan for --all-gaps (ISO 8601 or relative)', '30d')
  .option('--min-gap <minutes>', 'Minimum gap duration for --all-gaps (minutes)', Number.parseInt, 60)
  .option('--sources <list>', 'Comma-separated sources: claude,screentime,arc,git', 'claude,screentime,arc,git')
  .option('--dry-run', 'Collect and display events without injecting', false)
  .option('--limit <n>', 'Inject only first N events per gap', Number.parseInt)
  .option('--concurrency <n>', 'Parallel injection requests', Number.parseInt, 5)
  .option('--skip-summaries', 'Skip summary generation after injection', false)
  .option('--repos <paths>', 'Comma-separated repo paths for git source')
  .action(async (opts) => {
    const sources = (opts.sources as string).split(',').filter(Boolean);
    const repos = opts.repos ? (opts.repos as string).split(',') : undefined;
    const baseOpts = {
      sources,
      dryRun: opts.dryRun as boolean,
      limit: opts.limit as number | undefined,
      concurrency: opts.concurrency as number,
      skipSummaries: opts.skipSummaries as boolean,
      repos,
    };

    if (opts.allGaps) {
      const since = parseSince(opts.since as string);
      const minGapMs = (opts.minGap as number) * 60 * 1000;
      const gaps = await detectGaps(since, new Date(), minGapMs);

      if (gaps.length === 0) {
        console.log('No gaps found — nothing to backfill.');
        return;
      }

      console.log(`Found ${gaps.length} gap(s) to backfill:\n`);
      for (let i = 0; i < gaps.length; i++) {
        const gap = gaps[i]!;
        console.log(`\n=== Gap ${i + 1}/${gaps.length}: ${gap.from.toISOString()} → ${gap.to.toISOString()} ===\n`);
        await runPipeline({ ...baseOpts, from: gap.from, to: gap.to });
      }
      return;
    }

    if (!opts.from || !opts.to) {
      console.error('Error: --from and --to are required (or use --all-gaps)');
      process.exit(1);
    }

    const from = new Date(opts.from as string);
    const to = new Date(opts.to as string);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      console.error('Error: --from and --to must be valid ISO 8601 dates');
      process.exit(1);
    }

    await runPipeline({ ...baseOpts, from, to });
  });

function parseSince(value: string): Date {
  const match = value.match(/^(\d+)d$/);
  if (match) {
    return new Date(Date.now() - Number.parseInt(match[1]!, 10) * 24 * 60 * 60 * 1000);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    console.error(`Error: invalid date/duration: ${value}`);
    process.exit(1);
  }
  return d;
}

program.parse();
```

- [ ] **Step 4: Create `packages/gap-reconstruct/src/pipeline.ts` (stub)**

```typescript
import type { SourceEvent } from '@pieces-dev/core';

export type PipelineOptions = {
  from: Date;
  to: Date;
  sources: string[];
  dryRun: boolean;
  limit?: number;
  concurrency: number;
  skipSummaries: boolean;
  repos?: string[];
};

export async function runPipeline(options: PipelineOptions): Promise<void> {
  console.log(`Gap window: ${options.from.toISOString()} → ${options.to.toISOString()}`);
  console.log(`Sources: ${options.sources.join(', ')}`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log('Pipeline not yet implemented — source tasks follow.');
}
```

- [ ] **Step 5: Install dependencies and verify build**

```bash
pnpm install
pnpm --filter @pieces-dev/gap-reconstruct build
```

Expected: Build succeeds.

- [ ] **Step 6: Create `packages/gap-reconstruct/src/gap-detector.ts` (stub)**

```typescript
import { PiecesClient, discoverPort } from '@pieces-dev/core';

export type Gap = {
  from: Date;
  to: Date;
};

export async function detectGaps(
  since: Date,
  until: Date,
  minGapMs: number,
): Promise<Gap[]> {
  console.log('Gap detection not yet implemented — see Task 14.');
  return [];
}
```

- [ ] **Step 7: Verify CLI runs**

```bash
pnpm --filter @pieces-dev/gap-reconstruct start -- detect
pnpm --filter @pieces-dev/gap-reconstruct start -- run --from 2026-05-26T00:00:00Z --to 2026-06-04T00:00:00Z --dry-run
```

Expected: `detect` prints "No gaps found" (stub). `run` prints gap window, sources, dry run status.

- [ ] **Step 7: Commit**

```bash
git add packages/gap-reconstruct/
git commit -m "feat(gap-reconstruct): scaffold CLI with Commander and pipeline stub"
```

---

## Task 9: `@pieces-dev/gap-reconstruct` — Source Interface + Claude Code Source

**Files:**
- Create: `packages/gap-reconstruct/src/sources/types.ts`
- Create: `packages/gap-reconstruct/src/sources/claude-code.ts`
- Create: `packages/gap-reconstruct/src/__tests__/claude-code.test.ts`
- Create: `packages/gap-reconstruct/src/__tests__/fixtures/` (test fixtures)

- [ ] **Step 1: Create source interface**

Create `packages/gap-reconstruct/src/sources/types.ts`:

```typescript
import type { SourceEvent } from '@pieces-dev/core';

export type Source = {
  name: string;
  collect(from: Date, to: Date): AsyncIterable<SourceEvent>;
};
```

- [ ] **Step 2: Create test fixture**

Create `packages/gap-reconstruct/src/__tests__/fixtures/test-session.jsonl`:

```jsonl
{"type":"system","timestamp":"2026-05-27T10:00:00Z"}
{"type":"human","timestamp":"2026-05-27T10:01:00Z","content":"Fix the login bug"}
{"type":"assistant","timestamp":"2026-05-27T10:01:30Z","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/joe/project/src/auth.ts"}}]}
{"type":"assistant","timestamp":"2026-05-27T10:02:00Z","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/Users/joe/project/src/auth.ts","old_string":"bad","new_string":"good"}}]}
{"type":"assistant","timestamp":"2026-05-27T10:03:00Z","content":[{"type":"tool_use","name":"Bash","input":{"command":"cd /Users/joe/project && npm test"}}]}
{"type":"human","timestamp":"2026-05-27T10:05:00Z","content":"Looks good, thanks"}
```

- [ ] **Step 3: Write the failing test**

Create `packages/gap-reconstruct/src/__tests__/claude-code.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeSource } from '../sources/claude-code.js';

describe('ClaudeCodeSource', () => {
  it('extracts file events from JSONL session', async () => {
    const source = new ClaudeCodeSource(
      new URL('./fixtures/', import.meta.url).pathname,
    );

    const events: Array<{ timestamp: Date; source: string; dedupKey: string }> = [];
    const from = new Date('2026-05-27T00:00:00Z');
    const to = new Date('2026-05-28T00:00:00Z');

    for await (const evt of source.collect(from, to)) {
      events.push({
        timestamp: evt.timestamp,
        source: evt.source,
        dedupKey: evt.dedupKey,
      });
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.source === 'claude')).toBe(true);
    expect(events.some((e) => e.dedupKey.includes('file_open'))).toBe(true);
  });

  it('skips events outside the time window', async () => {
    const source = new ClaudeCodeSource(
      new URL('./fixtures/', import.meta.url).pathname,
    );

    const events: unknown[] = [];
    const from = new Date('2026-06-01T00:00:00Z');
    const to = new Date('2026-06-02T00:00:00Z');

    for await (const evt of source.collect(from, to)) {
      events.push(evt);
    }

    expect(events.length).toBe(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/claude-code.test.ts
```

Expected: FAIL — `ClaudeCodeSource` does not exist.

- [ ] **Step 5: Implement Claude Code source**

Create `packages/gap-reconstruct/src/sources/claude-code.ts`:

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  type SourceEvent,
  VSCODE_APP,
  OS_SERVER_APP,
  fileOpenEvent,
  checkInEvent,
  appEnterEvent,
  appLeaveEvent,
} from '@pieces-dev/core';
import type { Source } from './types.js';

const CLAUDE_PROJECTS_DIR = join(
  process.env.HOME ?? '',
  '.claude/projects',
);

export class ClaudeCodeSource implements Source {
  readonly name = 'claude';
  private readonly projectsDir: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? CLAUDE_PROJECTS_DIR;
  }

  async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
    const jsonlFiles = await this.findJsonlFiles();

    for (const filePath of jsonlFiles) {
      yield* this.parseSession(filePath, from, to);
    }
  }

  private async findJsonlFiles(): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(this.projectsDir, {
        recursive: true,
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.endsWith('.jsonl') &&
          !entry.parentPath.includes('subagent')
        ) {
          files.push(join(entry.parentPath, entry.name));
        }
      }
    } catch {
      // Directory not found — no Claude Code sessions
    }

    return files;
  }

  private async *parseSession(
    filePath: string,
    from: Date,
    to: Date,
  ): AsyncIterable<SourceEvent> {
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    let sessionStartEmitted = false;
    let lastTimestamp: Date | undefined;
    const repoRoot = this.inferRepoRoot(filePath);

    for await (const line of rl) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const ts = this.extractTimestamp(parsed);
      if (!ts || ts < from || ts > to) continue;

      lastTimestamp = ts;

      if (!sessionStartEmitted && parsed.type === 'human') {
        sessionStartEmitted = true;
        yield {
          timestamp: ts,
          event: appEnterEvent(
            OS_SERVER_APP,
            `Claude Code session in ${repoRoot ? basename(repoRoot) : 'unknown'}`,
          ),
          source: 'claude',
          dedupKey: `application_enter:claude-code:${this.roundTo5s(ts)}`,
        };
      }

      if (parsed.type === 'assistant') {
        yield* this.extractToolUseEvents(parsed, ts, repoRoot);
      }
    }

    if (lastTimestamp && sessionStartEmitted) {
      yield {
        timestamp: lastTimestamp,
        event: appLeaveEvent(OS_SERVER_APP, 'Claude Code session ended'),
        source: 'claude',
        dedupKey: `application_leave:claude-code:${this.roundTo5s(lastTimestamp)}`,
      };
    }
  }

  private *extractToolUseEvents(
    parsed: Record<string, unknown>,
    ts: Date,
    repoRoot: string | undefined,
  ): Iterable<SourceEvent> {
    const content = parsed.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        typeof block !== 'object' ||
        block === null ||
        (block as Record<string, unknown>).type !== 'tool_use'
      ) {
        continue;
      }

      const toolUse = block as { name?: string; input?: Record<string, unknown> };
      const toolName = toolUse.name;
      const input = toolUse.input;

      if (!toolName || !input) continue;

      if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
        const filePath =
          (input.file_path as string | undefined) ??
          (input.path as string | undefined);
        if (filePath) {
          yield {
            timestamp: ts,
            event: fileOpenEvent(OS_SERVER_APP, filePath, undefined, repoRoot),
            source: 'claude',
            dedupKey: `file_open:${filePath}:${this.roundTo5s(ts)}`,
          };
        }
      }

      if (toolName === 'Bash') {
        const cmd = input.command as string | undefined;
        if (cmd) {
          yield {
            timestamp: ts,
            event: checkInEvent(
              OS_SERVER_APP,
              `Terminal: ${cmd.slice(0, 100)}`,
            ),
            source: 'claude',
            dedupKey: `check_in:bash:${this.roundTo5s(ts)}`,
          };
        }
      }
    }
  }

  private extractTimestamp(
    parsed: Record<string, unknown>,
  ): Date | undefined {
    const raw = parsed.timestamp as string | undefined;
    if (!raw) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  private inferRepoRoot(sessionPath: string): string | undefined {
    const parts = sessionPath.split('/');
    const projectsIdx = parts.indexOf('projects');
    if (projectsIdx < 0) return undefined;
    const encoded = parts[projectsIdx + 1];
    if (!encoded) return undefined;
    return encoded.replace(/-/g, '/');
  }

  private roundTo5s(date: Date): number {
    return Math.round(date.getTime() / 5000) * 5000;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/claude-code.test.ts
```

Expected: Both tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gap-reconstruct/src/sources/ packages/gap-reconstruct/src/__tests__/
git commit -m "feat(gap-reconstruct): add source interface and Claude Code JSONL parser"
```

---

## Task 10: `@pieces-dev/gap-reconstruct` — Screen Time Source

**Files:**
- Create: `packages/gap-reconstruct/src/sources/screen-time.ts`
- Create: `packages/gap-reconstruct/src/__tests__/screen-time.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { ScreenTimeSource } from '../sources/screen-time.js';

vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            ZSTARTDATE: (new Date('2026-05-27T10:00:00Z').getTime() / 1000) - 978307200,
            ZENDDATE: (new Date('2026-05-27T10:30:00Z').getTime() / 1000) - 978307200,
            ZVALUESTRING: 'com.microsoft.VSCodeInsiders',
          },
          {
            ZSTARTDATE: (new Date('2026-05-27T11:00:00Z').getTime() / 1000) - 978307200,
            ZENDDATE: (new Date('2026-05-27T11:15:00Z').getTime() / 1000) - 978307200,
            ZVALUESTRING: 'company.thebrowser.Browser',
          },
        ]),
      }),
      close: vi.fn(),
    })),
  };
});

describe('ScreenTimeSource', () => {
  it('produces app enter/leave events for all apps', async () => {
    const source = new ScreenTimeSource();
    const events: Array<{ source: string; dedupKey: string }> = [];

    for await (const evt of source.collect(
      new Date('2026-05-27T00:00:00Z'),
      new Date('2026-05-28T00:00:00Z'),
    )) {
      events.push({ source: evt.source, dedupKey: evt.dedupKey });
    }

    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.filter((e) => e.dedupKey.includes('application_enter')).length).toBe(2);
    expect(events.filter((e) => e.dedupKey.includes('application_leave')).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/screen-time.test.ts
```

Expected: FAIL — `ScreenTimeSource` does not exist.

- [ ] **Step 3: Implement Screen Time source**

Create `packages/gap-reconstruct/src/sources/screen-time.ts`:

```typescript
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  type SourceEvent,
  OS_SERVER_APP,
  VSCODE_APP,
  appEnterEvent,
  appLeaveEvent,
  checkInEvent,
  getAppDisplayName,
} from '@pieces-dev/core';
import type { Source } from './types.js';

const KNOWLEDGE_DB_PATH = join(
  process.env.HOME ?? '',
  'Library/Application Support/Knowledge/knowledgeC.db',
);
const COREDATA_EPOCH = 978307200;
const CHECK_IN_INTERVAL_S = 60;

const VSCODE_BUNDLE_IDS = new Set([
  'com.microsoft.VSCodeInsiders',
  'com.microsoft.VSCode',
]);

export class ScreenTimeSource implements Source {
  readonly name = 'screentime';
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? KNOWLEDGE_DB_PATH;
  }

  async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
    const fromCoreData = from.getTime() / 1000 - COREDATA_EPOCH;
    const toCoreData = to.getTime() / 1000 - COREDATA_EPOCH;

    let db: Database.Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      console.warn(`Screen Time DB not found at ${this.dbPath} — skipping`);
      return;
    }

    try {
      const rows = db
        .prepare(
          `SELECT ZSTARTDATE, ZENDDATE, ZVALUESTRING
           FROM ZOBJECT
           WHERE ZSTREAMNAME = '/app/usage'
             AND ZSTARTDATE >= ?
             AND ZSTARTDATE <= ?
           ORDER BY ZSTARTDATE`,
        )
        .all(fromCoreData, toCoreData) as Array<{
        ZSTARTDATE: number;
        ZENDDATE: number;
        ZVALUESTRING: string;
      }>;

      for (const row of rows) {
        const startTs = new Date((row.ZSTARTDATE + COREDATA_EPOCH) * 1000);
        const endTs = new Date((row.ZENDDATE + COREDATA_EPOCH) * 1000);
        const bundleId = row.ZVALUESTRING;
        const displayName = getAppDisplayName(bundleId);
        const isVSCode = VSCODE_BUNDLE_IDS.has(bundleId);
        const app = isVSCode ? VSCODE_APP : OS_SERVER_APP;

        yield {
          timestamp: startTs,
          event: appEnterEvent(app, `${displayName} active`),
          source: 'screentime',
          dedupKey: `application_enter:${bundleId}:${this.roundTo5s(startTs)}`,
        };

        if (isVSCode) {
          let checkInTime = new Date(startTs.getTime() + CHECK_IN_INTERVAL_S * 1000);
          while (checkInTime < endTs) {
            yield {
              timestamp: checkInTime,
              event: checkInEvent(app, `VS Code active`),
              source: 'screentime',
              dedupKey: `check_in:${bundleId}:${this.roundTo5s(checkInTime)}`,
            };
            checkInTime = new Date(checkInTime.getTime() + CHECK_IN_INTERVAL_S * 1000);
          }
        }

        yield {
          timestamp: endTs,
          event: appLeaveEvent(app, `${displayName} backgrounded`),
          source: 'screentime',
          dedupKey: `application_leave:${bundleId}:${this.roundTo5s(endTs)}`,
        };
      }
    } finally {
      db.close();
    }
  }

  private roundTo5s(date: Date): number {
    return Math.round(date.getTime() / 5000) * 5000;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/screen-time.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gap-reconstruct/src/sources/screen-time.ts packages/gap-reconstruct/src/__tests__/screen-time.test.ts
git commit -m "feat(gap-reconstruct): add Screen Time source — queries knowledgeC.db for all apps"
```

---

## Task 11: `@pieces-dev/gap-reconstruct` — Arc History Source

**Files:**
- Create: `packages/gap-reconstruct/src/sources/arc-history.ts`
- Create: `packages/gap-reconstruct/src/__tests__/arc-history.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { ArcHistorySource } from '../sources/arc-history.js';

vi.mock('better-sqlite3', () => {
  const CHROME_EPOCH_OFFSET = 11644473600;
  const testTime = new Date('2026-05-27T12:00:00Z').getTime() / 1000 + CHROME_EPOCH_OFFSET;
  return {
    default: vi.fn().mockImplementation(() => ({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            url: 'https://github.com/pieces-app',
            title: 'Pieces App - GitHub',
            last_visit_time: testTime * 1_000_000,
          },
        ]),
      }),
      close: vi.fn(),
    })),
  };
});

describe('ArcHistorySource', () => {
  it('produces url_changed events from history', async () => {
    const source = new ArcHistorySource();
    const events: Array<{ source: string; dedupKey: string }> = [];

    for await (const evt of source.collect(
      new Date('2026-05-27T00:00:00Z'),
      new Date('2026-05-28T00:00:00Z'),
    )) {
      events.push({ source: evt.source, dedupKey: evt.dedupKey });
    }

    expect(events.length).toBe(1);
    expect(events[0]!.source).toBe('arc');
    expect(events[0]!.dedupKey).toContain('url_changed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/arc-history.test.ts
```

Expected: FAIL — `ArcHistorySource` does not exist.

- [ ] **Step 3: Implement Arc History source**

Create `packages/gap-reconstruct/src/sources/arc-history.ts`:

```typescript
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  type SourceEvent,
  OS_SERVER_APP,
  urlChangedEvent,
} from '@pieces-dev/core';
import type { Source } from './types.js';

const ARC_HISTORY_PATH = join(
  process.env.HOME ?? '',
  'Library/Application Support/Arc/User Data/Default/History',
);
const CHROME_EPOCH_OFFSET = 11644473600;

export class ArcHistorySource implements Source {
  readonly name = 'arc';
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? ARC_HISTORY_PATH;
  }

  async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
    const fromChrome = (from.getTime() / 1000 + CHROME_EPOCH_OFFSET) * 1_000_000;
    const toChrome = (to.getTime() / 1000 + CHROME_EPOCH_OFFSET) * 1_000_000;

    let db: Database.Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      console.warn(`Arc History DB not found at ${this.dbPath} — skipping`);
      return;
    }

    try {
      const rows = db
        .prepare(
          `SELECT url, title, last_visit_time
           FROM urls
           WHERE last_visit_time >= ? AND last_visit_time <= ?
           ORDER BY last_visit_time`,
        )
        .all(fromChrome, toChrome) as Array<{
        url: string;
        title: string;
        last_visit_time: number;
      }>;

      for (const row of rows) {
        const unixSeconds =
          row.last_visit_time / 1_000_000 - CHROME_EPOCH_OFFSET;
        const ts = new Date(unixSeconds * 1000);

        yield {
          timestamp: ts,
          event: urlChangedEvent(OS_SERVER_APP, row.url, row.title || undefined),
          source: 'arc',
          dedupKey: `url_changed:${row.url}:${this.roundTo5s(ts)}`,
        };
      }
    } finally {
      db.close();
    }
  }

  private roundTo5s(date: Date): number {
    return Math.round(date.getTime() / 5000) * 5000;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/arc-history.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gap-reconstruct/src/sources/arc-history.ts packages/gap-reconstruct/src/__tests__/arc-history.test.ts
git commit -m "feat(gap-reconstruct): add Arc History source — Chrome timestamp conversion"
```

---

## Task 12: `@pieces-dev/gap-reconstruct` — Git Log Source

**Files:**
- Create: `packages/gap-reconstruct/src/sources/git-log.ts`
- Create: `packages/gap-reconstruct/src/__tests__/git-log.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { GitLogSource } from '../sources/git-log.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(
    'abc123|2026-05-27T14:00:00+00:00|Fix auth bug\n' +
      'src/auth.ts\n' +
      'src/auth.test.ts\n' +
      '\n',
  ),
}));

describe('GitLogSource', () => {
  it('produces check_in and tab_switch events from git log', async () => {
    const source = new GitLogSource(['/Users/joe/project']);
    const events: Array<{ source: string; dedupKey: string }> = [];

    for await (const evt of source.collect(
      new Date('2026-05-27T00:00:00Z'),
      new Date('2026-05-28T00:00:00Z'),
    )) {
      events.push({ source: evt.source, dedupKey: evt.dedupKey });
    }

    expect(events.length).toBe(3);
    expect(events[0]!.dedupKey).toContain('check_in');
    expect(events[1]!.dedupKey).toContain('tab_switch');
    expect(events[2]!.dedupKey).toContain('tab_switch');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/git-log.test.ts
```

Expected: FAIL — `GitLogSource` does not exist.

- [ ] **Step 3: Implement Git Log source**

Create `packages/gap-reconstruct/src/sources/git-log.ts`:

```typescript
import { execSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import {
  type SourceEvent,
  VSCODE_APP,
  checkInEvent,
  tabSwitchEvent,
} from '@pieces-dev/core';
import type { Source } from './types.js';

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.json': 'json',
  '.md': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sql': 'sql',
  '.sh': 'shellscript',
  '.css': 'css',
  '.html': 'html',
};

export class GitLogSource implements Source {
  readonly name = 'git';
  private readonly repos: string[];

  constructor(repos: string[]) {
    this.repos = repos;
  }

  async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
    for (const repo of this.repos) {
      yield* this.collectRepo(repo, from, to);
    }
  }

  private *collectRepo(
    repo: string,
    from: Date,
    to: Date,
  ): Iterable<SourceEvent> {
    let output: string;
    try {
      output = execSync(
        `git -C "${repo}" log --after="${from.toISOString()}" --before="${to.toISOString()}" --format="%H|%aI|%s" --name-only`,
        { encoding: 'utf-8', timeout: 10000 },
      );
    } catch {
      console.warn(`git log failed for ${repo} — skipping`);
      return;
    }

    const lines = output.split('\n');
    let currentCommit: { hash: string; date: Date; subject: string } | undefined;

    for (const line of lines) {
      if (!line.trim()) {
        currentCommit = undefined;
        continue;
      }

      const pipeIdx = line.indexOf('|');
      if (pipeIdx > 0 && line.indexOf('|', pipeIdx + 1) > 0) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const date = new Date(parts[1]!);
          if (!Number.isNaN(date.getTime())) {
            currentCommit = {
              hash: parts[0]!,
              date,
              subject: parts.slice(2).join('|'),
            };

            const repoName = basename(repo);
            yield {
              timestamp: currentCommit.date,
              event: checkInEvent(
                VSCODE_APP,
                `Committed: ${currentCommit.subject} in ${repoName}`,
              ),
              source: 'git',
              dedupKey: `check_in:${currentCommit.hash}:${this.roundTo5s(currentCommit.date)}`,
            };
            continue;
          }
        }
      }

      if (currentCommit && line.trim()) {
        const filePath = join(repo, line.trim());
        const ext = extname(line.trim());
        const language = LANGUAGE_MAP[ext];

        yield {
          timestamp: currentCommit.date,
          event: tabSwitchEvent(VSCODE_APP, filePath, language, repo),
          source: 'git',
          dedupKey: `tab_switch:${filePath}:${this.roundTo5s(currentCommit.date)}`,
        };
      }
    }
  }

  private roundTo5s(date: Date): number {
    return Math.round(date.getTime() / 5000) * 5000;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/git-log.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gap-reconstruct/src/sources/git-log.ts packages/gap-reconstruct/src/__tests__/git-log.test.ts
git commit -m "feat(gap-reconstruct): add Git Log source — commits and file changes"
```

---

## Task 13: `@pieces-dev/gap-reconstruct` — Pipeline (Dedup, Inject, Summarize)

**Files:**
- Modify: `packages/gap-reconstruct/src/pipeline.ts`
- Create: `packages/gap-reconstruct/src/__tests__/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gap-reconstruct/src/__tests__/pipeline.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { dedup } from '../pipeline.js';
import type { SourceEvent } from '@pieces-dev/core';

const makeEvent = (
  source: 'claude' | 'screentime' | 'arc' | 'git',
  dedupKey: string,
  timestamp: Date,
): SourceEvent => ({
  timestamp,
  event: {
    application: { id: '1', name: 'VS_CODE', version: '1', platform: 'MACOS' },
    trigger: { check_in: true },
  },
  source,
  dedupKey,
});

describe('dedup', () => {
  it('removes duplicates with same dedupKey, keeping higher priority source', () => {
    const events: SourceEvent[] = [
      makeEvent('git', 'file_open:/src/a.ts:1000', new Date('2026-05-27T10:00:00Z')),
      makeEvent('claude', 'file_open:/src/a.ts:1000', new Date('2026-05-27T10:00:01Z')),
      makeEvent('arc', 'url_changed:https://x.com:2000', new Date('2026-05-27T11:00:00Z')),
    ];

    const result = dedup(events);

    expect(result.length).toBe(2);
    expect(result[0]!.source).toBe('claude');
    expect(result[1]!.source).toBe('arc');
  });

  it('keeps events with different dedupKeys', () => {
    const events: SourceEvent[] = [
      makeEvent('claude', 'file_open:/a.ts:1000', new Date('2026-05-27T10:00:00Z')),
      makeEvent('claude', 'file_open:/b.ts:1000', new Date('2026-05-27T10:00:01Z')),
    ];

    const result = dedup(events);
    expect(result.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/pipeline.test.ts
```

Expected: FAIL — `dedup` not exported.

- [ ] **Step 3: Implement full pipeline**

Rewrite `packages/gap-reconstruct/src/pipeline.ts`:

```typescript
import { type SourceEvent, PiecesClient, discoverPort } from '@pieces-dev/core';
import { ClaudeCodeSource } from './sources/claude-code.js';
import { ScreenTimeSource } from './sources/screen-time.js';
import { ArcHistorySource } from './sources/arc-history.js';
import { GitLogSource } from './sources/git-log.js';
import type { Source } from './sources/types.js';

export type PipelineOptions = {
  from: Date;
  to: Date;
  sources: string[];
  dryRun: boolean;
  limit?: number;
  concurrency: number;
  skipSummaries: boolean;
  repos?: string[];
};

const SOURCE_PRIORITY: Record<string, number> = {
  claude: 0,
  screentime: 1,
  git: 2,
  arc: 3,
};

export function dedup(events: SourceEvent[]): SourceEvent[] {
  const seen = new Map<string, SourceEvent>();

  for (const evt of events) {
    const existing = seen.get(evt.dedupKey);
    if (!existing) {
      seen.set(evt.dedupKey, evt);
      continue;
    }

    const existingPriority = SOURCE_PRIORITY[existing.source] ?? 99;
    const newPriority = SOURCE_PRIORITY[evt.source] ?? 99;
    if (newPriority < existingPriority) {
      seen.set(evt.dedupKey, evt);
    }
  }

  return [...seen.values()].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );
}

function createSources(
  sourceNames: string[],
  repos?: string[],
): Source[] {
  const sources: Source[] = [];

  for (const name of sourceNames) {
    switch (name) {
      case 'claude':
        sources.push(new ClaudeCodeSource());
        break;
      case 'screentime':
        sources.push(new ScreenTimeSource());
        break;
      case 'arc':
        sources.push(new ArcHistorySource());
        break;
      case 'git':
        sources.push(new GitLogSource(repos ?? []));
        break;
      default:
        console.warn(`Unknown source: ${name} — skipping`);
    }
  }

  return sources;
}

async function collectAll(
  sources: Source[],
  from: Date,
  to: Date,
): Promise<SourceEvent[]> {
  const allEvents: SourceEvent[] = [];
  const counts: Record<string, number> = {};

  for (const source of sources) {
    let count = 0;
    for await (const evt of source.collect(from, to)) {
      allEvents.push(evt);
      count++;
    }
    counts[source.name] = count;
    console.log(`  ${source.name}: ${count} events`);
  }

  return allEvents;
}

function printDryRun(events: SourceEvent[], from: Date, to: Date): void {
  const durationMs = to.getTime() - from.getTime();
  const days = Math.floor(durationMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((durationMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  console.log(`\nGap window: ${from.toISOString()} → ${to.toISOString()} (${days}d ${hours}h)`);
  console.log(`\nTotal events after dedup: ${events.length}`);

  const bySource: Record<string, number> = {};
  for (const evt of events) {
    bySource[evt.source] = (bySource[evt.source] ?? 0) + 1;
  }
  console.log('\nBy source:');
  for (const [source, count] of Object.entries(bySource)) {
    console.log(`  ${source}: ${count}`);
  }

  const byDay: Record<string, number> = {};
  for (const evt of events) {
    const day = evt.timestamp.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }
  console.log('\nDaily distribution:');
  for (const [day, count] of Object.entries(byDay).sort()) {
    console.log(`  ${day}: ${count} events`);
  }
}

async function injectEvents(
  client: PiecesClient,
  events: SourceEvent[],
  concurrency: number,
): Promise<{ injected: number; failed: number }> {
  let injected = 0;
  let failed = 0;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < events.length) {
      const current = idx++;
      const evt = events[current]!;
      const id = await client.postEvent(evt.event as Record<string, unknown>);
      if (id) {
        injected++;
      } else {
        failed++;
      }
      if ((injected + failed) % 100 === 0) {
        console.log(`  Progress: ${injected + failed}/${events.length} (${failed} failed)`);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return { injected, failed };
}

async function generateSummaries(
  client: PiecesClient,
  events: SourceEvent[],
): Promise<void> {
  const days = new Set(
    events.map((e) => e.timestamp.toISOString().slice(0, 10)),
  );

  console.log(`\nGenerating summaries for ${days.size} days...`);

  for (const day of [...days].sort()) {
    const from = new Date(`${day}T00:00:00Z`);
    const to = new Date(`${day}T23:59:59Z`);
    const ok = await client.triggerSummary(from, to);
    console.log(`  ${day}: ${ok ? 'OK' : 'FAILED'}`);
  }
}

export async function runPipeline(options: PipelineOptions): Promise<void> {
  console.log('Collecting events...');

  const sources = createSources(options.sources, options.repos);
  const rawEvents = await collectAll(sources, options.from, options.to);
  const events = dedup(rawEvents);

  if (options.limit && events.length > options.limit) {
    events.length = options.limit;
    console.log(`\nLimited to ${options.limit} events`);
  }

  if (options.dryRun) {
    printDryRun(events, options.from, options.to);
    return;
  }

  const port = await discoverPort();
  if (!port) {
    console.error('Error: PiecesOS not found. Is it running?');
    process.exit(1);
  }

  const client = new PiecesClient(port);
  const healthy = await client.checkHealth();
  if (!healthy) {
    console.error('Error: PiecesOS health check failed');
    process.exit(1);
  }

  console.log(`\nInjecting ${events.length} events into PiecesOS on port ${port}...`);
  const { injected, failed } = await injectEvents(
    client,
    events,
    options.concurrency,
  );

  console.log(`\nDone: ${injected} injected, ${failed} failed`);

  if (!options.skipSummaries && injected > 0) {
    await generateSummaries(client, events);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test
```

Expected: All tests PASS (Claude Code, Screen Time, Arc History, Git Log, Pipeline).

- [ ] **Step 5: Verify CLI still works end-to-end with dry run**

```bash
pnpm --filter @pieces-dev/gap-reconstruct start -- run --from 2026-05-26T02:43:00Z --to 2026-06-04T08:52:00Z --dry-run --sources claude
```

Expected: Outputs event counts from Claude Code sessions.

- [ ] **Step 6: Commit**

```bash
git add packages/gap-reconstruct/src/pipeline.ts packages/gap-reconstruct/src/__tests__/pipeline.test.ts
git commit -m "feat(gap-reconstruct): wire pipeline — collect, dedup, inject, summarize"
```

---

## Task 14: `@pieces-dev/gap-reconstruct` — Gap Detector

**Files:**
- Modify: `packages/gap-reconstruct/src/gap-detector.ts`
- Create: `packages/gap-reconstruct/src/__tests__/gap-detector.test.ts`

The gap detector queries PiecesOS for existing workstream events and finds time periods with no coverage. This makes the tool reusable — you don't need to know when gaps occurred, the tool finds them for you.

- [ ] **Step 1: Write the failing test**

Create `packages/gap-reconstruct/src/__tests__/gap-detector.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { findGapsInTimeline } from '../gap-detector.js';

describe('findGapsInTimeline', () => {
  it('finds a gap between two event clusters', () => {
    const events = [
      { timestamp: new Date('2026-05-25T10:00:00Z') },
      { timestamp: new Date('2026-05-25T10:30:00Z') },
      { timestamp: new Date('2026-05-25T11:00:00Z') },
      // GAP: May 25 11:00 → May 27 09:00 (46 hours)
      { timestamp: new Date('2026-05-27T09:00:00Z') },
      { timestamp: new Date('2026-05-27T09:30:00Z') },
    ];

    const minGapMs = 60 * 60 * 1000; // 1 hour
    const gaps = findGapsInTimeline(events, minGapMs);

    expect(gaps.length).toBe(1);
    expect(gaps[0]!.from.toISOString()).toBe('2026-05-25T11:00:00.000Z');
    expect(gaps[0]!.to.toISOString()).toBe('2026-05-27T09:00:00.000Z');
  });

  it('returns empty when no gaps exceed minimum', () => {
    const events = [
      { timestamp: new Date('2026-05-25T10:00:00Z') },
      { timestamp: new Date('2026-05-25T10:30:00Z') },
      { timestamp: new Date('2026-05-25T11:00:00Z') },
    ];

    const minGapMs = 2 * 60 * 60 * 1000; // 2 hours
    const gaps = findGapsInTimeline(events, minGapMs);

    expect(gaps.length).toBe(0);
  });

  it('handles empty event list', () => {
    const gaps = findGapsInTimeline([], 60 * 60 * 1000);
    expect(gaps.length).toBe(0);
  });

  it('finds multiple gaps', () => {
    const events = [
      { timestamp: new Date('2026-05-20T10:00:00Z') },
      // GAP 1: 3 hours
      { timestamp: new Date('2026-05-20T13:00:00Z') },
      // GAP 2: 5 hours
      { timestamp: new Date('2026-05-20T18:00:00Z') },
    ];

    const minGapMs = 2 * 60 * 60 * 1000; // 2 hours
    const gaps = findGapsInTimeline(events, minGapMs);

    expect(gaps.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/gap-detector.test.ts
```

Expected: FAIL — `findGapsInTimeline` does not exist (only the stub `detectGaps` exists).

- [ ] **Step 3: Implement gap detector**

Replace `packages/gap-reconstruct/src/gap-detector.ts`:

```typescript
import { PiecesClient, discoverPort } from '@pieces-dev/core';

export type Gap = {
  from: Date;
  to: Date;
};

export function findGapsInTimeline(
  events: Array<{ timestamp: Date }>,
  minGapMs: number,
): Gap[] {
  if (events.length < 2) return [];

  const sorted = [...events].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const gaps: Gap[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const diff = curr.timestamp.getTime() - prev.timestamp.getTime();

    if (diff >= minGapMs) {
      gaps.push({ from: prev.timestamp, to: curr.timestamp });
    }
  }

  return gaps;
}

export async function detectGaps(
  since: Date,
  until: Date,
  minGapMs: number,
): Promise<Gap[]> {
  const port = await discoverPort();
  if (!port) {
    console.error('Error: PiecesOS not found. Is it running?');
    return [];
  }

  const client = new PiecesClient(port);
  const healthy = await client.checkHealth();
  if (!healthy) {
    console.error('Error: PiecesOS health check failed');
    return [];
  }

  const rawEvents = await client.getEvents();
  const events = (rawEvents as Array<{ created?: { value?: string } }>)
    .map((e) => {
      const ts = e.created?.value;
      return ts ? { timestamp: new Date(ts) } : null;
    })
    .filter((e): e is { timestamp: Date } => {
      if (!e) return false;
      return e.timestamp >= since && e.timestamp <= until;
    });

  if (events.length === 0) {
    console.log(`No events found in range ${since.toISOString()} → ${until.toISOString()}`);
    console.log('The entire range is a gap.');
    return [{ from: since, to: until }];
  }

  const gaps = findGapsInTimeline(events, minGapMs);

  // Also check for a leading gap (since → first event)
  const firstEvent = events.sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  )[0]!;
  if (firstEvent.timestamp.getTime() - since.getTime() >= minGapMs) {
    gaps.unshift({ from: since, to: firstEvent.timestamp });
  }

  // And a trailing gap (last event → until)
  const lastEvent = events[events.length - 1]!;
  if (until.getTime() - lastEvent.timestamp.getTime() >= minGapMs) {
    gaps.push({ from: lastEvent.timestamp, to: until });
  }

  return gaps.sort((a, b) => a.from.getTime() - b.from.getTime());
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/gap-reconstruct test -- src/__tests__/gap-detector.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Verify detect command works with real PiecesOS**

```bash
pnpm --filter @pieces-dev/gap-reconstruct start -- detect --since 30d --min-gap 60
```

Expected: Lists any gaps found in the last 30 days, or "No gaps found."

- [ ] **Step 6: Verify all-gaps backfill workflow (dry-run)**

```bash
pnpm --filter @pieces-dev/gap-reconstruct start -- run --all-gaps --since 30d --min-gap 60 --dry-run
```

Expected: Detects gaps, then runs dry-run pipeline for each one.

- [ ] **Step 7: Commit**

```bash
git add packages/gap-reconstruct/src/gap-detector.ts packages/gap-reconstruct/src/__tests__/gap-detector.test.ts
git commit -m "feat(gap-reconstruct): add gap detector — scans PiecesOS events for coverage gaps"
```

---

## Task 15: `@pieces-dev/ltm-injector` — Package Scaffold + Extension Manifest

**Files:**
- Create: `packages/ltm-injector/package.json`
- Create: `packages/ltm-injector/tsconfig.json`
- Create: `packages/ltm-injector/esbuild.mjs`
- Create: `packages/ltm-injector/.vscodeignore`

- [ ] **Step 1: Create `packages/ltm-injector/package.json`**

This is both `package.json` AND the VS Code extension manifest (via `contributes`):

```json
{
  "name": "@pieces-dev/ltm-injector",
  "displayName": "Pieces LTM Injector",
  "description": "Injects IDE workstream events into PiecesOS Long-Term Memory",
  "version": "0.1.0",
  "publisher": "joeblack",
  "license": "MIT",
  "engines": {
    "vscode": "^1.100.0"
  },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "contributes": {
    "configuration": {
      "title": "Pieces LTM Injector",
      "properties": {
        "pieces-ltm-injector.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable/disable workstream event injection"
        },
        "pieces-ltm-injector.portOverride": {
          "type": ["number", "null"],
          "default": null,
          "description": "Override PiecesOS port (skip auto-discovery)"
        },
        "pieces-ltm-injector.heartbeatInterval": {
          "type": "number",
          "default": 30000,
          "description": "Port re-probe interval in milliseconds"
        },
        "pieces-ltm-injector.checkInInterval": {
          "type": "number",
          "default": 60000,
          "description": "Check-in heartbeat interval in milliseconds"
        },
        "pieces-ltm-injector.queueSize": {
          "type": "number",
          "default": 500,
          "description": "Max queued events when PiecesOS is unreachable"
        },
        "pieces-ltm-injector.debugLogging": {
          "type": "boolean",
          "default": false,
          "description": "Log every event to the output channel"
        },
        "pieces-ltm-injector.enableClaudeCodeIntegration": {
          "type": "boolean",
          "default": true,
          "description": "Watch and parse Claude Code sessions"
        },
        "pieces-ltm-injector.enableGitEvents": {
          "type": "boolean",
          "default": true,
          "description": "Emit events for git branch switches and commits"
        },
        "pieces-ltm-injector.enableTerminalEvents": {
          "type": "boolean",
          "default": true,
          "description": "Emit events for terminal commands"
        }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "test": "vitest run",
    "package": "vsce package --no-dependencies"
  },
  "dependencies": {
    "@pieces-dev/core": "workspace:*"
  },
  "devDependencies": {
    "@types/vscode": "^1.100.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0",
    "@vscode/vsce": "^3.0.0"
  }
}
```

Note: Replace `"publisher": "joeblack"` with your actual VS Code Marketplace publisher ID.

- [ ] **Step 2: Create `packages/ltm-injector/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"]
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/ltm-injector/esbuild.mjs`**

```javascript
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  minify: !watch,
});

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
```

Note: VS Code extensions must output CJS (`format: 'cjs'`), not ESM — VS Code's extension host uses `require()`.

- [ ] **Step 4: Create `packages/ltm-injector/.vscodeignore`**

```
src/**
node_modules/**
*.ts
tsconfig.json
esbuild.mjs
.vscode-test/**
```

- [ ] **Step 5: Install and verify build**

```bash
pnpm install
pnpm --filter @pieces-dev/ltm-injector build
```

Expected: Build fails because `src/extension.ts` doesn't exist yet. That's expected — we'll create it in the next task.

- [ ] **Step 6: Commit**

```bash
git add packages/ltm-injector/package.json packages/ltm-injector/tsconfig.json packages/ltm-injector/esbuild.mjs packages/ltm-injector/.vscodeignore
git commit -m "feat(ltm-injector): scaffold VS Code extension manifest with settings"
```

---

## Task 16: `@pieces-dev/ltm-injector` — EventQueue

**Files:**
- Create: `packages/ltm-injector/src/event-queue.ts`
- Create: `packages/ltm-injector/src/__tests__/event-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { EventQueue } from '../event-queue.js';

const makeEvent = () => ({
  application: { id: '1', name: 'VS_CODE', version: '1', platform: 'MACOS' as const },
  trigger: { check_in: true },
});

describe('EventQueue', () => {
  it('enqueues and drains in FIFO order', async () => {
    const queue = new EventQueue(10);
    queue.enqueue({ ...makeEvent(), readable: 'first' });
    queue.enqueue({ ...makeEvent(), readable: 'second' });

    const drained: string[] = [];
    await queue.drain(async (evt) => {
      drained.push(evt.readable ?? '');
    });

    expect(drained).toEqual(['first', 'second']);
    expect(queue.size).toBe(0);
  });

  it('drops oldest when full', () => {
    const queue = new EventQueue(2);
    queue.enqueue({ ...makeEvent(), readable: 'a' });
    queue.enqueue({ ...makeEvent(), readable: 'b' });
    queue.enqueue({ ...makeEvent(), readable: 'c' });

    expect(queue.size).toBe(2);
  });

  it('drains the newer events when full (oldest dropped)', async () => {
    const queue = new EventQueue(2);
    queue.enqueue({ ...makeEvent(), readable: 'a' });
    queue.enqueue({ ...makeEvent(), readable: 'b' });
    queue.enqueue({ ...makeEvent(), readable: 'c' });

    const drained: string[] = [];
    await queue.drain(async (evt) => {
      drained.push(evt.readable ?? '');
    });

    expect(drained).toEqual(['b', 'c']);
  });

  it('reports correct size', () => {
    const queue = new EventQueue(5);
    expect(queue.size).toBe(0);
    queue.enqueue(makeEvent());
    expect(queue.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @pieces-dev/ltm-injector test -- src/__tests__/event-queue.test.ts
```

Expected: FAIL — `EventQueue` does not exist.

- [ ] **Step 3: Implement EventQueue**

Create `packages/ltm-injector/src/event-queue.ts`:

```typescript
type SeededEvent = {
  application: { id: string; name: string; version: string; platform: string };
  trigger: Record<string, boolean>;
  readable?: string;
  context?: Record<string, unknown>;
};

export class EventQueue {
  private buffer: SeededEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.buffer.length;
  }

  enqueue(event: SeededEvent): void {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
    }
    this.buffer.push(event);
  }

  async drain(
    callback: (event: SeededEvent) => Promise<void>,
  ): Promise<void> {
    while (this.buffer.length > 0) {
      const event = this.buffer.shift()!;
      await callback(event);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @pieces-dev/ltm-injector test -- src/__tests__/event-queue.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ltm-injector/src/event-queue.ts packages/ltm-injector/src/__tests__/event-queue.test.ts
git commit -m "feat(ltm-injector): add EventQueue ring buffer for offline queueing"
```

---

## Task 17: `@pieces-dev/ltm-injector` — Extension Entry Point + Core Handlers

**Files:**
- Create: `packages/ltm-injector/src/extension.ts`
- Create: `packages/ltm-injector/src/handlers/file-handler.ts`
- Create: `packages/ltm-injector/src/handlers/tab-handler.ts`
- Create: `packages/ltm-injector/src/handlers/clipboard-handler.ts`

- [ ] **Step 1: Create file handler**

Create `packages/ltm-injector/src/handlers/file-handler.ts`:

```typescript
import * as vscode from 'vscode';
import {
  PiecesClient,
  VSCODE_APP,
  fileOpenEvent,
  fileCloseEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

const DEBOUNCE_MS = 2000;
const SKIP_SCHEMES = new Set(['untitled', 'output', 'vscode', 'git', 'debug']);

export function registerFileHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const recentOpens = new Map<string, number>();

  const onOpen = vscode.workspace.onDidOpenTextDocument((doc) => {
    if (SKIP_SCHEMES.has(doc.uri.scheme)) return;

    const path = doc.uri.fsPath;
    const now = Date.now();
    const last = recentOpens.get(path);
    if (last && now - last < DEBOUNCE_MS) return;
    recentOpens.set(path, now);

    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const event = fileOpenEvent(
      VSCODE_APP,
      path,
      doc.languageId,
      folder?.uri.fsPath,
    );

    if (connected()) {
      client.postEvent(event as Record<string, unknown>);
      log(`file_open: ${path}`);
    } else {
      queue.enqueue(event);
    }
  });

  const onClose = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (SKIP_SCHEMES.has(doc.uri.scheme)) return;

    const path = doc.uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const event = fileCloseEvent(
      VSCODE_APP,
      path,
      doc.languageId,
      folder?.uri.fsPath,
    );

    if (connected()) {
      client.postEvent(event as Record<string, unknown>);
      log(`file_close: ${path}`);
    } else {
      queue.enqueue(event);
    }
  });

  return [onOpen, onClose];
}
```

- [ ] **Step 2: Create tab handler**

Create `packages/ltm-injector/src/handlers/tab-handler.ts`:

```typescript
import * as vscode from 'vscode';
import {
  PiecesClient,
  VSCODE_APP,
  tabSwitchEvent,
  appEnterEvent,
  appLeaveEvent,
  checkInEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

export function registerTabHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
  checkInIntervalMs: number,
): vscode.Disposable[] {
  let checkInTimer: ReturnType<typeof setInterval> | undefined;

  function send(event: Record<string, unknown>, label: string): void {
    if (connected()) {
      client.postEvent(event);
      log(label);
    } else {
      queue.enqueue(event as { application: { id: string; name: string; version: string; platform: string }; trigger: Record<string, boolean> });
    }
  }

  function startCheckIn(): void {
    stopCheckIn();
    checkInTimer = setInterval(() => {
      send(
        checkInEvent(VSCODE_APP, 'VS Code active') as Record<string, unknown>,
        'check_in: heartbeat',
      );
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
    const event = tabSwitchEvent(
      VSCODE_APP,
      doc.uri.fsPath,
      doc.languageId,
      folder?.uri.fsPath,
    );
    send(event as Record<string, unknown>, `tab_switch: ${doc.uri.fsPath}`);
  });

  const onFocus = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      send(
        appEnterEvent(VSCODE_APP, 'VS Code focused') as Record<string, unknown>,
        'application_enter',
      );
      startCheckIn();
    } else {
      send(
        appLeaveEvent(VSCODE_APP, 'VS Code backgrounded') as Record<string, unknown>,
        'application_leave',
      );
      stopCheckIn();
    }
  });

  if (vscode.window.state.focused) {
    startCheckIn();
  }

  const dispose = new vscode.Disposable(() => stopCheckIn());
  return [onTabSwitch, onFocus, dispose];
}
```

- [ ] **Step 3: Create clipboard handler**

Create `packages/ltm-injector/src/handlers/clipboard-handler.ts`:

```typescript
import * as vscode from 'vscode';
import { PiecesClient, VSCODE_APP, copyEvent } from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

export function registerClipboardHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const cmd = vscode.commands.registerCommand(
    'pieces-ltm-injector.clipboardCopy',
    async () => {
      await vscode.commands.executeCommand(
        'editor.action.clipboardCopyAction',
      );

      const text = await vscode.env.clipboard.readText();
      if (!text) return;

      const event = copyEvent(VSCODE_APP, text);

      if (connected()) {
        client.postEvent(event as Record<string, unknown>);
        log(`copy: ${text.slice(0, 50)}...`);
      } else {
        queue.enqueue(event);
      }
    },
  );

  return [cmd];
}
```

- [ ] **Step 4: Create extension entry point**

Create `packages/ltm-injector/src/extension.ts`:

```typescript
import * as vscode from 'vscode';
import { PiecesClient, discoverPort } from '@pieces-dev/core';
import { EventQueue } from './event-queue.js';
import { registerFileHandler } from './handlers/file-handler.js';
import { registerTabHandler } from './handlers/tab-handler.js';
import { registerClipboardHandler } from './handlers/clipboard-handler.js';

let client: PiecesClient | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let isConnected = false;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('pieces-ltm-injector');
  if (!config.get<boolean>('enabled', true)) return;

  const output = vscode.window.createOutputChannel('Pieces LTM Injector');
  context.subscriptions.push(output);

  const queueSize = config.get<number>('queueSize', 500);
  const queue = new EventQueue(queueSize);

  const portOverride = config.get<number | null>('portOverride', null);
  const heartbeatMs = config.get<number>('heartbeatInterval', 30000);
  const checkInMs = config.get<number>('checkInInterval', 60000);
  const debugLogging = config.get<boolean>('debugLogging', false);

  const log = (msg: string) => {
    if (debugLogging) {
      output.appendLine(`[${new Date().toISOString()}] ${msg}`);
    }
  };

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusBar.command = 'pieces-ltm-injector.showOutput';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('pieces-ltm-injector.showOutput', () => {
      output.show();
    }),
  );

  function updateStatus(): void {
    if (isConnected) {
      statusBar.text = '$(plug) Pieces';
      statusBar.tooltip = 'PiecesOS connected';
      statusBar.backgroundColor = undefined;
    } else {
      const depth = queue.size;
      statusBar.text = depth > 0
        ? `$(warning) Pieces (${depth} queued)`
        : '$(warning) Pieces';
      statusBar.tooltip = 'PiecesOS disconnected';
      statusBar.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    }
    statusBar.show();
  }

  async function connect(): Promise<void> {
    const port = await discoverPort(
      portOverride ? { portOverride } : undefined,
    );

    if (port) {
      client = new PiecesClient(port);
      const healthy = await client.checkHealth();
      if (healthy) {
        isConnected = true;
        output.appendLine(`Connected to PiecesOS on port ${port}`);
        updateStatus();

        await queue.drain(async (event) => {
          await client!.postEvent(event as Record<string, unknown>);
        });
        return;
      }
    }

    isConnected = false;
    output.appendLine('PiecesOS not found — events will be queued');
    updateStatus();
  }

  await connect();

  heartbeatTimer = setInterval(async () => {
    if (!isConnected) {
      await connect();
    } else if (client) {
      const healthy = await client.checkHealth();
      if (!healthy) {
        isConnected = false;
        output.appendLine('PiecesOS connection lost');
        updateStatus();
      }
    }
  }, heartbeatMs);

  context.subscriptions.push(new vscode.Disposable(() => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }));

  const connected = () => isConnected && client !== undefined;

  if (client) {
    context.subscriptions.push(
      ...registerFileHandler(client, queue, connected, log),
      ...registerTabHandler(client, queue, connected, log, checkInMs),
      ...registerClipboardHandler(client, queue, connected, log),
    );
  }
}

export function deactivate(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}
```

- [ ] **Step 5: Build the extension**

```bash
pnpm --filter @pieces-dev/core build && pnpm --filter @pieces-dev/ltm-injector build
```

Expected: Build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ltm-injector/src/
git commit -m "feat(ltm-injector): extension entry point with file, tab, and clipboard handlers"
```

---

## Task 18: `@pieces-dev/ltm-injector` — Extended Handlers (Git, Terminal, Debug)

**Files:**
- Create: `packages/ltm-injector/src/handlers/git-handler.ts`
- Create: `packages/ltm-injector/src/handlers/terminal-handler.ts`
- Create: `packages/ltm-injector/src/handlers/debug-handler.ts`

- [ ] **Step 1: Create git handler**

Create `packages/ltm-injector/src/handlers/git-handler.ts`:

```typescript
import * as vscode from 'vscode';
import {
  PiecesClient,
  VSCODE_APP,
  checkInEvent,
  tabSwitchEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

type GitExtension = {
  getAPI(version: 1): GitAPI;
};

type GitAPI = {
  repositories: GitRepository[];
};

type GitRepository = {
  state: {
    HEAD?: { commit?: string; name?: string };
    onDidChange: vscode.Event<void>;
  };
};

export function registerGitHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExt) {
    log('Git extension not available — skipping git handler');
    return [];
  }

  const git = gitExt.exports.getAPI(1);
  const disposables: vscode.Disposable[] = [];

  function send(event: Record<string, unknown>, label: string): void {
    if (connected()) {
      client.postEvent(event);
      log(label);
    } else {
      queue.enqueue(event as { application: { id: string; name: string; version: string; platform: string }; trigger: Record<string, boolean> });
    }
  }

  for (const repo of git.repositories) {
    let lastCommit = repo.state.HEAD?.commit;
    let lastBranch = repo.state.HEAD?.name;

    const sub = repo.state.onDidChange(() => {
      const head = repo.state.HEAD;
      if (!head) return;

      if (head.commit && head.commit !== lastCommit) {
        lastCommit = head.commit;
        send(
          checkInEvent(VSCODE_APP, `Committed in ${head.name ?? 'detached'}`) as Record<string, unknown>,
          `git: new commit on ${head.name}`,
        );
      }

      if (head.name && head.name !== lastBranch) {
        lastBranch = head.name;
        send(
          tabSwitchEvent(VSCODE_APP, head.name, undefined, undefined) as Record<string, unknown>,
          `git: switched to branch ${head.name}`,
        );
      }
    });

    disposables.push(sub);
  }

  return disposables;
}
```

- [ ] **Step 2: Create terminal handler**

Create `packages/ltm-injector/src/handlers/terminal-handler.ts`:

```typescript
import * as vscode from 'vscode';
import { PiecesClient, VSCODE_APP, checkInEvent } from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

const THROTTLE_MS = 10000;

export function registerTerminalHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const lastEvent = new Map<number, number>();

  const sub = vscode.window.onDidWriteTerminalData((e) => {
    const termId = e.terminal.processId ?? 0;
    const now = Date.now();
    const last = lastEvent.get(termId as number);
    if (last && now - last < THROTTLE_MS) return;
    lastEvent.set(termId as number, now);

    const text = e.data.trim().slice(0, 100);
    if (!text) return;

    const event = checkInEvent(VSCODE_APP, `Terminal: ${text}`);

    if (connected()) {
      client.postEvent(event as Record<string, unknown>);
      log(`terminal: ${text.slice(0, 50)}`);
    } else {
      queue.enqueue(event);
    }
  });

  return [sub];
}
```

- [ ] **Step 3: Create debug handler**

Create `packages/ltm-injector/src/handlers/debug-handler.ts`:

```typescript
import * as vscode from 'vscode';
import {
  PiecesClient,
  VSCODE_APP,
  appEnterEvent,
  appLeaveEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

export function registerDebugHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  function send(event: Record<string, unknown>, label: string): void {
    if (connected()) {
      client.postEvent(event);
      log(label);
    } else {
      queue.enqueue(event as { application: { id: string; name: string; version: string; platform: string }; trigger: Record<string, boolean> });
    }
  }

  const onStart = vscode.debug.onDidStartDebugSession((session) => {
    send(
      appEnterEvent(
        VSCODE_APP,
        `Debug: ${session.name} (${session.type})`,
      ) as Record<string, unknown>,
      `debug: started ${session.name}`,
    );
  });

  const onEnd = vscode.debug.onDidTerminateDebugSession((session) => {
    send(
      appLeaveEvent(
        VSCODE_APP,
        `Debug ended: ${session.name}`,
      ) as Record<string, unknown>,
      `debug: ended ${session.name}`,
    );
  });

  return [onStart, onEnd];
}
```

- [ ] **Step 4: Wire extended handlers into `extension.ts`**

Add imports and handler registration to `packages/ltm-injector/src/extension.ts`. After the existing handler registrations, add:

```typescript
import { registerGitHandler } from './handlers/git-handler.js';
import { registerTerminalHandler } from './handlers/terminal-handler.js';
import { registerDebugHandler } from './handlers/debug-handler.js';
```

And in the `activate` function, after the core handler registrations:

```typescript
    if (config.get<boolean>('enableGitEvents', true)) {
      context.subscriptions.push(
        ...registerGitHandler(client, queue, connected, log),
      );
    }

    if (config.get<boolean>('enableTerminalEvents', true)) {
      context.subscriptions.push(
        ...registerTerminalHandler(client, queue, connected, log),
      );
    }

    context.subscriptions.push(
      ...registerDebugHandler(client, queue, connected, log),
    );
```

- [ ] **Step 5: Build to verify everything compiles**

```bash
pnpm --filter @pieces-dev/core build && pnpm --filter @pieces-dev/ltm-injector build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/ltm-injector/src/handlers/ packages/ltm-injector/src/extension.ts
git commit -m "feat(ltm-injector): add git, terminal, and debug handlers"
```

---

## Task 19: `@pieces-dev/ltm-injector` — Claude Code Handler

**Files:**
- Create: `packages/ltm-injector/src/handlers/claude-code-handler.ts`

- [ ] **Step 1: Implement Claude Code handler**

Create `packages/ltm-injector/src/handlers/claude-code-handler.ts`:

```typescript
import * as vscode from 'vscode';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import {
  PiecesClient,
  OS_SERVER_APP,
  fileOpenEvent,
  checkInEvent,
} from '@pieces-dev/core';
import { EventQueue } from '../event-queue.js';

const CLAUDE_PROJECTS = join(homedir(), '.claude/projects');

export function registerClaudeCodeHandler(
  client: PiecesClient,
  queue: EventQueue,
  connected: () => boolean,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const watchedFiles = new Set<string>();
  const fileSizes = new Map<string, number>();

  function send(event: Record<string, unknown>, label: string): void {
    if (connected()) {
      client.postEvent(event);
      log(label);
    } else {
      queue.enqueue(event as { application: { id: string; name: string; version: string; platform: string }; trigger: Record<string, boolean> });
    }
  }

  let watcher: ReturnType<typeof watch> | undefined;

  try {
    watcher = watch(CLAUDE_PROJECTS, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      if (filename.includes('subagent')) return;

      const fullPath = join(CLAUDE_PROJECTS, filename);
      if (watchedFiles.has(fullPath)) return;
      watchedFiles.add(fullPath);

      tailFile(fullPath);
    });
  } catch {
    log('Claude Code projects directory not found — skipping');
    return [];
  }

  async function tailFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      fileSizes.set(filePath, content.length);

      const checkInterval = setInterval(async () => {
        try {
          const newContent = await readFile(filePath, 'utf-8');
          const prevSize = fileSizes.get(filePath) ?? 0;
          if (newContent.length <= prevSize) return;

          const newPart = newContent.slice(prevSize);
          fileSizes.set(filePath, newContent.length);

          for (const line of newPart.split('\n').filter(Boolean)) {
            processLine(line, filePath);
          }
        } catch {
          clearInterval(checkInterval);
          watchedFiles.delete(filePath);
        }
      }, 2000);
    } catch {
      watchedFiles.delete(filePath);
    }
  }

  function processLine(line: string, sessionPath: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.type !== 'assistant') return;

    const content = parsed.content;
    if (!Array.isArray(content)) return;

    const project = inferProject(sessionPath);

    for (const block of content) {
      if (
        typeof block !== 'object' ||
        block === null ||
        (block as Record<string, unknown>).type !== 'tool_use'
      ) {
        continue;
      }

      const toolUse = block as { name?: string; input?: Record<string, unknown> };
      const input = toolUse.input;
      if (!input) continue;

      if (
        toolUse.name === 'Read' ||
        toolUse.name === 'Edit' ||
        toolUse.name === 'Write'
      ) {
        const fp =
          (input.file_path as string | undefined) ??
          (input.path as string | undefined);
        if (fp && !isOpenInVSCode(fp)) {
          send(
            fileOpenEvent(OS_SERVER_APP, fp) as Record<string, unknown>,
            `claude-code: ${toolUse.name} ${basename(fp)}`,
          );
        }
      }

      if (toolUse.name === 'Bash') {
        const cmd = input.command as string | undefined;
        if (cmd) {
          send(
            checkInEvent(
              OS_SERVER_APP,
              `Claude Code: ${cmd.slice(0, 100)}`,
            ) as Record<string, unknown>,
            `claude-code: bash in ${project}`,
          );
        }
      }
    }
  }

  function isOpenInVSCode(filePath: string): boolean {
    return vscode.workspace.textDocuments.some(
      (doc) => doc.uri.fsPath === filePath,
    );
  }

  function inferProject(sessionPath: string): string {
    const parts = sessionPath.split('/');
    const projIdx = parts.indexOf('projects');
    if (projIdx >= 0 && parts[projIdx + 1]) {
      return parts[projIdx + 1]!.replace(/-/g, '/');
    }
    return 'unknown';
  }

  const dispose = new vscode.Disposable(() => {
    watcher?.close();
  });

  return [dispose];
}
```

- [ ] **Step 2: Wire into `extension.ts`**

Add import and registration in `packages/ltm-injector/src/extension.ts`:

```typescript
import { registerClaudeCodeHandler } from './handlers/claude-code-handler.js';
```

Add after debug handler registration:

```typescript
    if (config.get<boolean>('enableClaudeCodeIntegration', true)) {
      context.subscriptions.push(
        ...registerClaudeCodeHandler(client, queue, connected, log),
      );
    }
```

- [ ] **Step 3: Build to verify**

```bash
pnpm --filter @pieces-dev/core build && pnpm --filter @pieces-dev/ltm-injector build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/ltm-injector/src/handlers/claude-code-handler.ts packages/ltm-injector/src/extension.ts
git commit -m "feat(ltm-injector): add Claude Code session handler — tails JSONL, dedupes vs open files"
```

---

## Task 20: Extension Development Host Verification

**Files:** None created — this is a test/verify task.

- [ ] **Step 1: Build all packages**

```bash
pnpm build
```

Expected: All 3 packages build successfully.

- [ ] **Step 2: Launch Extension Development Host**

Open the `pieces-dev` monorepo in VS Code, navigate to `packages/ltm-injector/`, press F5 (or Run > Start Debugging) to launch the Extension Development Host.

If no `launch.json` exists, create `packages/ltm-injector/.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}/packages/ltm-injector"]
    }
  ]
}
```

- [ ] **Step 3: Verify in Extension Development Host**

In the new VS Code window:
1. Open a file → check Output channel "Pieces LTM Injector" shows `file_open` log
2. Switch tabs → check `tab_switch` log
3. Check status bar shows "$(plug) Pieces" (green) if PiecesOS is running
4. Verify events appear: `curl http://localhost:$(cat ~/Library/com.pieces.os/production/Config/.port.txt)/workstream_events | jq '.iterable | length'`

- [ ] **Step 4: Test offline queueing**

1. Stop PiecesOS (or set port override to a bad port)
2. Open files → status bar should show queued count
3. Restart PiecesOS → queue should drain

- [ ] **Step 5: Commit launch config if created**

```bash
git add packages/ltm-injector/.vscode/
git commit -m "chore(ltm-injector): add Extension Development Host launch config"
```

---

## Task 21: Package and Final Verification

**Files:**
- Create: `packages/ltm-injector/README.md`
- Create: `packages/ltm-injector/CHANGELOG.md`
- Create: `packages/ltm-injector/LICENSE`

- [ ] **Step 1: Create extension README**

Create `packages/ltm-injector/README.md`:

```markdown
# Pieces LTM Injector

Injects IDE workstream events into PiecesOS Long-Term Memory on every interaction.

## Prerequisites

- [PiecesOS](https://docs.pieces.app/products/desktop/download) must be installed and running
- LTM must be enabled in PiecesOS settings

## Features

- **File events**: open, close
- **Tab events**: switch, with language and workspace context
- **Focus events**: application enter/leave, periodic check-in heartbeat
- **Clipboard**: copy events with content capture (truncated to 500 chars)
- **Git**: branch switches, new commits (requires VS Code git extension)
- **Terminal**: command activity (throttled to 1 event per 10s per terminal)
- **Debug**: session start/end
- **Claude Code**: real-time JSONL session parsing, file path extraction

## Settings

All settings are under `pieces-ltm-injector.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master on/off |
| `portOverride` | `null` | Skip port auto-discovery |
| `heartbeatInterval` | `30000` | Port re-probe interval (ms) |
| `checkInInterval` | `60000` | Check-in heartbeat interval (ms) |
| `queueSize` | `500` | Max queued events when disconnected |
| `debugLogging` | `false` | Log every event to output channel |
| `enableClaudeCodeIntegration` | `true` | Watch Claude Code sessions |
| `enableGitEvents` | `true` | Git branch/commit events |
| `enableTerminalEvents` | `true` | Terminal command events |

## Offline Resilience

When PiecesOS is unreachable, events are queued in a ring buffer (default 500). Events are automatically flushed when the connection is restored. The status bar shows queue depth.
```

- [ ] **Step 2: Create CHANGELOG and LICENSE**

Create `packages/ltm-injector/CHANGELOG.md`:

```markdown
# Changelog

## 0.1.0

- Initial release
- Core handlers: file open/close, tab switch, focus, clipboard copy
- Extended handlers: git, terminal, debug, Claude Code
- Offline event queueing with auto-drain
- Status bar connection indicator
```

Create `packages/ltm-injector/LICENSE`:

```
MIT License

Copyright (c) 2026 Joe Black

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Package the extension**

```bash
pnpm --filter @pieces-dev/core build
pnpm --filter @pieces-dev/ltm-injector build
cd packages/ltm-injector && npx vsce package --no-dependencies
```

Expected: Produces a `.vsix` file. Verify it lists expected files with `npx vsce ls --no-dependencies`.

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: All tests across all packages PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ltm-injector/README.md packages/ltm-injector/CHANGELOG.md packages/ltm-injector/LICENSE
git commit -m "docs(ltm-injector): add README, CHANGELOG, LICENSE for marketplace publishing"
```

---

## Verification

### Gap Reconstructor
1. `gap-reconstruct detect --since 30d` — verify it finds known gaps (or reports none if LTM is current)
2. `gap-reconstruct run --from 2026-05-26T02:43:00Z --to 2026-06-04T08:52:00Z --dry-run` — verify event counts and distribution
3. Run for a single day: `run --from 2026-05-27T00:00:00Z --to 2026-05-28T00:00:00Z --sources claude` — verify events appear in `GET /workstream_events`
4. Re-run same window — should see idempotency warning
5. `gap-reconstruct run --all-gaps --since 30d --dry-run` — verify it finds gaps and shows dry-run for each
6. Check Pieces Desktop Timeline for backfilled day

### VS Code Extension
1. `pnpm --filter @pieces-dev/ltm-injector build` succeeds with zero errors
2. Extension Host: open file → event appears in PiecesOS
3. Extension Host: switch tabs → tab_switch event
4. Output channel shows connection and event logs
5. Kill PiecesOS → events queue → restart → queue drains
6. `npx vsce package --no-dependencies` produces valid `.vsix`

### End-to-End
1. After gap backfill + extension running, query: `ask_pieces_ltm("What was I working on May 27?")` — should return relevant context
2. Pieces Desktop Timeline shows continuous coverage
