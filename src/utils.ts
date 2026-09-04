import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { CsprojInfo, ProjectEntry, BuildTarget } from './types';
import {
  activeRunTerminals,
  clearTrackedTerminalState,
  dotnetOutput,
  extensionTerminals,
  getExtensionContext,
  getTrackedTerminalState,
  logDiagnostic,
  persistTerminalEntry,
  removePersistedTerminalEntry,
  setTrackedTerminalRunning,
} from './state';
import { spawnManaged, type SpawnManagedResult } from './spawn';
import {
  buildTerminalCommand,
  findBestProjectForPath,
  isRunnableProject,
  normalizePathKey,
  parseCsproj,
  parseSln,
  parseSlnx,
} from './pure-utils';

export const EXCLUDE_GLOB = '**/{node_modules,bin,obj,.git,.vs,artifacts}/**';
const PROJECT_FILE_GLOB = '**/*.{csproj,fsproj,vbproj}';

// ── csproj cache ──────────────────────────────────────────────────────────────

interface CsprojCacheEntry {
  info: CsprojInfo | null;
  mtimeMs: number;
}

const csprojCache = new Map<string, CsprojCacheEntry>();

export function invalidateCsprojCache(filePath?: string): void {
  if (filePath) {
    csprojCache.delete(normalizePathKey(filePath));
  } else {
    csprojCache.clear();
  }
}

export async function loadCsproj(csprojPath: string): Promise<CsprojInfo | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.promises.stat(csprojPath)).mtimeMs;
  } catch {
    return null;
  }
  const key = normalizePathKey(csprojPath);
  const cached = csprojCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.info;
  }
  let info: CsprojInfo | null = null;
  try {
    const content = await fs.promises.readFile(csprojPath, 'utf-8');
    info = parseCsproj(content);
  } catch {
    info = null;
  }
  if (info) {
    csprojCache.set(key, { info, mtimeMs });
  } else if (cached) {
    csprojCache.delete(key);
  }
  return info;
}

// ── Solution / project discovery ──────────────────────────────────────────────

export async function findSolutionFiles(root: string): Promise<string[]> {
  const results = new Map<string, string>();
  let rootEntries: string[] = [];
  try {
    rootEntries = await fs.promises.readdir(root);
  } catch {
    return [];
  }
  for (const entry of rootEntries) {
    const lower = entry.toLowerCase();
    if (lower.endsWith('.sln') || lower.endsWith('.slnx')) {
      const full = path.join(root, entry);
      results.set(normalizePathKey(full), full);
    }
  }
  const deep = await vscode.workspace.findFiles('**/*.{sln,slnx}', EXCLUDE_GLOB, 100);
  for (const uri of deep) {
    results.set(normalizePathKey(uri.fsPath), uri.fsPath);
  }
  return [...results.values()];
}

export async function findProjectFiles(root: string): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(PROJECT_FILE_GLOB, EXCLUDE_GLOB, 500);
  return uris.map((u) => u.fsPath).filter((p) => normalizePathKey(p).startsWith(normalizePathKey(root)));
}

export async function pickWorkspaceRoot(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select workspace folder' });
  return picked?.uri.fsPath ?? null;
}

export async function pickSolutionFile(candidates: string[], root: string): Promise<string | null> {
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const sorted = [...candidates].sort(
    (a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b),
  );
  const last = getExtensionContext().globalState.get<string>(`lastSolution.${root}`);
  const lastInList = last ? sorted.find((c) => normalizePathKey(c) === normalizePathKey(last)) : undefined;
  const LAST_LABEL = lastInList ? `$(history)  Last used (${path.basename(lastInList)})` : null;
  const choices: string[] = [
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ...sorted.map((c) => `${path.basename(c)}  ·  ${path.relative(root, path.dirname(c)) || '.'}`),
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select solution file',
    title: 'Multiple solutions found',
  });
  if (!picked) {
    return null;
  }
  if (LAST_LABEL && picked === LAST_LABEL) {
    return lastInList!;
  }
  const chosen = sorted.find(
    (c) => `${path.basename(c)}  ·  ${path.relative(root, path.dirname(c)) || '.'}` === picked,
  );
  if (chosen) {
    void getExtensionContext().globalState.update(`lastSolution.${root}`, chosen);
  }
  return chosen ?? null;
}

