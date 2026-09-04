import * as vscode from 'vscode';
import type { BuildTarget, TerminalCommandState } from './types';
import {
  buildDotnetTerminalCommand,
  pickBuildTarget,
  pickProjectWithCurrentFile,
  resolveDotnetWorkspace,
  runInTerminal,
  targetLabel,
  targetPath,
} from './utils';
import {
  clearTrackedTerminalState,
  extensionTerminals,
  getTrackedTerminalState,
  loadPersistedTerminalEntries,
} from './state';
import { configFlag } from './pure-utils';

function buildConfigurationArgs(): string[] {
  const config = vscode.workspace.getConfiguration('dotnetCliPlus').get<string>('build.configuration', 'default');
  return configFlag(config);
}

export async function restorePackages(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target = await pickBuildTarget(ws, '.NET: Restore', {
    allowSolution: true,
    commandKey: 'restore',
  });
  if (!target) {
    return;
  }
  await runInTerminal(
    `dotnet restore (${targetLabel(target)})`,
    buildDotnetTerminalCommand(['restore', targetPath(target)]),
    ws.root,
    { successMessage: 'Restore completed.', retryLabel: 'Retry' },
  );
}

export async function buildTarget(rebuild = false): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target = await pickBuildTarget(ws, rebuild ? '.NET: Rebuild' : '.NET: Build', {
    allowSolution: true,
    commandKey: 'build',
  });
  if (!target) {
    return;
  }
  const args = [
    'build',
    targetPath(target),
    ...(rebuild ? ['--no-incremental'] : []),
    ...buildConfigurationArgs(),
  ];
  await runInTerminal(
    `dotnet ${rebuild ? 'rebuild' : 'build'} (${targetLabel(target)})`,
    buildDotnetTerminalCommand(args),
    ws.root,
    { successMessage: 'Build succeeded.', retryLabel: 'Retry' },
  );
}

export async function cleanTarget(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target = await pickBuildTarget(ws, '.NET: Clean', {
    allowSolution: true,
    commandKey: 'clean',
  });
  if (!target) {
    return;
  }
  await runInTerminal(
    `dotnet clean (${targetLabel(target)})`,
    buildDotnetTerminalCommand(['clean', targetPath(target)]),
    ws.root,
    { successMessage: 'Clean completed.', retryLabel: 'Retry' },
  );
}

export async function runProject(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const project = await pickProjectWithCurrentFile(ws.projects, '.NET: Run Project', {
    runnableOnly: true,
    commandKey: 'run',
  });
  if (!project) {
    return;
  }
  const config = vscode.workspace.getConfiguration('dotnetCliPlus').get<string>('run.configuration', 'default');
  const args = ['run', '--project', project.csprojPath, ...configFlag(config)];
  await runInTerminal(
    `dotnet run (${project.name})`,
    buildDotnetTerminalCommand(args),
    ws.root,
    { longRunning: true },
  );
}

export async function watchProject(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const project = await pickProjectWithCurrentFile(ws.projects, '.NET: Watch Project', {
    commandKey: 'watch',
  });
  if (!project) {
    return;
  }
  const modes: Array<{ label: string; description: string; mode: string }> = [
    { label: '$(play)  run', description: 'dotnet watch run — hot reload while running', mode: 'run' },
    { label: '$(eye)  build', description: 'dotnet watch build — rebuild on change', mode: 'build' },
    { label: '$(beaker)  test', description: 'dotnet watch test — re-run tests on change', mode: 'test' },
  ];
  const picked = await vscode.window.showQuickPick(modes, {
    placeHolder: 'Select watch mode',
    title: `dotnet watch (${project.name})`,
  });
  if (!picked) {
    return;
  }
  const args = ['watch', '--project', project.csprojPath, picked.mode];
  await runInTerminal(
    `dotnet watch (${project.name})`,
    buildDotnetTerminalCommand(args),
    ws.root,
    { longRunning: true },
  );
}

export async function testProject(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target = await pickBuildTarget(ws, '.NET: Test', {
    allowSolution: true,
    testOnly: true,
    commandKey: 'test',
  });
  if (!target) {
    return;
  }
  const filter = await vscode.window.showInputBox({
    prompt: 'Filter tests (empty = run all)',
    placeHolder: 'FullyQualifiedName~MyNamespace.MyTests  ·  supports | and & (vstest syntax)',
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return null;
      }
      if (/["`]/.test(value)) {
        return 'Filter cannot contain double quotes or backticks';
      }
      return null;
    },
  });
  if (filter === undefined) {
    return;
  }
  const noBuild = vscode.workspace.getConfiguration('dotnetCliPlus').get<boolean>('test.noBuild', false);
  const args = [
    'test',
    targetPath(target),
    ...(filter.trim().length > 0 ? ['--filter', filter.trim()] : []),
    ...(noBuild ? ['--no-build'] : []),
  ];
  await runInTerminal(
    `dotnet test (${targetLabel(target)})`,
    buildDotnetTerminalCommand(args),
    ws.root,
    { successMessage: 'Tests passed.', retryLabel: 'Retry' },
  );
}

