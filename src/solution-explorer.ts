import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type {
  PackageReferenceInfo,
  ProjectEntry,
  ProjectTarget,
  SlnHierarchyNode,
  SolutionTarget,
} from './types';
import { findProjectFiles, findSolutionFiles, loadCsproj } from './utils';
import {
  buildSolutionHierarchy,
  isRunnableProject,
  normalizePathKey,
  parseSln,
  parseSlnNested,
  parseSlnxDetailed,
} from './pure-utils';
import { logDiagnostic } from './state';

const REFRESH_DEBOUNCE_MS = 250;

export type SolutionExplorerNodeKind =
  | 'solution'
  | 'discovered'
  | 'folder'
  | 'project'
  | 'refs'
  | 'projectRef'
  | 'packageRef';

export interface SolutionExplorerNode {
  kind: SolutionExplorerNodeKind;
  label: string;
  /** Workspace root the node belongs to (used as terminal cwd for node actions). */
  root: string;
  /** Solution file the node was reached through. */
  slnPath?: string;
  /** Solution folder identity (guid or slnx folder path). */
  folderPath?: string;
  /** Project entry (project nodes; source project for reference nodes). */
  entry?: ProjectEntry;
  /** Absolute target path (projectRef nodes). */
  refPath?: string;
  /** The referenced project file does not exist on disk. */
  broken?: boolean;
  /** Package info (packageRef nodes). */
  pkg?: PackageReferenceInfo;
  /** Reference group kind (refs nodes). */
  refsKind?: 'project' | 'package';
  children?: SolutionExplorerNode[];
}

function openFileCommand(filePath?: string): vscode.Command | undefined {
  if (!filePath) {
    return undefined;
  }
  return {
    title: 'Open File',
    command: 'vscode.open',
    arguments: [vscode.Uri.file(filePath)],
  };
}

function projectIcon(csproj: ProjectEntry['csproj']): string {
  if (!csproj) {
    return 'file-code';
  }
  if (csproj.isTestProject) {
    return 'beaker';
  }
  if (csproj.isWeb) {
    return 'globe';
  }
  if (csproj.outputType === 'WinExe') {
    return 'window';
  }
  if (csproj.outputType === 'Exe') {
    return 'terminal';
  }
  return 'file-code';
}

