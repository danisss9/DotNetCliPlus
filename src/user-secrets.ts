import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProjectEntry } from './types';
import { invalidateCsprojCache, loadCsproj, pickProjectWithCurrentFile, resolveDotnetWorkspace, spawnDotnet } from './utils';

export async function manageUserSecrets(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const project = await pickProjectWithCurrentFile(ws.projects, '.NET: User Secrets', {
    commandKey: 'secrets',
  });
  if (!project) {
    return;
  }

  const actions: Array<{ label: string; description: string; action: string }> = [
    { label: '$(add)  Init', description: 'dotnet user-secrets init — set a UserSecretsId', action: 'init' },
    { label: '$(edit)  Set Secret…', description: 'dotnet user-secrets set', action: 'set' },
    { label: '$(list-unordered)  List Secrets', description: 'dotnet user-secrets list', action: 'list' },
    { label: '$(trash)  Remove Secret…', description: 'dotnet user-secrets remove', action: 'remove' },
    { label: '$(clear-all)  Remove All', description: 'dotnet user-secrets clear', action: 'clear' },
    { label: '$(go-to-file)  Open Secrets File', description: 'open secrets.json from the user profile', action: 'open' },
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: `${project.name} — user secrets`,
    title: '.NET: User Secrets',
  });
  if (!picked) {
    return;
  }
  switch (picked.action) {
    case 'init':
      await initSecrets(ws.root, project);
      return;
    case 'set':
      await setSecret(ws.root, project);
      return;
    case 'list':
      await listSecrets(ws.root, project);
      return;
    case 'remove':
      await removeSecret(ws.root, project);
      return;
    case 'clear':
      await clearSecrets(ws.root, project);
      return;
    case 'open':
      await openSecretsFile(project);
      return;
  }
}

async function initSecrets(root: string, project: ProjectEntry): Promise<void> {
  if (project.csproj?.userSecretsId) {
    vscode.window.showInformationMessage(
      `${project.name} already has a UserSecretsId (${project.csproj.userSecretsId}).`,
    );
    return;
  }
  const result = await spawnDotnet(['user-secrets', 'init', '--project', project.csprojPath], root, {
    reveal: true,
  });
  invalidateCsprojCache(project.csprojPath);
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(`User secrets initialized for ${project.name}.`);
  } else {
    vscode.window.showErrorMessage('dotnet user-secrets init failed. See the DotNet CLI Plus: dotnet output.');
  }
}

async function setSecret(root: string, project: ProjectEntry): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Secret key',
    placeHolder: 'e.g. ConnectionStrings:Default',
  });
  if (!key) {
    return;
  }
  const value = await vscode.window.showInputBox({
    prompt: `Value for "${key}"`,
    password: true,
  });
  if (!value) {
    return;
  }
  const result = await spawnDotnet(
    ['user-secrets', 'set', key.trim(), value, '--project', project.csprojPath],
    root,
    { reveal: true },
  );
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(`Secret "${key.trim()}" saved.`);
  } else {
    vscode.window.showErrorMessage('dotnet user-secrets set failed. See the DotNet CLI Plus: dotnet output.');
  }
}

async function captureSecrets(root: string, project: ProjectEntry): Promise<Map<string, string>> {
  const result = await spawnDotnet(['user-secrets', 'list', '--project', project.csprojPath], root);
  const secrets = new Map<string, string>();
  if (result.exitCode === 0) {
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^(.+?)\s+=\s+(.*)$/.exec(line.trim());
      if (match) {
        secrets.set(match[1], match[2]);
      }
    }
  }
  return secrets;
}

async function listSecrets(root: string, project: ProjectEntry): Promise<void> {
  const secrets = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reading secrets for ${project.name}…`, cancellable: false },
    async () => captureSecrets(root, project),
  );
  if (secrets.size === 0) {
    vscode.window.showInformationMessage(`No secrets configured for ${project.name}.`);
    return;
  }
  const items = [...secrets.entries()].map(([key, value]) => ({
    label: key,
    description: value.length > 60 ? `${value.slice(0, 60)}…` : value,
    full: `${key}=${value}`,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${secrets.size} secret${secrets.size !== 1 ? 's' : ''} (selection copies key=value)`,
    title: `User secrets — ${project.name}`,
    matchOnDescription: true,
  });
  if (picked) {
    await vscode.env.clipboard.writeText(picked.full);
    vscode.window.showInformationMessage('Copied to clipboard.');
  }
}

async function removeSecret(root: string, project: ProjectEntry): Promise<void> {
  const secrets = await captureSecrets(root, project);
  if (secrets.size === 0) {
    vscode.window.showInformationMessage(`No secrets configured for ${project.name}.`);
    return;
  }
  const picked = await vscode.window.showQuickPick([...secrets.keys()], {
    placeHolder: 'Select secret to remove',
    title: `Remove secret — ${project.name}`,
  });
  if (!picked) {
    return;
  }
  const result = await spawnDotnet(['user-secrets', 'remove', picked, '--project', project.csprojPath], root, {
    reveal: true,
  });
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(`Secret "${picked}" removed.`);
  } else {
    vscode.window.showErrorMessage('dotnet user-secrets remove failed. See the DotNet CLI Plus: dotnet output.');
  }
}

async function clearSecrets(root: string, project: ProjectEntry): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Remove ALL user secrets for ${project.name}?`,
    { modal: true },
    'Remove all',
  );
  if (confirm !== 'Remove all') {
    return;
  }
  const result = await spawnDotnet(['user-secrets', 'clear', '--project', project.csprojPath], root, {
    reveal: true,
  });
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(`All secrets removed for ${project.name}.`);
  } else {
    vscode.window.showErrorMessage('dotnet user-secrets clear failed. See the DotNet CLI Plus: dotnet output.');
  }
}

function secretsFilePath(userSecretsId: string): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'UserSecrets', userSecretsId, 'secrets.json');
  }
  return path.join(os.homedir(), '.microsoft', 'usersecrets', userSecretsId, 'secrets.json');
}

async function openSecretsFile(project: ProjectEntry): Promise<void> {
  const userSecretsId = project.csproj?.userSecretsId;
  if (!userSecretsId) {
    const action = await vscode.window.showWarningMessage(
      `${project.name} has no UserSecretsId yet.`,
      'Initialize',
    );
    if (action === 'Initialize') {
      const wsRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.csprojPath))?.uri.fsPath;
      if (wsRoot) {
        await initSecrets(wsRoot, project);
        await openSecretsPathReloaded(project);
      }
    }
    return;
  }
  await openSecretsPath(secretsFilePath(userSecretsId));
}

async function openSecretsPath(filePath: string): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, '{}\n', 'utf-8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    void vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open secrets file: ${err}`);
  }
}

async function openSecretsPathReloaded(project: ProjectEntry): Promise<void> {
  const reloaded = await invalidateAndReload(project);
  if (reloaded?.csproj?.userSecretsId) {
    await openSecretsPath(secretsFilePath(reloaded.csproj.userSecretsId));
  }
}

async function invalidateAndReload(project: ProjectEntry): Promise<ProjectEntry> {
  invalidateCsprojCache(project.csprojPath);
  const csproj = await loadCsproj(project.csprojPath);
  return csproj ? { ...project, csproj } : project;
}
