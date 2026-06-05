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
