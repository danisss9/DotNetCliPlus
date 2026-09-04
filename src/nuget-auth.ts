import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { pickWorkspaceRoot } from './utils';
import { validateNuGetSourceName } from './pure-utils';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildNuGetConfig(name: string, url: string, username: string, pat: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="${escapeXml(name)}" value="${escapeXml(url)}" />
  </packageSources>
  <packageSourceCredentials>
    <${escapeXml(name)}>
      <add key="Username" value="${escapeXml(username)}" />
      <add key="ClearTextPassword" value="${escapeXml(pat)}" />
    </${escapeXml(name)}>
  </packageSourceCredentials>
</configuration>
`;
}

export async function setupNuGetAuth(): Promise<void> {
  const root = await pickWorkspaceRoot();
  if (!root) {
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Source name',
    value: 'PrivateFeed',
    validateInput: (value) => validateNuGetSourceName(value),
  });
  if (!name) {
    return;
  }
  const url = await vscode.window.showInputBox({
    prompt: 'Source URL',
    placeHolder: 'https://pkgs.dev.azure.com/<org>/<project>/_packages/<feed>/nuget/v3/index.json',
  });
  if (!url || !/^https?:\/\//.test(url.trim())) {
    if (url !== undefined) {
      vscode.window.showErrorMessage('Source URL must start with http:// or https://');
    }
    return;
  }
  const username = await vscode.window.showInputBox({
    prompt: 'Username',
    value: 'user',
    placeHolder: 'For Azure Artifacts PATs the username can be any non-empty value',
  });
  if (username === undefined) {
    return;
  }
  const pat = await vscode.window.showInputBox({
    prompt: 'Personal access token / password',
    password: true,
  });
  if (!pat) {
    return;
  }

  const nugetConfigPath = path.join(root, 'nuget.config');
  const content = buildNuGetConfig(name.trim(), url.trim(), username.trim() || 'user', pat);

  if (fs.existsSync(nugetConfigPath)) {
    const action = await vscode.window.showWarningMessage(
      'nuget.config already exists in the workspace root.',
      'Overwrite',
      'Open file',
    );
    if (action === 'Open file') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(nugetConfigPath));
      void vscode.window.showTextDocument(doc);
      return;
    }
    if (action !== 'Overwrite') {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Overwrite nuget.config with the ${name.trim()} source and credentials?`,
      { modal: true },
      'Overwrite',
    );
    if (confirm !== 'Overwrite') {
      return;
    }
  }

  try {
    await fs.promises.writeFile(nugetConfigPath, content, 'utf-8');
  } catch (err) {
    vscode.window.showErrorMessage(`Could not write nuget.config: ${err}`);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(nugetConfigPath));
  void vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    `nuget.config configured with source "${name.trim()}". Run .NET: Restore to pick it up.`,
  );
}
