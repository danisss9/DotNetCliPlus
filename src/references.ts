import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ProjectEntry } from './types';
import {
  invalidateCsprojCache,
  pickProjectWithCurrentFile,
  resolveDotnetWorkspace,
  revealInExplorer,
  spawnDotnet,
} from './utils';
import { normalizePathKey } from './pure-utils';

function resolveReference(csprojPath: string, reference: string): string {
  return path.resolve(path.dirname(csprojPath), reference);
}

async function spawnSln(args: string[], root: string, successMessage: string): Promise<void> {
  const result = await spawnDotnet(args, root, { reveal: true });
  invalidateCsprojCache();
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(successMessage);
  } else {
    vscode.window.showErrorMessage('dotnet command failed. See the DotNet CLI Plus: dotnet output.');
  }
}

export async function addProjectReference(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target = await pickProjectWithCurrentFile(ws.projects, '.NET: Add Project Reference (to…)', {
    commandKey: 'refAdd',
  });
  if (!target) {
    return;
  }

  const targetKey = normalizePathKey(target.csprojPath);
  const others = ws.projects.filter((p) => normalizePathKey(p.csprojPath) !== targetKey);
  if (others.length === 0) {
    vscode.window.showInformationMessage('Only one project in the workspace — nothing to reference.');
    return;
  }

  const items = others.map((p) => {
    const referencesTarget = (p.csproj?.projectReferences ?? []).some(
      (r) => normalizePathKey(resolveReference(p.csprojPath, r)) === targetKey,
    );
    return {
      label: p.name,
      description: `${p.csproj?.targetFrameworks.join(', ') ?? '—'}  ·  ${path.relative(ws.root, p.csprojPath)}`,
      entry: p,
      disabled: referencesTarget,
    };
  });
  const quickPick = vscode.window.createQuickPick<(typeof items)[number]>();
  quickPick.canSelectMany = true;
  quickPick.title = `Add project references to ${target.name}`;
  quickPick.placeholder = 'Select projects to reference';
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

  await spawnSln(
    ['add', target.csprojPath, 'reference', ...selected.map((s) => s.entry.csprojPath)],
    ws.root,
    `Added ${selected.length} reference${selected.length !== 1 ? 's' : ''} to ${target.name}.`,
  );
}

export async function removeProjectReference(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target = await pickProjectWithCurrentFile(ws.projects, '.NET: Remove Project Reference (from…)', {
    commandKey: 'refRemove',
  });
  if (!target) {
    return;
  }
  const references = (target.csproj?.projectReferences ?? []).map((r) => resolveReference(target.csprojPath, r));
  if (references.length === 0) {
    vscode.window.showInformationMessage(`${target.name} has no project references.`);
    return;
  }

  const items = references.map((r) => ({
    label: path.basename(path.dirname(r)) || path.basename(r),
    description: path.relative(ws.root, r),
    picked: false,
    refPath: r,
  }));
  const quickPick = vscode.window.createQuickPick<(typeof items)[number]>();
  quickPick.canSelectMany = true;
  quickPick.title = `Remove project references from ${target.name}`;
  quickPick.placeholder = 'Select references to remove';
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

  await spawnSln(
    ['remove', target.csprojPath, 'reference', ...selected.map((s) => s.refPath)],
    ws.root,
    `Removed ${selected.length} reference${selected.length !== 1 ? 's' : ''} from ${target.name}.`,
  );
}

export async function listProjectReferences(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target: ProjectEntry | null = await pickProjectWithCurrentFile(ws.projects, '.NET: List Project References', {
    commandKey: 'refList',
  });
  if (!target) {
    return;
  }
  const references = (target.csproj?.projectReferences ?? []).map((r) => resolveReference(target.csprojPath, r));
  if (references.length === 0) {
    vscode.window.showInformationMessage(`${target.name} has no project references.`);
    return;
  }
  const items = references.map((r) => ({
    label: path.basename(r, path.extname(r)),
    description: path.relative(ws.root, r),
    refPath: r,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${references.length} reference${references.length !== 1 ? 's' : ''}`,
    title: `Project references of ${target.name}`,
    matchOnDescription: true,
  });
  if (picked && fs.existsSync(picked.refPath)) {
    revealInExplorer(vscode.Uri.file(picked.refPath));
  }
}
