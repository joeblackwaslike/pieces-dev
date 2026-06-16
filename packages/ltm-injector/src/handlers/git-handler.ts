import { checkInEvent, tabSwitchEvent, VSCODE_APP } from '@pieces-dev/core';
import * as vscode from 'vscode';
import type { EmitFn, LogFn } from '../emit.js';

type GitExtension = {
	getAPI(version: 1): GitAPI;
};

type GitAPI = {
	repositories: GitRepository[];
	onDidOpenRepository: vscode.Event<GitRepository>;
};

type GitRepository = {
	state: {
		HEAD?: { commit?: string; name?: string };
		onDidChange: vscode.Event<void>;
	};
};

export async function registerGitHandler(emit: EmitFn, log: LogFn): Promise<vscode.Disposable[]> {
	const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExt) {
		log('Git extension not available — skipping git handler');
		return [];
	}

	// `exports` is undefined until the extension is activated; awaiting activate()
	// guarantees getAPI is callable.
	if (!gitExt.isActive) {
		await gitExt.activate();
	}

	const git = gitExt.exports.getAPI(1);
	const disposables: vscode.Disposable[] = [];

	function watchRepo(repo: GitRepository): void {
		let lastCommit = repo.state.HEAD?.commit;
		let lastBranch = repo.state.HEAD?.name;

		const sub = repo.state.onDidChange(() => {
			const head = repo.state.HEAD;
			if (!head) return;

			const branch = head.name;
			const commit = head.commit;
			const branchChanged = !!branch && branch !== lastBranch;

			// A checkout that switches to a branch pointing at a different commit
			// changes `commit` too — don't misreport that as a new commit.
			if (commit && commit !== lastCommit && !branchChanged) {
				lastCommit = commit;
				emit(
					checkInEvent(VSCODE_APP, `Committed in ${branch ?? 'detached'}`),
					`git: new commit on ${branch}`,
				);
			}

			if (branchChanged && branch) {
				lastBranch = branch;
				// Adopt the new branch's commit so the next real commit is detected.
				lastCommit = commit;
				emit(
					tabSwitchEvent(VSCODE_APP, branch, undefined, undefined),
					`git: switched to branch ${branch}`,
				);
			}
		});

		disposables.push(sub);
	}

	for (const repo of git.repositories) {
		watchRepo(repo);
	}
	// Catch repositories opened after activation (new workspace folders, clones).
	disposables.push(git.onDidOpenRepository((repo) => watchRepo(repo)));

	return disposables;
}
