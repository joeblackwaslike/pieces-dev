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
