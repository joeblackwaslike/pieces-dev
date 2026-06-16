import type { Application } from './types.js';

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
