import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ProjectEntry } from './types';
import {
  findProjectFiles,
  invalidateCsprojCache,
  pickWorkspaceRoot,
  revealInExplorer,
  resolveDotnetWorkspace,
  spawnDotnet,
} from './utils';
import { normalizePathKey } from './pure-utils';

export async function manageSolution(): Promise<void> {
  const actions: Array<{ label: string; description: string; action: string }> = [
    { label: '$(file-directory)  New Solution…', description: 'dotnet new sln', action: 'new' },
    { label: '$(add)  Add Project(s)…', description: 'dotnet sln add', action: 'add' },
    { label: '$(trash)  Remove Project(s)…', description: 'dotnet sln remove', action: 'remove' },
    { label: '$(list-unordered)  List Projects', description: 'show the projects in the solution', action: 'list' },
    { label: '$(sync)  Migrate .sln → .slnx', description: 'dotnet sln migrate', action: 'migrate' },
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: 'Select solution action',
    title: '.NET: Manage Solution',
  });
  if (!picked) {
    return;
  }
  switch (picked.action) {
    case 'new':
      await newSolution();
      return;
    case 'add':
      await addProjectsToSolution();
      return;
    case 'remove':
      await removeProjectsFromSolution();
      return;
    case 'list':
      await listSolutionProjects();
      return;
    case 'migrate':
      await migrateSolutionToSlnx();
      return;
  }
}

async function requireWorkspace(): Promise<Awaited<ReturnType<typeof resolveDotnetWorkspace>>> {
  return resolveDotnetWorkspace();
}

async function newSolution(): Promise<void> {
  const root = await pickWorkspaceRoot();
  if (!root) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Solution name',
    value: path.basename(root),
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'Name cannot be empty';
      }
      if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        return 'Name may only contain letters, digits, ".", "_" and "-"';
      }
      return null;
    },
  });
  if (!name) {
    return;
  }
  const formats: Array<{ label: string; description: string; format: string }> = [
    { label: '$(file)  .sln', description: 'classic solution format', format: 'sln' },
    { label: '$(file-code)  .slnx', description: 'XML solution format (.NET 9+ SDK)', format: 'slnx' },
  ];
  const pickedFormat = await vscode.window.showQuickPick(formats, {
    placeHolder: 'Select solution format',
  });
  if (!pickedFormat) {
    return;
  }
  const args = ['new', 'sln', '-n', name, ...(pickedFormat.format === 'slnx' ? ['--format', 'slnx'] : [])];
  const result = await spawnDotnet(args, root, { reveal: true });
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(`Solution ${name} created.`);
  } else {
    vscode.window.showErrorMessage('dotnet new sln failed. See the DotNet CLI Plus: dotnet output.');
  }
}

async function addProjectsToSolution(): Promise<void> {
  const ws = await requireWorkspace();
  if (!ws) {
    return;
  }
  if (!ws.slnPath) {
    vscode.window.showWarningMessage('No solution file found in the workspace. Create one first (New Solution…).');
    return;
  }
  const existing = new Set(ws.projects.map((p) => normalizePathKey(p.csprojPath)));
  const candidates = (await findProjectFiles(ws.root)).filter((p) => !existing.has(normalizePathKey(p)));

  if (candidates.length === 0) {
    vscode.window.showInformationMessage('All discovered projects are already in the solution.');
    return;
  }

  const items = candidates.map((csproj) => ({
    label: path.basename(csproj, path.extname(csproj)),
    description: path.relative(ws.root, csproj),
    picked: false,
    csproj,
  }));
  const quickPick = vscode.window.createQuickPick<(typeof items)[number]>();
  quickPick.canSelectMany = true;
  quickPick.title = `Add projects to ${path.basename(ws.slnPath)}`;
  quickPick.placeholder = 'Select projects to add';
  quickPick.items = items;
  const selected = await new Promise<Array<(typeof items)[number]>>((resolve) => {
    quickPick.onDidAccept(() => {
      resolve([...quickPick.selectedItems]);
      quickPick.hide();
    });
    quickPick.onDidHide(() => resolve([]));
    quickPick.show();
  });
  quickPick.dispose();
  if (selected.length === 0) {
    return;
  }

  const solutionFolder = await vscode.window.showInputBox({
    prompt: 'Solution folder (optional)',
    placeHolder: 'e.g. src — leave empty to add to the solution root',
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return null;
      }
      if (/[\\/]|\.\./.test(value)) {
        return 'Solution folder name cannot contain path separators';
      }
      return null;
    },
  });
  if (solutionFolder === undefined) {
    return;
  }

  const args = [
    'sln',
    ws.slnPath,
    'add',
    ...selected.map((s) => s.csproj),
    ...(solutionFolder.trim().length > 0 ? ['--solution-folder', solutionFolder.trim()] : []),
  ];
  const result = await spawnDotnet(args, ws.root, { reveal: true });
  invalidateCsprojCache();
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(
      `Added ${selected.length} project${selected.length !== 1 ? 's' : ''} to ${path.basename(ws.slnPath)}.`,
    );
  } else {
    vscode.window.showErrorMessage('dotnet sln add failed. See the DotNet CLI Plus: dotnet output.');
  }
}

