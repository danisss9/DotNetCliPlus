import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as jsoncParse, modify as jsoncModify, applyEdits as jsoncApplyEdits } from 'jsonc-parser';
import type { ProjectEntry, ProjectTarget } from './types';
import { buildProgramPath, configFlag } from './pure-utils';
import { resolveDotnetWorkspace, spawnDotnet, pickProjectWithCurrentFile } from './utils';
import { loadLaunchProfiles, pickProfile } from './launch-profiles';
import { checkBuildErrors } from './build-errors';

interface CoreclrConfig extends vscode.DebugConfiguration {
  program: string;
  cwd: string;
}

export async function debugProject(target?: ProjectTarget): Promise<void> {
  let folder: vscode.WorkspaceFolder;
  let project: ProjectEntry;
  if (target) {
    const resolvedFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.root));
    if (!resolvedFolder) {
      vscode.window.showErrorMessage('The workspace folder for this project is no longer open.');
      return;
    }
    folder = resolvedFolder;
    project = target.entry;
  } else {
    const ws = await resolveDotnetWorkspace();
    if (!ws) {
      return;
    }
    const picked = await pickProjectWithCurrentFile(ws.projects, '.NET: Debug Project', {
      runnableOnly: true,
      commandKey: 'debug',
    });
    if (!picked) {
      return;
    }
    folder = ws.folder;
    project = picked;
  }
  const root = folder.uri.fsPath;

  const csproj = project.csproj;
  if (!csproj || csproj.targetFrameworks.length === 0) {
    vscode.window.showErrorMessage(`No TargetFramework found in ${path.basename(project.csprojPath)}.`);
    return;
  }

  const tfm =
    csproj.targetFrameworks.length > 1
      ? await vscode.window.showQuickPick(csproj.targetFrameworks, {
          placeHolder: 'Select target framework',
          title: `${project.name} is multi-target`,
        })
      : csproj.targetFrameworks[0];
  if (!tfm) {
    return;
  }

  let profileEnv: Record<string, string> | undefined;
  const profiles = await loadLaunchProfiles(project.csprojPath);
  if (profiles.length > 0) {
    const profile = await pickProfile(profiles);
    if (!profile) {
      return;
    }
    if (profile) {
      profileEnv = { ...(profile.environmentVariables ?? {}) };
      if (profile.applicationUrl && !profileEnv.ASPNETCORE_URLS) {
        profileEnv.ASPNETCORE_URLS = profile.applicationUrl;
      }
    }
  }
  const isWeb = csproj.isWeb;
  if ((isWeb || profileEnv) && !profileEnv?.ASPNETCORE_ENVIRONMENT) {
    profileEnv = { ASPNETCORE_ENVIRONMENT: 'Development', ...(profileEnv ?? {}) };
  }

  const configSetting = vscode.workspace.getConfiguration('dotnetCliPlus').get<string>('build.configuration', 'default');
  const configuration = configSetting === 'release' ? 'Release' : 'Debug';

  const buildResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Building ${project.name}…`,
      cancellable: false,
    },
    async () => spawnDotnet(['build', project.csprojPath, ...configFlag(configuration), '-v', 'minimal'], root),
  );
  if (buildResult.exitCode !== 0) {
    const action = await vscode.window.showErrorMessage(
      `Build failed for ${project.name}.`,
      'Check Build Errors',
    );
    if (action === 'Check Build Errors') {
      await checkBuildErrors({ kind: 'project', entry: project });
    }
    return;
  }

  const csprojDir = path.dirname(project.csprojPath);
  const program = buildProgramPath(csprojDir, tfm, csproj.assemblyName, project.name, configuration);
  if (!fs.existsSync(program)) {
    vscode.window.showErrorMessage(
      `Built output not found at ${program}. Check AssemblyName/OutputPath in the project file.`,
    );
    return;
  }

  const configName = `.NET: ${project.name}`;
  const debugConfig: CoreclrConfig = {
    type: 'coreclr',
    request: 'launch',
    name: configName,
    program,
    cwd: csprojDir,
    console: 'integratedTerminal',
    stopAtEntry: false,
    ...(profileEnv ? { env: profileEnv } : {}),
  };

  const launchJsonPath = path.join(root, '.vscode', 'launch.json');
  try {
    await ensureLaunchConfig(launchJsonPath, debugConfig);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not update .vscode/launch.json: ${err}`);
    return;
  }

  const started = await vscode.debug.startDebugging(folder, configName);
  if (!started) {
    vscode.window.showErrorMessage(
      'Failed to start the debug session. Is the C# extension (ms-dotnettools.csharp) installed?',
    );
  }
}

async function ensureLaunchConfig(launchJsonPath: string, config: CoreclrConfig): Promise<void> {
  const { parse, modify, applyEdits } = await import('jsonc-parser');
  let text: string;
  try {
    text = await fs.promises.readFile(launchJsonPath, 'utf-8');
  } catch {
    await fs.promises.mkdir(path.dirname(launchJsonPath), { recursive: true });
    const fresh = {
      version: '0.2.0',
      configurations: [config],
    };
    await fs.promises.writeFile(launchJsonPath, JSON.stringify(fresh, null, '\t'), 'utf-8');
    return;
  }

  if (text.trim().length === 0) {
    const fresh = { version: '0.2.0', configurations: [config] };
    await fs.promises.writeFile(launchJsonPath, JSON.stringify(fresh, null, '\t'), 'utf-8');
    return;
  }

  let parsed: unknown;
  try {
    parsed = jsoncParse(text);
  } catch {
    const overwrite = await vscode.window.showWarningMessage(
      '.vscode/launch.json could not be parsed. Overwrite it?',
      { modal: true },
      'Overwrite',
    );
    if (overwrite !== 'Overwrite') {
      throw new Error('launch.json is unparseable and was not overwritten');
    }
    const fresh = { version: '0.2.0', configurations: [config] };
    await fs.promises.writeFile(launchJsonPath, JSON.stringify(fresh, null, '\t'), 'utf-8');
    return;
  }

  const root = parsed as { configurations?: Array<{ name?: string }> } | null;
  let configurations = root?.configurations;
  if (!Array.isArray(configurations)) {
    let edited = jsoncApplyEdits(text, jsoncModify(text, ['configurations'], [], {}));
    edited = jsoncApplyEdits(edited, jsoncModify(edited, ['configurations', 0], config, {}));
    await fs.promises.writeFile(launchJsonPath, edited, 'utf-8');
    return;
  }

  const index = configurations.findIndex((c) => c && typeof c === 'object' && c.name === config.name);
  if (index === -1) {
    const edited = jsoncApplyEdits(text, jsoncModify(text, ['configurations', configurations.length], config, {}));
    await fs.promises.writeFile(launchJsonPath, edited, 'utf-8');
    return;
  }

  let edited = text;
  for (const key of ['program', 'cwd'] as const) {
    edited = jsoncApplyEdits(edited, jsoncModify(edited, ['configurations', index, key], config[key], {}));
  }
  if (config.env) {
    const existingEnv = (configurations[index] as { env?: Record<string, string> } | undefined)?.env;
    const mergedEnv = { ...existingEnv, ...config.env };
    edited = jsoncApplyEdits(edited, jsoncModify(edited, ['configurations', index, 'env'], mergedEnv, {}));
  }
  await fs.promises.writeFile(launchJsonPath, edited, 'utf-8');
}