export class SolutionExplorerProvider implements vscode.TreeDataProvider<SolutionExplorerNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SolutionExplorerNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: SolutionExplorerNode[] = [];
  private building: Promise<void> | null = null;
  private readonly disposables: vscode.Disposable[] = [this._onDidChangeTreeData];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,slnx,csproj,fsproj,vbproj}');
    const scheduleRefresh = (): void => {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        this.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(scheduleRefresh),
      watcher.onDidCreate(scheduleRefresh),
      watcher.onDidDelete(scheduleRefresh),
    );
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SolutionExplorerNode): vscode.TreeItem {
    switch (element.kind) {
      case 'solution': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('root-folder');
        item.contextValue = 'dotnetSolution';
        item.tooltip = element.slnPath;
        item.command = openFileCommand(element.slnPath);
        return item;
      }
      case 'discovered': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('file-directory');
        item.contextValue = 'dotnetDiscovered';
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('file-directory');
        item.contextValue = 'dotnetFolder';
        item.tooltip = path.join(path.dirname(element.slnPath ?? ''), element.folderPath ?? element.label);
        return item;
      }
      case 'project': {
        const csproj = element.entry?.csproj ?? null;
        const hasChildren = (element.children ?? []).length > 0;
        const item = new vscode.TreeItem(
          element.label,
          hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(projectIcon(csproj));
        item.description = csproj?.targetFrameworks.join(', ');
        item.tooltip = element.entry?.csprojPath;
        const flags = ['dotnetProject'];
        if (isRunnableProject(csproj)) {
          flags.push('runnable');
        }
        if (csproj?.isTestProject) {
          flags.push('test');
        }
        item.contextValue = flags.join(' ');
        item.command = openFileCommand(element.entry?.csprojPath);
        return item;
      }
      case 'refs': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(element.refsKind === 'package' ? 'package' : 'references');
        item.contextValue = 'dotnetRefs';
        return item;
      }
      case 'projectRef': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(element.broken ? 'error' : 'link');
        item.contextValue = 'dotnetProjectRef';
        item.tooltip = element.refPath;
        if (element.broken) {
          item.description = 'not found';
        } else if (element.refPath && element.root) {
          const relative = path.relative(element.root, element.refPath);
          if (relative && !relative.startsWith('..')) {
            item.description = relative;
          }
        }
        item.command = element.broken ? undefined : openFileCommand(element.refPath);
        return item;
      }
      case 'packageRef': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('package');
        item.description = element.pkg?.version;
        item.tooltip = element.pkg
          ? `${element.pkg.id}${element.pkg.version ? ` ${element.pkg.version}` : ''} — ${element.entry?.name}`
          : undefined;
        item.contextValue = 'dotnetPackageRef';
        return item;
      }
    }
  }

  async getChildren(element?: SolutionExplorerNode): Promise<SolutionExplorerNode[]> {
    if (!element) {
      await this.ensureLoaded();
      return this.roots;
    }
    return element.children ?? [];
  }

  private ensureLoaded(): Promise<void> {
    if (!this.building) {
      this.building = this.rebuild().finally(() => {
        this.building = null;
      });
    }
    return this.building;
  }

  private async rebuild(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.roots = [];
      return;
    }

    const seenSln = new Set<string>();
    const rootSlns = new Map<string, string[]>();
    for (const folder of folders) {
      const root = folder.uri.fsPath;
      const rootPrefix = normalizePathKey(root) + path.sep;
      const solutions: string[] = [];
      for (const slnPath of await findSolutionFiles(root)) {
        const key = normalizePathKey(slnPath);
        if (seenSln.has(key) || !key.startsWith(rootPrefix)) {
          continue;
        }
        seenSln.add(key);
        solutions.push(slnPath);
      }
      rootSlns.set(normalizePathKey(root), solutions);
    }

    // Phase A: parse hierarchies and load every referenced project entry.
    const allEntries = new Map<string, ProjectEntry>();
    interface SolutionData {
      slnPath: string;
      root: string;
      hierarchy: SlnHierarchyNode[];
    }
    const solutions: SolutionData[] = [];
    for (const folder of folders) {
      const root = folder.uri.fsPath;
      for (const slnPath of rootSlns.get(normalizePathKey(root)) ?? []) {
        solutions.push({ slnPath, root, hierarchy: await parseSolutionHierarchy(slnPath) });
      }
    }

    const collectPaths = async (nodes: SlnHierarchyNode[], slnDir: string): Promise<void> => {
      for (const node of nodes) {
        if (node.project) {
          const csprojPath = path.resolve(slnDir, node.project.relativePath);
          if (!allEntries.has(normalizePathKey(csprojPath))) {
            const entry = await loadProjectEntry(csprojPath, node.project.name);
            if (entry) {
              allEntries.set(normalizePathKey(csprojPath), entry);
            }
          }
        }
        await collectPaths(node.children, slnDir);
      }
    };
    for (const solution of solutions) {
      await collectPaths(solution.hierarchy, path.dirname(solution.slnPath));
    }

    const roots: SolutionExplorerNode[] = [];

    // Phase B: convert hierarchies to nodes (references resolved against allEntries).
    const toNodes = (nodes: SlnHierarchyNode[], root: string, slnPath: string): SolutionExplorerNode[] => {
      const result: SolutionExplorerNode[] = [];
      for (const node of nodes) {
        if (node.project) {
          const csprojPath = path.resolve(path.dirname(slnPath), node.project.relativePath);
          const entry = allEntries.get(normalizePathKey(csprojPath));
          if (entry) {
            result.push(projectNode(entry, root, slnPath, allEntries));
          }
        } else {
          result.push({
            kind: 'folder',
            label: node.label,
            root,
            slnPath,
            folderPath: node.folderGuid ?? node.label,
            children: toNodes(node.children, root, slnPath),
          });
        }
      }
      return result;
    };

    for (const folder of folders) {
      const root = folder.uri.fsPath;
      const rootKey = normalizePathKey(root);
      const inRootSolutions = new Set<string>();
      for (const solution of solutions) {
        if (solution.root !== root) {
          continue;
        }
        roots.push({
          kind: 'solution',
          label: path.basename(solution.slnPath),
          root,
          slnPath: solution.slnPath,
          children: toNodes(solution.hierarchy, root, solution.slnPath),
        });
        collectProjectKeys(solution.hierarchy, path.dirname(solution.slnPath), inRootSolutions);
      }

      // Projects in this root that are not part of any of its solutions.
      const discovered: SolutionExplorerNode[] = [];
      for (const csprojPath of await findProjectFiles(root)) {
        const key = normalizePathKey(csprojPath);
        if (inRootSolutions.has(key)) {
          continue;
        }
        let entry = allEntries.get(key);
        if (!entry) {
          const loaded = await loadProjectEntry(csprojPath);
          if (loaded) {
            allEntries.set(key, loaded);
            entry = loaded;
          }
        }
        if (entry) {
          discovered.push(projectNode(entry, root, undefined, allEntries));
        }
      }
      if (discovered.length > 0) {
        roots.push({
          kind: 'discovered',
          label: 'Discovered projects (not in a solution)',
          root,
          children: discovered,
        });
      }
    }

    this.roots = roots;
  }
}

