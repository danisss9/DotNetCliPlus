import * as vscode from 'vscode';
import type { NuGetSearchResult, ProjectEntry, ProjectOutdatedPackages, ProjectTarget } from './types';
import {
  extractJsonObject,
  parsePackageListOutdatedJson,
  parsePackageSearchJson,
  validatePackageId,
} from './pure-utils';
import { invalidateCsprojCache, resolveDotnetWorkspace, spawnDotnet, pickProjectWithCurrentFile } from './utils';
import { nugetOutput } from './state';

export async function manageNuGetPackages(target?: ProjectTarget): Promise<void> {
  let root: string;
  let project: ProjectEntry;
  if (target) {
    root = target.root;
    project = target.entry;
  } else {
    const ws = await resolveDotnetWorkspace();
    if (!ws) {
      return;
    }
    const picked = await pickProjectWithCurrentFile(ws.projects, 'NuGet: Manage Packages', {
      commandKey: 'nuget',
    });
    if (!picked) {
      return;
    }
    root = ws.root;
    project = picked;
  }

  const actions: Array<{ label: string; description: string; action: string }> = [
    { label: '$(add)  Add Package…', description: 'search nuget.org and add a package reference', action: 'add' },
    { label: '$(arrow-up)  Update Outdated Packages…', description: 'dotnet list package --outdated', action: 'update' },
    { label: '$(trash)  Remove Package…', description: 'dotnet remove package', action: 'remove' },
    { label: '$(list-unordered)  List Packages', description: 'show package references of this project', action: 'list' },
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: `${project.name} — select NuGet action`,
    title: 'NuGet: Manage Packages',
  });
  if (!picked) {
    return;
  }
  switch (picked.action) {
    case 'add':
      await addPackage(root, project);
      return;
    case 'update':
      await updateOutdatedPackages(root, project);
      return;
    case 'remove':
      await removePackage(root, project);
      return;
    case 'list':
      await listPackages(project);
      return;
  }
}

export async function packageSearch(root: string, term: string): Promise<NuGetSearchResult[]> {
  const prerelease = vscode.workspace.getConfiguration('dotnetCliPlus').get<boolean>('nuget.prerelease', false);
  const result = await spawnDotnet(
    ['package', 'search', term, '--take', '25', ...(prerelease ? ['--prerelease'] : []), '--format', 'json'],
    root,
    { channel: nugetOutput, timeoutMs: 30000 },
  );
  if (result.exitCode !== 0) {
    return [];
  }
  const jsonText = extractJsonObject(result.stdout);
  if (!jsonText) {
    return [];
  }
  try {
    return parsePackageSearchJson(JSON.parse(jsonText) as unknown);
  } catch {
    return [];
  }
}

export async function listOutdatedPackages(targetPath: string, root: string): Promise<ProjectOutdatedPackages[]> {
  const result = await spawnDotnet(['list', targetPath, 'package', '--outdated', '--format', 'json'], root, {
    channel: nugetOutput,
    timeoutMs: 120000,
  });
  const jsonText = extractJsonObject(result.stdout);
  if (!jsonText) {
    return [];
  }
  try {
    return parsePackageListOutdatedJson(JSON.parse(jsonText) as unknown);
  } catch {
    return [];
  }
}

