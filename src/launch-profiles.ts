import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as jsoncParse } from 'jsonc-parser';
import type { LaunchProfile, ProjectEntry } from './types';
import { parseLaunchSettingsProfiles } from './pure-utils';
import { resolveDotnetWorkspace, runInTerminal, buildDotnetTerminalCommand } from './utils';

export async function loadLaunchProfiles(csprojPath: string): Promise<LaunchProfile[]> {
  const launchSettingsPath = path.join(path.dirname(csprojPath), 'Properties', 'launchSettings.json');
  try {
    const content = await fs.promises.readFile(launchSettingsPath, 'utf-8');
    return parseLaunchSettingsProfiles(jsoncParse(content));
  } catch {
    return [];
  }
}

export async function pickProjectWithProfiles(
  projects: ProjectEntry[],
  title: string,
): Promise<ProjectEntry | null> {
  const withProfiles: Array<{ entry: ProjectEntry; profiles: LaunchProfile[] }> = [];
  for (const project of projects) {
    const profiles = await loadLaunchProfiles(project.csprojPath);
    if (profiles.length > 0) {
      withProfiles.push({ entry: project, profiles });
    }
  }
  if (withProfiles.length === 0) {
    vscode.window.showInformationMessage(
      'No launchSettings.json profiles found. Add Properties/launchSettings.json to a project first.',
    );
    return null;
  }

  const items = withProfiles.map((p) => ({
    label: p.entry.name,
    description: `${p.profiles.length} profile${p.profiles.length !== 1 ? 's' : ''}`,
    detail: p.profiles.map((prof) => prof.name).join(', '),
    data: p,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select project',
    title,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.data.entry ?? null;
}

export async function pickProfile(profiles: LaunchProfile[]): Promise<LaunchProfile | null> {
  const items: Array<vscode.QuickPickItem & { profile: LaunchProfile | null }> = [
    { label: '$(circle-slash)  No profile', description: 'run without --launch-profile', profile: null },
    ...profiles.map((profile) => ({
      label: `$(play)  ${profile.name}`,
      description:
        `${profile.commandName ?? ''}${profile.applicationUrl ? `  ·  ${profile.applicationUrl}` : ''}`.trim(),
      profile,
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select launch profile',
    title: 'Launch profiles',
  });
  return picked?.profile ?? null;
}

export async function runLaunchProfile(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const project = await pickProjectWithProfiles(ws.projects, '.NET: Run Launch Profile');
  if (!project) {
    return;
  }
  const profiles = await loadLaunchProfiles(project.csprojPath);
  if (profiles.length === 0) {
    vscode.window.showInformationMessage('No profiles in launchSettings.json.');
    return;
  }
  const profile = await pickProfile(profiles);
  if (!profile) {
    return;
  }
  const config = vscode.workspace.getConfiguration('dotnetCliPlus').get<string>('run.configuration', 'default');
  const configArgs = config === 'debug' ? ['-c', 'Debug'] : config === 'release' ? ['-c', 'Release'] : [];
  const args = ['run', '--project', project.csprojPath, '--launch-profile', profile.name, ...configArgs];
  await runInTerminal(
    `dotnet run (${project.name}) [${profile.name}]`,
    buildDotnetTerminalCommand(args),
    ws.root,
    { longRunning: true },
  );
}