async function removeProjectsFromSolution(): Promise<void> {
  const ws = await requireWorkspace();
  if (!ws) {
    return;
  }
  if (!ws.slnPath) {
    vscode.window.showWarningMessage('No solution file found in the workspace.');
    return;
  }
  if (ws.projects.length === 0) {
    vscode.window.showInformationMessage('The solution has no projects.');
    return;
  }

  const items = ws.projects.map((p) => ({
    label: p.name,
    description: path.relative(ws.root, p.csprojPath),
    picked: false,
    entry: p,
  }));
  const quickPick = vscode.window.createQuickPick<(typeof items)[number]>();
  quickPick.canSelectMany = true;
  quickPick.title = `Remove projects from ${path.basename(ws.slnPath)}`;
  quickPick.placeholder = 'Select projects to remove';
  quickPick.items = items;
  const selected = await new Promise<Array<(typeof items)[number]>>((resolve) => {
    quickPick.onDidAccept(() => {
      resolve([...quickPick.selectedItems]);
      quickPick.hide();
    });
    quickPick.onDidHide(() => resolve([]));
    quickPick.show();
  });
  quickPick.dispose();
  if (selected.length === 0) {
    return;
  }

  const result = await spawnDotnet(
    ['sln', ws.slnPath, 'remove', ...selected.map((s) => s.entry.csprojPath)],
    ws.root,
    { reveal: true },
  );
  invalidateCsprojCache();
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(
      `Removed ${selected.length} project${selected.length !== 1 ? 's' : ''} from ${path.basename(ws.slnPath)}.`,
    );
  } else {
    vscode.window.showErrorMessage('dotnet sln remove failed. See the DotNet CLI Plus: dotnet output.');
  }
}

async function listSolutionProjects(): Promise<void> {
  const ws = await requireWorkspace();
  if (!ws) {
    return;
  }
  const header = ws.slnPath ? path.basename(ws.slnPath) : 'Discovered projects (no solution file)';
  const items: Array<vscode.QuickPickItem & { entry: ProjectEntry }> = ws.projects.map((p) => ({
    label: p.name,
    description: `${p.csproj?.targetFrameworks.join(', ') ?? '—'}  ·  ${path.relative(ws.root, p.csprojPath)}`,
    entry: p,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${ws.projects.length} project${ws.projects.length !== 1 ? 's' : ''}`,
    title: header,
    matchOnDescription: true,
  });
  if (picked) {
    revealInExplorer(vscode.Uri.file(picked.entry.csprojPath));
  }
}

async function migrateSolutionToSlnx(): Promise<void> {
  const ws = await requireWorkspace();
  if (!ws) {
    return;
  }
  if (!ws.slnPath) {
    vscode.window.showWarningMessage('No solution file found in the workspace.');
    return;
  }
  if (!ws.slnPath.toLowerCase().endsWith('.sln')) {
    vscode.window.showInformationMessage('The workspace solution is already in .slnx format.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Create an .slnx version of ${path.basename(ws.slnPath)}? The .sln file is kept.`,
    { modal: true },
    'Migrate',
  );
  if (confirm !== 'Migrate') {
    return;
  }
  const result = await spawnDotnet(['sln', ws.slnPath, 'migrate'], ws.root, { reveal: true });
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage('Solution migrated to .slnx.');
  } else {
    vscode.window.showErrorMessage(
      'dotnet sln migrate failed (requires .NET 9+ SDK). See the DotNet CLI Plus: dotnet output.',
    );
  }
}

export async function findRootSolutionFile(root: string): Promise<string | null> {
  try {
    const entries = await fs.promises.readdir(root);
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (lower.endsWith('.sln') || lower.endsWith('.slnx')) {
        return path.join(root, entry);
      }
    }
  } catch {
    return null;
  }
  return null;
}