async function addPackage(root: string, project: ProjectEntry): Promise<void> {
  const term = await vscode.window.showInputBox({
    prompt: 'Search NuGet packages (or enter an exact package id)',
    placeHolder: 'e.g. Newtonsoft.Json',
  });
  if (!term) {
    return;
  }

  let id: string;
  let latestVersion: string | undefined;

  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Searching NuGet for "${term}"…`, cancellable: false },
    async () => packageSearch(root, term.trim()),
  );

  if (results.length > 0) {
    const items = results.map((r) => ({
      label: r.id,
      description: `${r.latestVersion}${r.source ? `  ·  ${r.source}` : ''}`,
      result: r,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select package',
      title: `Add NuGet package to ${project.name}`,
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    id = picked.result.id;
    latestVersion = picked.result.latestVersion;
  } else {
    const manual = await vscode.window.showInputBox({
      prompt: 'No search results (search may be unavailable on this SDK). Enter the exact package id',
      value: term,
      validateInput: (value) => validatePackageId(value),
    });
    if (!manual) {
      return;
    }
    id = manual.trim();
  }

  let version: string | undefined = latestVersion;
  const versionItems: Array<{ label: string; description: string; version: string | undefined }> = [
    { label: `$(tag)  Latest${latestVersion ? ` (${latestVersion})` : ''}`, description: 'resolve the latest stable version', version: undefined },
    { label: '$(edit)  Specific version…', description: 'enter an exact version', version: '__custom__' },
  ];
  const versionPick = await vscode.window.showQuickPick(versionItems, { placeHolder: 'Select version' });
  if (!versionPick) {
    return;
  }
  if (versionPick.version === '__custom__') {
    const custom = await vscode.window.showInputBox({
      prompt: `Version of ${id}`,
      placeHolder: 'e.g. 13.0.3 or 8.0.0-rc.2.23479.6',
      validateInput: (value) => {
        if (value.trim().length === 0) {
          return 'Version cannot be empty';
        }
        if (!/^[\w.+-]+$/.test(value.trim())) {
          return 'Version contains invalid characters';
        }
        return null;
      },
    });
    if (!custom) {
      return;
    }
    version = custom.trim();
  } else {
    version = versionPick.version;
  }

  await addPackageToProject(root, project, id, version);
}

export async function addPackageToProject(
  root: string,
  project: ProjectEntry,
  id: string,
  version?: string,
): Promise<boolean> {
  const validation = validatePackageId(id);
  if (validation) {
    vscode.window.showErrorMessage(validation);
    return false;
  }
  const args = ['add', project.csprojPath, 'package', id, ...(version ? ['--version', version] : [])];
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Adding ${id} to ${project.name}…`, cancellable: false },
    async () => spawnDotnet(args, root, { channel: nugetOutput, reveal: true }),
  );
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(
      `Failed to add ${id}. See the DotNet CLI Plus: nuget output for details.`,
    );
    return false;
  }
  invalidateCsprojCache(project.csprojPath);
  vscode.window.showInformationMessage(`Added ${id}${version ? ` ${version}` : ''} to ${project.name}.`);
  return true;
}

async function updateOutdatedPackages(root: string, project: ProjectEntry): Promise<void> {
  const outdated = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Checking outdated packages for ${project.name}…`,
      cancellable: false,
    },
    async () => listOutdatedPackages(project.csprojPath, root),
  );
  const packages = outdated.find((o) => o.projectPath === project.csprojPath)?.packages ?? [];
  if (packages.length === 0) {
    vscode.window.showInformationMessage(`All packages in ${project.name} are up to date.`);
    return;
  }

  const items = packages.map((p) => ({
    label: p.id,
    description: `${p.current} → ${p.latest}`,
    picked: true,
    pkg: p,
  }));
  const quickPick = vscode.window.createQuickPick<(typeof items)[number]>();
  quickPick.canSelectMany = true;
  quickPick.title = `Update packages in ${project.name}`;
  quickPick.placeholder = 'Select packages to update';
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

  let updated = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Updating ${selected.length} package${selected.length !== 1 ? 's' : ''}…`,
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        progress.report({
          message: `${item.pkg.id} (${i + 1}/${selected.length})`,
          increment: (1 / selected.length) * 100,
        });
        const ok = await addPackageToProject(root, project, item.pkg.id, item.pkg.latest);
        if (ok) {
          updated++;
        }
      }
    },
  );
  if (updated > 0) {
    vscode.window.showInformationMessage(`Updated ${updated} package${updated !== 1 ? 's' : ''}.`);
  }
}

async function removePackage(root: string, project: ProjectEntry): Promise<void> {
  const references = project.csproj?.packageReferences ?? [];
  if (references.length === 0) {
    vscode.window.showInformationMessage(`${project.name} has no package references.`);
    return;
  }
  const items = references.map((r) => ({
    label: r.id,
    description: r.version ?? '',
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select package to remove',
    title: `Remove NuGet package from ${project.name}`,
  });
  if (!picked) {
    return;
  }
  const result = await spawnDotnet(['remove', project.csprojPath, 'package', picked.label], root, {
    channel: nugetOutput,
    reveal: true,
  });
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(`Failed to remove ${picked.label}. See the DotNet CLI Plus: nuget output.`);
    return;
  }
  invalidateCsprojCache(project.csprojPath);
  vscode.window.showInformationMessage(`Removed ${picked.label} from ${project.name}.`);
}

async function listPackages(project: ProjectEntry): Promise<void> {
  const references = project.csproj?.packageReferences ?? [];
  if (references.length === 0) {
    vscode.window.showInformationMessage(`${project.name} has no package references.`);
    return;
  }
  const items = references.map((r) => ({
    label: r.id,
    description: r.version ?? 'no version pinned',
  }));
  await vscode.window.showQuickPick(items, {
    placeHolder: `${references.length} package${references.length !== 1 ? 's' : ''}`,
    title: `Package references in ${project.name}`,
    matchOnDescription: true,
  });
}