export interface DotnetWorkspace {
  folder: vscode.WorkspaceFolder;
  root: string;
  slnPath: string | null;
  projects: ProjectEntry[];
}

export async function resolveDotnetWorkspace(): Promise<DotnetWorkspace | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }
  let folder: vscode.WorkspaceFolder;
  if (folders.length === 1) {
    folder = folders[0];
  } else {
    const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select workspace folder' });
    if (!picked) {
      return null;
    }
    folder = picked;
  }
  const root = folder.uri.fsPath;

  const solutionCandidates = await findSolutionFiles(root);
  const slnPath = await pickSolutionFile(solutionCandidates, root);
  const projects = await discoverProjects(root, slnPath);

  if (projects.length === 0) {
    vscode.window.showErrorMessage(
      'No SDK-style .NET projects found in this workspace (solution files and *.csproj were searched).',
    );
    return null;
  }

  return { folder, root, slnPath, projects };
}

export async function discoverProjects(root: string, slnPath: string | null): Promise<ProjectEntry[]> {
  const entries: ProjectEntry[] = [];
  const seen = new Set<string>();

  const pushProject = async (csprojPath: string, name?: string) => {
    const key = normalizePathKey(csprojPath);
    if (seen.has(key)) {
      return;
    }
    if (!fs.existsSync(csprojPath)) {
      return;
    }
    const csproj = await loadCsproj(csprojPath);
    if (!csproj) {
      return;
    }
    seen.add(key);
    entries.push({
      name: name || path.basename(csprojPath, path.extname(csprojPath)),
      csprojPath,
      csproj,
    });
  };

  if (slnPath) {
    try {
      const content = await fs.promises.readFile(slnPath, 'utf-8');
      const slnDir = path.dirname(slnPath);
      if (slnPath.toLowerCase().endsWith('.slnx')) {
        const paths = parseSlnx(content) ?? [];
        for (const rel of paths) {
          await pushProject(path.resolve(slnDir, rel));
        }
      } else {
        const projects = parseSln(content) ?? [];
        for (const project of projects) {
          if (project.isSolutionFolder) {
            continue;
          }
          await pushProject(path.resolve(slnDir, project.relativePath), project.name);
        }
      }
    } catch (err) {
      logDiagnostic(`Failed to read solution ${slnPath}: ${err}`);
    }
  }

  if (entries.length === 0) {
    for (const csprojPath of await findProjectFiles(root)) {
      await pushProject(csprojPath);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Project selection ─────────────────────────────────────────────────────────

export function getLastProject(commandKey: string): string | undefined {
  return getExtensionContext().globalState.get<string>(`lastProject.${commandKey}`);
}

export function setLastProject(commandKey: string, project: string): void {
  void getExtensionContext().globalState.update(`lastProject.${commandKey}`, project);
}

export function detectActiveProject(projects: ProjectEntry[]): ProjectEntry | null {
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!activeFile) {
    return null;
  }
  const name = findBestProjectForPath(
    activeFile,
    projects.map((p) => ({ name: p.name, csprojPath: p.csprojPath })),
  );
  return name ? projects.find((p) => p.name === name) ?? null : null;
}

export interface PickProjectOptions {
  runnableOnly?: boolean;
  testOnly?: boolean;
  commandKey?: string;
}

export async function pickProjectWithCurrentFile(
  projects: ProjectEntry[],
  title: string,
  options?: PickProjectOptions,
): Promise<ProjectEntry | null> {
  const all = projects;
  let filtered = all;
  if (options?.runnableOnly) {
    filtered = filtered.filter((p) => isRunnableProject(p.csproj));
  }
  if (options?.testOnly) {
    filtered = filtered.filter((p) => p.csproj?.isTestProject);
  }
  if (filtered.length === 0) {
    const reason = options?.testOnly
      ? 'No test projects found (Microsoft.NET.Test.Sdk required)'
      : options?.runnableOnly
        ? 'No runnable projects found (OutputType Exe/WinExe or Web SDK required)'
        : 'No projects found';
    vscode.window.showErrorMessage(reason);
    return null;
  }
  if (filtered.length === 1) {
    return filtered[0];
  }

  const active = detectActiveProject(all);
  const activeInList = active && filtered.some((p) => p.name === active.name) ? active : null;
  const CURRENT_LABEL = activeInList ? `$(file)  Current project (${activeInList.name})` : null;

  const last = options?.commandKey ? getLastProject(options.commandKey) : undefined;
  const lastEntry = last ? filtered.find((p) => p.name === last) : undefined;
  const lastShown = lastEntry && lastEntry.name !== activeInList?.name ? lastEntry : undefined;
  const LAST_LABEL = lastShown ? `$(history)  Last used (${lastShown.name})` : null;

  const items: Array<vscode.QuickPickItem & { entry?: ProjectEntry }> = [
    ...(CURRENT_LABEL ? [{ label: CURRENT_LABEL, entry: activeInList! }] : []),
    ...(LAST_LABEL ? [{ label: LAST_LABEL, entry: lastShown! }] : []),
    ...filtered.map((p) => ({
      label: p.name,
      description: `${p.csproj?.targetFrameworks.join(', ') ?? '—'}  ·  ${p.csprojPath}`,
      entry: p,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select project',
    title,
    matchOnDescription: true,
  });
  if (!picked?.entry) {
    return null;
  }
  if (options?.commandKey && picked.entry !== lastShown) {
    setLastProject(options.commandKey, picked.entry.name);
  }
  return picked.entry;
}

export interface PickBuildTargetOptions {
  allowSolution?: boolean;
  runnableOnly?: boolean;
  testOnly?: boolean;
  commandKey?: string;
}

export async function pickBuildTarget(
  workspace: DotnetWorkspace,
  title: string,
  options?: PickBuildTargetOptions,
): Promise<BuildTarget | null> {
  const solutionTarget: BuildTarget | null =
    workspace.slnPath && options?.allowSolution !== false
      ? {
          kind: 'solution',
          path: workspace.slnPath,
          name: path.basename(workspace.slnPath),
        }
      : null;

  const projectEntries = workspace.projects;
  let filtered = projectEntries;
  if (options?.runnableOnly) {
    filtered = filtered.filter((p) => isRunnableProject(p.csproj));
  }
  if (options?.testOnly) {
    filtered = filtered.filter((p) => p.csproj?.isTestProject);
  }

  if (filtered.length === 0) {
    const reason = options?.testOnly
      ? 'No test projects found (Microsoft.NET.Test.Sdk required)'
      : options?.runnableOnly
        ? 'No runnable projects found (OutputType Exe/WinExe or Web SDK required)'
        : 'No projects found';
    vscode.window.showErrorMessage(reason);
    return null;
  }

  if (!solutionTarget && filtered.length === 1) {
    return { kind: 'project', entry: filtered[0] };
  }

  const active = detectActiveProject(projectEntries);
  const activeInList = active && filtered.some((p) => p.name === active.name) ? active : null;
  const CURRENT_LABEL = activeInList ? `$(file)  Current project (${activeInList.name})` : null;

  const last = options?.commandKey ? getLastProject(options.commandKey) : undefined;

  type TargetItem = vscode.QuickPickItem & {
    target?: BuildTarget;
  };
  const items: TargetItem[] = [];
  if (solutionTarget) {
    items.push({
      label: `$(file-directory)  Solution (${solutionTarget.name})`,
      description: 'all projects',
      target: solutionTarget,
    });
  }
  if (CURRENT_LABEL) {
    items.push({ label: CURRENT_LABEL, target: { kind: 'project', entry: activeInList! } });
  }
  if (last) {
    const lastSolution = solutionTarget && normalizePathKey(solutionTarget.path) === normalizePathKey(last);
    const lastEntry = filtered.find((p) => p.name === last);
    if (lastSolution || (lastEntry && lastEntry.name !== activeInList?.name)) {
      items.push({
        label: `$(history)  Last used (${last})`,
        target: lastSolution ? solutionTarget : { kind: 'project', entry: lastEntry! },
      });
    }
  }
  for (const p of filtered) {
    items.push({
      label: p.name,
      description: `${p.csproj?.targetFrameworks.join(', ') ?? '—'}  ·  ${path.relative(workspace.root, p.csprojPath)}`,
      target: { kind: 'project', entry: p } satisfies BuildTarget,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select build target',
    title,
    matchOnDescription: true,
  });
  if (!picked?.target) {
    return null;
  }
  if (options?.commandKey) {
    const name =
      picked.target.kind === 'solution' ? picked.target.path : picked.target.entry.name;
    if (name !== last) {
      setLastProject(options.commandKey, name);
    }
  }
  return picked.target;
}

// ── Terminal helpers ──────────────────────────────────────────────────────────

const RESTART_CTRL_C_DELAY_MS = 500;

export async function runInTerminal(
  name: string,
  command: string,
  cwd: string,
  options?: {
    longRunning?: boolean;
    successMessage?: string;
    retryLabel?: string;
    onRetry?: () => void;
  },
): Promise<vscode.Terminal> {
  const existing = [...extensionTerminals].find((t) => t.name === name);
  if (existing) {
    const isRunning = getTrackedTerminalState(existing) === 'running';
    if (isRunning) {
      const action = await vscode.window.showInformationMessage(
        `"${name}" is already running. Restart it?`,
        'Restart',
        'Show',
      );
      if (getTrackedTerminalState(existing) !== 'running') {
        existing.show();
        existing.sendText(command);
        return existing;
      } else if (action === 'Restart') {
        existing.show();
        existing.sendText('\x03');
        await new Promise<void>((r) => setTimeout(r, RESTART_CTRL_C_DELAY_MS));
        existing.sendText(command);
        return existing;
      } else {
        existing.show();
        return existing;
      }
    } else {
      existing.show();
      existing.sendText(command);
      return existing;
    }
  }

  const terminal = vscode.window.createTerminal({ name, cwd });
  extensionTerminals.add(terminal);
  persistTerminalEntry(name, { command, cwd });

  if (options?.longRunning) {
    activeRunTerminals.set(name, { terminal, command, cwd });
  }
  terminal.show();
  terminal.sendText(command);

  const disposable = vscode.window.onDidCloseTerminal(async (closed) => {
    if (closed !== terminal) {
      return;
    }
    disposable.dispose();
    extensionTerminals.delete(closed);
    clearTrackedTerminalState(closed);
    removePersistedTerminalEntry(name);

    for (const [key, entry] of activeRunTerminals) {
      if (entry.terminal === closed) {
        activeRunTerminals.delete(key);
        break;
      }
    }

    const exitStatus = closed.exitStatus;
    if (exitStatus === undefined) {
      return;
    }

    const code = exitStatus.code;
    if (code === undefined) {
      logDiagnostic(`Terminal "${name}" closed without an exit code (killed/forced close).`);
      return;
    }

    if (code === 0) {
      if (options?.successMessage) {
        vscode.window.showInformationMessage(options.successMessage);
      }
    } else {
      const retryLabel = options?.retryLabel;
      if (retryLabel) {
        const action = await vscode.window.showWarningMessage(
          `${name} failed (exit code ${code}).`,
          retryLabel,
        );
        if (action === retryLabel) {
          if (options.onRetry) {
            options.onRetry();
          } else {
            void runInTerminal(name, command, cwd, options);
          }
        }
      } else {
        vscode.window.showWarningMessage(`${name} failed (exit code ${code}).`);
      }
    }
  });

  return terminal;
}

// ── dotnet spawn helpers ──────────────────────────────────────────────────────

export function targetPath(target: BuildTarget): string {
  return target.kind === 'solution' ? target.path : target.entry.csprojPath;
}

export function targetLabel(target: BuildTarget): string {
  return target.kind === 'solution' ? target.name : target.entry.name;
}

export interface SpawnDotnetOptions {
  timeoutMs?: number;
  reveal?: boolean;
  channel?: vscode.OutputChannel;
}

export async function spawnDotnet(
  args: string[],
  cwd: string,
  options?: SpawnDotnetOptions,
): Promise<SpawnManagedResult> {
  const channel = options?.channel ?? dotnetOutput;
  if (options?.reveal) {
    channel.clear();
  }
  channel.appendLine(`> dotnet ${args.join(' ')}`);
  if (options?.reveal) {
    channel.show(true);
  }
  return spawnManaged('dotnet', args, {
    cwd,
    shell: false,
    timeoutMs: options?.timeoutMs,
    onStdout: (chunk) => channel.append(chunk),
    onStderr: (chunk) => channel.append(chunk),
  });
}

export function buildDotnetTerminalCommand(args: string[]): string {
  return buildTerminalCommand(['dotnet', ...args]);
}

export function projectArg(csprojPath: string): string[] {
  return ['--project', csprojPath];
}

export function revealInExplorer(fileUri: vscode.Uri): void {
  void vscode.commands.executeCommand('revealInExplorer', fileUri);
}
