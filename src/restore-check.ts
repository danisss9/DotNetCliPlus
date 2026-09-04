import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionContext, logDiagnostic, restoreCheckTimers } from './state';
import { findProjectFiles, runInTerminal, buildDotnetTerminalCommand } from './utils';
import { escapeShellArg } from './pure-utils';
import { findRootSolutionFile } from './solutions';

interface RootWatch {
  watcher: fs.FSWatcher | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const rootWatchers = new Map<string, RootWatch>();

async function computeSignature(root: string): Promise<string> {
  const files: string[] = [];
  const sln = await findRootSolutionFile(root);
  if (sln) {
    files.push(sln);
  }
  for (const csproj of await findProjectFiles(root)) {
    files.push(csproj);
  }
  files.sort();
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.promises.stat(file);
      parts.push(`${file}:${stat.mtimeMs}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return parts.join('|');
}

async function storeSignature(root: string): Promise<void> {
  const signature = await computeSignature(root);
  await getExtensionContext().workspaceState.update(`restoreSignature.${root}`, signature);
}

async function onBranchSwitch(root: string): Promise<void> {
  try {
    const previous = getExtensionContext().workspaceState.get<string>(`restoreSignature.${root}`);
    const current = await computeSignature(root);
    if (previous && previous !== current) {
      const action = await vscode.window.showInformationMessage(
        'Solution or project files changed (git branch switch). Restore NuGet packages?',
        'Restore',
      );
      if (action === 'Restore') {
        await restoreForRoot(root);
      }
    }
    await getExtensionContext().workspaceState.update(`restoreSignature.${root}`, current);
  } catch (err) {
    logDiagnostic(`Restore check failed for ${root}: ${err}`);
  }
}

async function restoreForRoot(root: string): Promise<void> {
  const sln = await findRootSolutionFile(root);
  if (sln) {
    await runInTerminal(
      `dotnet restore (${path.basename(sln)})`,
      buildDotnetTerminalCommand(['restore', sln]),
      root,
      { successMessage: 'Restore completed.', retryLabel: 'Retry' },
    );
    return;
  }
  const csprojs = await findProjectFiles(root);
  if (csprojs.length === 0) {
    return;
  }
  const chained = csprojs.map((p) => `dotnet restore ${escapeShellArg(p)}`).join(' && ');
  await runInTerminal('dotnet restore (all projects)', chained, root, {
    successMessage: 'Restore completed.',
    retryLabel: 'Retry',
  });
}

export function setupRestoreCheck(context: vscode.ExtensionContext, root: string): void {
  const enabled = vscode.workspace.getConfiguration('dotnetCliPlus').get<boolean>('restoreCheck.enabled', true);
  if (!enabled) {
    return;
  }
  const headPath = path.join(root, '.git', 'HEAD');
  if (!fs.existsSync(headPath)) {
    return;
  }
  teardownRestoreCheck(root);

  const state: RootWatch = { watcher: undefined, timer: undefined };
  rootWatchers.set(root, state);

  void storeSignature(root);

  try {
    state.watcher = fs.watch(headPath, () => {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => {
        restoreCheckTimers.delete(root);
        void onBranchSwitch(root);
      }, 2000);
      if (state.timer) {
        restoreCheckTimers.set(root, state.timer);
      }
    });
    state.watcher.on('error', (err) => {
      logDiagnostic(`Restore check watcher error for ${root}: ${err}`);
    });
  } catch (err) {
    logDiagnostic(`Could not watch .git/HEAD for ${root}: ${err}`);
  }
}

export function teardownRestoreCheck(root: string): void {
  const state = rootWatchers.get(root);
  if (!state) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
    restoreCheckTimers.delete(root);
  }
  state.watcher?.close();
  rootWatchers.delete(root);
}

export function teardownAllRestoreChecks(): void {
  for (const root of [...rootWatchers.keys()]) {
    teardownRestoreCheck(root);
  }
}