async function parseSolutionHierarchy(slnPath: string): Promise<SlnHierarchyNode[]> {
  try {
    const content = await fs.promises.readFile(slnPath, 'utf-8');
    if (slnPath.toLowerCase().endsWith('.slnx')) {
      return parseSlnxDetailed(content) ?? [];
    }
    const projects = parseSln(content);
    return projects ? buildSolutionHierarchy(projects, parseSlnNested(content)) : [];
  } catch (err) {
    logDiagnostic(`Solution Explorer: failed to parse ${slnPath}: ${err}`);
    return [];
  }
}

async function loadProjectEntry(csprojPath: string, name?: string): Promise<ProjectEntry | null> {
  if (!fs.existsSync(csprojPath)) {
    return null;
  }
  const csproj = await loadCsproj(csprojPath);
  if (!csproj) {
    return null;
  }
  return {
    name: name || path.basename(csprojPath, path.extname(csprojPath)),
    csprojPath,
    csproj,
  };
}

function collectProjectKeys(nodes: SlnHierarchyNode[], slnDir: string, keys: Set<string>): void {
  for (const node of nodes) {
    if (node.project) {
      keys.add(normalizePathKey(path.resolve(slnDir, node.project.relativePath)));
    }
    collectProjectKeys(node.children, slnDir, keys);
  }
}

function projectNode(
  entry: ProjectEntry,
  root: string,
  slnPath: string | undefined,
  allEntries: Map<string, ProjectEntry>,
): SolutionExplorerNode {
  const csproj = entry.csproj!;

  const projectRefs: SolutionExplorerNode[] = (csproj.projectReferences ?? []).map((reference) => {
    const refPath = path.resolve(path.dirname(entry.csprojPath), reference);
    const target = allEntries.get(normalizePathKey(refPath));
    const broken = !target && !fs.existsSync(refPath);
    return {
      kind: 'projectRef' as const,
      label: target?.name ?? path.basename(refPath, path.extname(refPath)),
      root,
      slnPath,
      entry,
      refPath,
      broken,
    };
  });
  const packageRefs: SolutionExplorerNode[] = csproj.packageReferences.map((pkg) => ({
    kind: 'packageRef' as const,
    label: pkg.id,
    root,
    slnPath,
    entry,
    pkg,
  }));

  const children: SolutionExplorerNode[] = [];
  if (projectRefs.length > 0) {
    children.push({
      kind: 'refs',
      label: 'Project References',
      root,
      slnPath,
      entry,
      refsKind: 'project',
      children: projectRefs,
    });
  }
  if (packageRefs.length > 0) {
    children.push({
      kind: 'refs',
      label: 'Package References',
      root,
      slnPath,
      entry,
      refsKind: 'package',
      children: packageRefs,
    });
  }
  return { kind: 'project', label: entry.name, root, slnPath, entry, children };
}

// ── Command argument coercion (tree node → pre-resolved command target) ──────

export function asProjectTarget(node: unknown): ProjectTarget | undefined {
  const candidate = node as Partial<SolutionExplorerNode> | undefined;
  if (
    candidate &&
    (candidate.kind === 'project' || candidate.kind === 'projectRef') &&
    candidate.entry &&
    typeof candidate.root === 'string'
  ) {
    return { root: candidate.root, entry: candidate.entry, slnPath: candidate.slnPath };
  }
  return undefined;
}

export function asBuildTargetArg(node: unknown): SolutionTarget | ProjectTarget | undefined {
  const candidate = node as Partial<SolutionExplorerNode> | undefined;
  if (candidate?.kind === 'solution' && typeof candidate.slnPath === 'string' && typeof candidate.root === 'string') {
    return { root: candidate.root, slnPath: candidate.slnPath };
  }
  return asProjectTarget(node);
}

export function asRefPath(node: unknown): string | undefined {
  const candidate = node as Partial<SolutionExplorerNode> | undefined;
  return candidate?.kind === 'projectRef' ? candidate.refPath : undefined;
}
