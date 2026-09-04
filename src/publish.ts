import * as vscode from 'vscode';
import {
  loadCsproj,
  pickProjectWithCurrentFile,
  resolveDotnetWorkspace,
  runInTerminal,
  buildDotnetTerminalCommand,
} from './utils';

const COMMON_RIDS = [
  'win-x64',
  'win-x86',
  'win-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-musl-x64',
  'osx-x64',
  'osx-arm64',
];

export async function publishProject(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const project = await pickProjectWithCurrentFile(ws.projects, '.NET: Publish / Pack', {
    commandKey: 'publish',
  });
  if (!project) {
    return;
  }

  const actions: Array<{ label: string; description: string; action: string }> = [
    { label: '$(cloud-upload)  Publish', description: 'dotnet publish', action: 'publish' },
    { label: '$(package)  Pack', description: 'dotnet pack — create a .nupkg', action: 'pack' },
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: project.name,
    title: '.NET: Publish / Pack',
  });
  if (!picked) {
    return;
  }
  if (picked.action === 'pack') {
    await packProject(ws.root, project);
    return;
  }
  await publishFlow(ws.root, project.name, project.csprojPath);
}

async function publishFlow(root: string, projectName: string, csprojPath: string): Promise<void> {
  const defaultConfig = vscode.workspace
    .getConfiguration('dotnetCliPlus')
    .get<string>('publish.configuration', 'release');
  const configPick = await vscode.window.showQuickPick(
    [
      { label: 'Release', config: 'Release' },
      { label: 'Debug', config: 'Debug' },
    ],
    { placeHolder: 'Configuration', title: 'dotnet publish' },
  );
  if (!configPick) {
    return;
  }

  const csproj = await loadCsproj(csprojPath);
  const tfms = csproj?.targetFrameworks ?? [];
  let tfm: string | undefined;
  if (tfms.length > 1) {
    const tfmPick = await vscode.window.showQuickPick(tfms, {
      placeHolder: 'Select target framework',
      title: `${projectName} is multi-target`,
    });
    if (!tfmPick) {
      return;
    }
    tfm = tfmPick;
  } else if (tfms.length === 1) {
    tfm = tfms[0];
  }

  const modes: Array<{ label: string; description: string; mode: 'simple' | 'fdd' | 'scd' }> = [
    { label: '$(play)  Simple', description: 'framework-dependent with default settings', mode: 'simple' },
    { label: '$(package)  Framework-dependent', description: '--self-contained false', mode: 'fdd' },
    { label: '$(box)  Self-contained', description: 'include the runtime + specify a RID', mode: 'scd' },
  ];
  const modePick = await vscode.window.showQuickPick(modes, {
    placeHolder: 'Deployment mode',
    title: 'dotnet publish',
  });
  if (!modePick) {
    return;
  }

  let rid: string | undefined;
  if (modePick.mode === 'scd') {
    const ridItems: Array<{ label: string; description: string; rid: string }> = COMMON_RIDS.map((r) => ({
      label: r,
      description: '',
      rid: r,
    }));
    ridItems.push({ label: '$(edit)  Custom RID…', description: 'enter a runtime identifier', rid: '__custom__' });
    const ridPick = await vscode.window.showQuickPick(ridItems, { placeHolder: 'Runtime identifier (-r)' });
    if (!ridPick) {
      return;
    }
    if (ridPick.rid === '__custom__') {
      const custom = await vscode.window.showInputBox({ prompt: 'Runtime identifier', placeHolder: 'e.g. linux-musl-arm' });
      if (!custom) {
        return;
      }
      rid = custom.trim();
    } else {
      rid = ridPick.rid;
    }
  }

  const output = await vscode.window.showInputBox({
    prompt: 'Output directory (optional)',
    placeHolder: 'publish — leave empty for the default (bin/<config>/<tfm>/publish/)',
  });
  if (output === undefined) {
    return;
  }

  const args = [
    'publish',
    csprojPath,
    '-c',
    configPick.config,
    ...(tfm ? ['-f', tfm] : []),
    ...(modePick.mode === 'fdd' ? ['--self-contained', 'false'] : []),
    ...(modePick.mode === 'scd' && rid ? ['--self-contained', 'true', '-r', rid] : []),
    ...(output.trim().length > 0 ? ['-o', output.trim()] : []),
  ];
  await runInTerminal(
    `dotnet publish (${projectName})`,
    buildDotnetTerminalCommand(args),
    root,
    { successMessage: 'Publish completed.', retryLabel: 'Retry' },
  );
}

async function packProject(root: string, project: { name: string; csprojPath: string; csproj: { isPackable: boolean } | null }): Promise<void> {
  if (project.csproj && !project.csproj.isPackable) {
    const confirm = await vscode.window.showWarningMessage(
      `${project.name} is not packable (IsPackable=false in the project file). Pack anyway?`,
      { modal: true },
      'Pack',
    );
    if (confirm !== 'Pack') {
      return;
    }
  }
  const configSetting = vscode.workspace
    .getConfiguration('dotnetCliPlus')
    .get<string>('publish.configuration', 'release');
  const config = configSetting === 'debug' ? 'Debug' : 'Release';
  await runInTerminal(
    `dotnet pack (${project.name})`,
    buildDotnetTerminalCommand(['pack', project.csprojPath, '-c', config]),
    root,
    { successMessage: 'Package created.', retryLabel: 'Retry' },
  );
}
