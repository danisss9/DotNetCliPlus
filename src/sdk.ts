import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeInfo, SdkInfo } from './types';
import { parseRuntimeList, parseSdkList } from './pure-utils';
import { pickWorkspaceRoot, runInTerminal, buildDotnetTerminalCommand, spawnDotnet } from './utils';

const SDK_CACHE_TTL_MS = 5 * 60 * 1000;
const sdkCache = new Map<string, { sdks: SdkInfo[]; at: number }>();

export async function getSdks(root: string, force = false): Promise<SdkInfo[]> {
  const cached = sdkCache.get(root);
  if (!force && cached && Date.now() - cached.at < SDK_CACHE_TTL_MS) {
    return cached.sdks;
  }
  const result = await spawnDotnet(['--list-sdks'], root, { timeoutMs: 15000 });
  const sdks = parseSdkList(result.stdout);
  sdkCache.set(root, { sdks, at: Date.now() });
  return sdks;
}

export function invalidateSdkCache(): void {
  sdkCache.clear();
}

export async function manageSdks(): Promise<void> {
  const root = await pickWorkspaceRoot();
  if (!root) {
    return;
  }
  const actions: Array<{ label: string; description: string; action: string }> = [
    { label: '$(package)  Installed SDKs', description: 'dotnet --list-sdks', action: 'sdks' },
    { label: '$(browser)  Installed Runtimes', description: 'dotnet --list-runtimes', action: 'runtimes' },
    { label: '$(heart)  SDK Health Check', description: 'dotnet sdk check — reports updates and EOL status', action: 'check' },
    { label: '$(pin)  Pin SDK in global.json…', description: 'create or update global.json', action: 'pin' },
    { label: '$(info)  dotnet Info', description: 'dotnet --info', action: 'info' },
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: 'Select SDK action',
    title: '.NET: Manage SDKs',
  });
  if (!picked) {
    return;
  }
  switch (picked.action) {
    case 'sdks':
      await listSdks(root);
      return;
    case 'runtimes':
      await listRuntimes(root);
      return;
    case 'check':
      await runInTerminal('dotnet sdk check', buildDotnetTerminalCommand(['sdk', 'check']), root);
      return;
    case 'pin':
      await pinSdk(root);
      return;
    case 'info':
      await runInTerminal('dotnet --info', buildDotnetTerminalCommand(['--info']), root);
      return;
  }
}

async function listSdks(root: string): Promise<void> {
  const sdks = await getSdks(root, true);
  if (sdks.length === 0) {
    vscode.window.showWarningMessage('No .NET SDKs found. Is dotnet installed and on PATH?');
    return;
  }
  const items = sdks.map((sdk) => ({
    label: sdk.version,
    description: sdk.path,
  }));
  await vscode.window.showQuickPick(items, {
    placeHolder: `${sdks.length} SDK${sdks.length !== 1 ? 's' : ''} installed`,
    title: 'Installed .NET SDKs',
    matchOnDescription: true,
  });
}

async function listRuntimes(root: string): Promise<void> {
  const result = await spawnDotnet(['--list-runtimes'], root, { timeoutMs: 15000 });
  const runtimes: RuntimeInfo[] = parseRuntimeList(result.stdout);
  if (runtimes.length === 0) {
    vscode.window.showWarningMessage('No .NET runtimes found.');
    return;
  }
  const items = runtimes.map((runtime) => ({
    label: `${runtime.name} ${runtime.version}`,
    description: runtime.path,
  }));
  await vscode.window.showQuickPick(items, {
    placeHolder: `${runtimes.length} runtime${runtimes.length !== 1 ? 's' : ''} installed`,
    title: 'Installed .NET Runtimes',
    matchOnDescription: true,
  });
}

async function pinSdk(root: string): Promise<void> {
  const sdks = await getSdks(root, true);
  if (sdks.length === 0) {
    vscode.window.showWarningMessage('No .NET SDKs found. Is dotnet installed and on PATH?');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    sdks.map((sdk) => ({ label: sdk.version, description: sdk.path })),
    { placeHolder: 'Select SDK version to pin', title: 'Pin SDK in global.json' },
  );
  if (!picked) {
    return;
  }
  const globalJsonPath = path.join(root, 'global.json');
  const content = {
    sdk: {
      version: picked.label,
      rollForward: 'latestFeature',
    },
  };
  if (fs.existsSync(globalJsonPath)) {
    const confirm = await vscode.window.showWarningMessage(
      'global.json already exists. Overwrite it?',
      { modal: true },
      'Overwrite',
    );
    if (confirm !== 'Overwrite') {
      return;
    }
  }
  try {
    await fs.promises.writeFile(globalJsonPath, JSON.stringify(content, null, '\t') + '\n', 'utf-8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(globalJsonPath));
    void vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Pinned SDK ${picked.label} in global.json.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not write global.json: ${err}`);
  }
}

export async function checkDotnetOnStartup(root: string): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('dotnetCliPlus').get<boolean>('sdk.checkOnStartup', true);
  if (!enabled) {
    return;
  }
  const result = await spawnDotnet(['--version'], root, { timeoutMs: 10000 });
  if (result.exitCode !== 0) {
    const action = await vscode.window.showWarningMessage(
      '"dotnet" was not found on PATH. The .NET SDK is required for DotNet CLI Plus.',
      'Open download page',
    );
    if (action === 'Open download page') {
      void vscode.env.openExternal(vscode.Uri.parse('https://dotnet.microsoft.com/download'));
    }
    return;
  }

  const globalJsonPath = path.join(root, 'global.json');
  if (!fs.existsSync(globalJsonPath)) {
    return;
  }
  try {
    const { parse } = await import('jsonc-parser');
    const parsed = parse(await fs.promises.readFile(globalJsonPath, 'utf-8')) as {
      sdk?: { version?: string; rollForward?: string };
    } | null;
    const pinned = parsed?.sdk?.version;
    if (!pinned) {
      return;
    }
    const sdks = await getSdks(root);
    if (sdks.length === 0) {
      return;
    }
    const exactInstalled = sdks.some((sdk) => sdk.version === pinned);
    if (exactInstalled) {
      return;
    }
    const [major, minor] = pinned.split('.');
    const featureBand = minor !== undefined && minor.length >= 2 ? `${major}.${minor.slice(0, 2)}` : `${major}`;
    const bandInstalled = sdks.some((sdk) => {
      const [sdkMajor, sdkMinor] = sdk.version.split('.');
      const sdkBand = sdkMinor !== undefined && sdkMinor.length >= 2 ? `${sdkMajor}.${sdkMinor.slice(0, 2)}` : `${sdkMajor}`;
      return sdkBand === featureBand && sdk.version > pinned;
    });
    if (bandInstalled) {
      return;
    }
    const action = await vscode.window.showWarningMessage(
      `global.json requires SDK ${pinned}, which is not installed (found ${sdks.map((s) => s.version).join(', ')}).`,
      'Manage SDKs',
    );
    if (action === 'Manage SDKs') {
      await manageSdks();
    }
  } catch {
    return;
  }
}