type FormatMode = 'check' | 'apply';

async function runFormat(
  root: string,
  target: BuildTarget,
  subcommand: string,
  mode: FormatMode,
): Promise<void> {
  const args = [
    'format',
    ...(subcommand !== 'all' ? [subcommand] : []),
    targetPath(target),
    ...(mode === 'check' ? ['--verify-no-changes'] : []),
  ];
  await runInTerminal(
    `dotnet format (${targetLabel(target)})`,
    buildDotnetTerminalCommand(args),
    root,
    mode === 'check'
      ? {
          successMessage: 'Format check passed — no changes needed.',
          retryLabel: 'Apply Format',
          onRetry: () => void runFormat(root, target, subcommand, 'apply'),
        }
      : { successMessage: 'Formatting applied.', retryLabel: 'Retry' },
  );
}

export async function formatProject(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target = await pickBuildTarget(ws, '.NET: Format', {
    allowSolution: true,
    commandKey: 'format',
  });
  if (!target) {
    return;
  }
  const subcommands: Array<{ label: string; description: string; sub: string }> = [
    { label: '$(check)  All', description: 'whitespace, code style and analyzers', sub: 'all' },
    { label: '$(symbol-ruler)  Whitespace', description: 'formatting only (fast)', sub: 'whitespace' },
    { label: '$(symbol-keyword)  Style', description: 'code style (.editorconfig)', sub: 'style' },
    { label: '$(lightbulb)  Analyzers', description: 'third-party analyzers', sub: 'analyzers' },
  ];
  const pickedSub = await vscode.window.showQuickPick(subcommands, {
    placeHolder: 'Select what to format',
    title: `dotnet format (${targetLabel(target)})`,
  });
  if (!pickedSub) {
    return;
  }
  const modes: Array<{ label: string; description: string; mode: FormatMode }> = [
    { label: '$(search)  Check only', description: 'report issues without changing files (--verify-no-changes)', mode: 'check' },
    { label: '$(edit)  Apply', description: 'format files in place', mode: 'apply' },
  ];
  const pickedMode = await vscode.window.showQuickPick(modes, {
    placeHolder: 'Select mode',
    title: 'dotnet format',
  });
  if (!pickedMode) {
    return;
  }
  await runFormat(ws.root, target, pickedSub.sub, pickedMode.mode);
}

interface TerminalItem extends vscode.QuickPickItem {
  terminal: vscode.Terminal;
}

const STATE_ORDER: Record<string, number> = {
  errored: 0,
  killed: 1,
  terminated: 2,
  running: 3,
};

function terminalStateIcon(state: TerminalCommandState): string {
  switch (state) {
    case 'running':
      return '$(play)';
    case 'errored':
      return '$(error)';
    case 'killed':
      return '$(circle-slash)';
    default:
      return '$(check)';
  }
}

export async function clearFinishedTerminals(): Promise<void> {
  const terminals = [...extensionTerminals];
  if (terminals.length === 0) {
    vscode.window.showInformationMessage('No DotNet CLI Plus terminals.');
    return;
  }
  const persisted = loadPersistedTerminalEntries();
  const items: TerminalItem[] = terminals.map((terminal) => {
    const state: TerminalCommandState = getTrackedTerminalState(terminal) ?? 'terminated';
    return {
      label: `${terminalStateIcon(state)}  ${terminal.name}`,
      description: persisted[terminal.name]?.command ?? '',
      terminal,
    };
  });
  items.sort((a, b) => {
    const stateA = getTrackedTerminalState(a.terminal) ?? 'terminated';
    const stateB = getTrackedTerminalState(b.terminal) ?? 'terminated';
    return (STATE_ORDER[stateA] ?? 2) - (STATE_ORDER[stateB] ?? 2) || a.label.localeCompare(b.label);
  });

  const quickPick = vscode.window.createQuickPick<TerminalItem>();
  quickPick.canSelectMany = true;
  quickPick.title = 'Close terminals (finished terminals are pre-selected)';
  quickPick.placeholder = 'Select terminals to close';
  quickPick.items = items;
  quickPick.selectedItems = items.filter(
    (item) => (getTrackedTerminalState(item.terminal) ?? 'terminated') !== 'running',
  );

  const toClose = await new Promise<TerminalItem[]>((resolve) => {
    quickPick.onDidAccept(() => {
      resolve([...quickPick.selectedItems]);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      resolve([]);
    });
    quickPick.show();
  });
  quickPick.dispose();

  for (const item of toClose) {
    item.terminal.dispose();
    clearTrackedTerminalState(item.terminal);
  }
  if (toClose.length > 0) {
    vscode.window.showInformationMessage(`Closed ${toClose.length} terminal${toClose.length !== 1 ? 's' : ''}.`);
  }
}
