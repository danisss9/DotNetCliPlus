import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseNuGetSourcesList, validateNuGetSourceName } from './pure-utils';
import { pickWorkspaceRoot, spawnDotnet } from './utils';
import { nugetOutput } from './state';

const CREATABLE_CONFIGS: Array<{ file: string; shortName: string; description: string }> = [
  { file: '.gitignore', shortName: 'gitignore', description: 'dotnet new gitignore' },
  { file: '.editorconfig', shortName: 'editorconfig', description: 'dotnet new editorconfig' },
  { file: 'global.json', shortName: 'globaljson', description: 'dotnet new globaljson — pin the SDK version' },
  { file: 'nuget.config', shortName: 'nugetconfig', description: 'dotnet new nugetconfig' },
];

const OPENABLE_CONFIGS = ['Directory.Build.props', 'Directory.Packages.props'];

export async function manageConfigs(): Promise<void> {
  const root = await pickWorkspaceRoot();
  if (!root) {
    return;
  }

  const items: Array<vscode.QuickPickItem & { action?: { kind: 'open' | 'create' | 'sources'; file?: string; shortName?: string } }> = [];

  for (const config of CREATABLE_CONFIGS) {
    const filePath = path.join(root, config.file);
    if (fs.existsSync(filePath)) {
      items.push({ label: `$(file)  Open ${config.file}`, description: 'exists', action: { kind: 'open', file: filePath } });
    } else {
      items.push({ label: `$(new-file)  Create ${config.file}`, description: config.description, action: { kind: 'create', file: config.file, shortName: config.shortName } });
    }
  }
  for (const file of OPENABLE_CONFIGS) {
    const filePath = path.join(root, file);
    if (fs.existsSync(filePath)) {
      items.push({ label: `$(file)  Open ${file}`, description: 'exists', action: { kind: 'open', file: filePath } });
    }
  }
  items.push({ label: `$(globe)  Manage NuGet Sources…`, description: 'list, add and remove package sources', action: { kind: 'sources' } });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Open or create a config file',
    title: '.NET: Manage Config Files',
  });
  if (!picked?.action) {
    return;
  }
  switch (picked.action.kind) {
    case 'open':
      await openFile(picked.action.file!);
      return;
    case 'create':
      await createConfig(root, picked.action.shortName!, picked.action.file!);
      return;
    case 'sources':
      await manageNuGetSources(root);
      return;
  }
}

async function openFile(filePath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  void vscode.window.showTextDocument(doc);
}

async function createConfig(root: string, shortName: string, fileName: string): Promise<void> {
  const result = await spawnDotnet(['new', shortName], root, { reveal: true });
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(`dotnet new ${shortName} failed. See the DotNet CLI Plus: dotnet output.`);
    return;
  }
  const filePath = path.join(root, fileName);
  if (fs.existsSync(filePath)) {
    await openFile(filePath);
  }
  vscode.window.showInformationMessage(`${fileName} created.`);
}

interface SourceItem extends vscode.QuickPickItem {
  source?: { name: string; url: string; enabled: boolean };
}

async function listSources(root: string): Promise<SourceItem[]> {
  const result = await spawnDotnet(['nuget', 'list', 'source'], root, { channel: nugetOutput, timeoutMs: 30000 });
  return parseNuGetSourcesList(result.stdout).map((source) => ({
    label: `${source.enabled ? '$(circle-filled)' : '$(circle-outline)'}  ${source.name}`,
    description: source.url,
    source,
  }));
}

async function manageNuGetSources(root: string): Promise<void> {
  const sources = await listSources(root);
  const items: SourceItem[] = [
    ...sources,
    { label: '$(add)  Add source…' },
    { label: '$(trash)  Remove source…' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'NuGet package sources',
    title: 'Manage NuGet Sources',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  if (picked.source) {
    await vscode.env.clipboard.writeText(picked.source.url);
    vscode.window.showInformationMessage(`Copied ${picked.source.url} to clipboard.`);
    return;
  }
  if (picked.label.includes('Add source')) {
    await addSource(root);
    return;
  }
  if (picked.label.includes('Remove source')) {
    await removeSource(root);
    return;
  }
}

async function addSource(root: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Source name',
    validateInput: (value) => validateNuGetSourceName(value),
  });
  if (!name) {
    return;
  }
  const url = await vscode.window.showInputBox({
    prompt: 'Source URL',
    placeHolder: 'https://api.nuget.org/v3/index.json',
  });
  if (!url || !/^https?:\/\//.test(url.trim())) {
    if (url !== undefined) {
      vscode.window.showErrorMessage('Source URL must start with http:// or https://');
    }
    return;
  }
  const result = await spawnDotnet(['nuget', 'add', 'source', url.trim(), '--name', name.trim()], root, {
    channel: nugetOutput,
    reveal: true,
  });
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(`Source "${name.trim()}" added.`);
  } else {
    vscode.window.showErrorMessage('dotnet nuget add source failed. See the DotNet CLI Plus: nuget output.');
  }
}

async function removeSource(root: string): Promise<void> {
  const sources = await listSources(root);
  const removable = sources.filter((s) => s.source);
  if (removable.length === 0) {
    vscode.window.showInformationMessage('No configured NuGet sources found.');
    return;
  }
  const picked = await vscode.window.showQuickPick(removable, {
    placeHolder: 'Select source to remove',
    title: 'Remove NuGet source',
    matchOnDescription: true,
  });
  if (!picked?.source) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Remove source "${picked.source.name}"?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') {
    return;
  }
  const result = await spawnDotnet(['nuget', 'remove', 'source', picked.source.name], root, {
    channel: nugetOutput,
    reveal: true,
  });
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(`Source "${picked.source.name}" removed.`);
  } else {
    vscode.window.showErrorMessage('dotnet nuget remove source failed. See the DotNet CLI Plus: nuget output.');
  }
}
