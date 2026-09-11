import * as fs from 'fs/promises';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { asObject, type DependencyGraph, type DependencyNode, type DependencyKind } from './nuget-graph';
import { checkCancelled, readBounded, contained } from './security-files';

export interface RestoreProject { file: string; assets?: Record<string, unknown>; diagnostics: string[] }
const excluded = new Set(['.git', '.vs', 'node_modules', 'bin', 'obj', 'packages', '.vscode-test']);
/** Read restore snapshots without evaluating MSBuild or executing project targets. */
export async function readRestoreProjects(root: string, signal?: AbortSignal): Promise<RestoreProject[]> {
  const projects: string[] = [], assets: Record<string, unknown>[] = [];
  let entries = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    checkCancelled(signal);
    if (depth > 32) { throw new Error('Workspace directory depth limit exceeded.'); }
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (++entries > 100000) { throw new Error('Workspace discovery limit exceeded.'); }
      if (item.isSymbolicLink()) { continue; }
      const file = path.join(directory, item.name);
      if (item.isDirectory() && !excluded.has(item.name)) { await walk(file, depth + 1); }
      else if (item.isFile() && /\.(cs|fs|vb)proj$/i.test(item.name)) { projects.push(file); }
      else if (item.isFile() && item.name === 'project.assets.json') {
        try { assets.push(asObject(JSON.parse((await readBounded(file, 64 * 1024 * 1024)).toString()))); } catch { /* Conventional path below reports errors. */ }
      }
    }
  }
  await walk(root, 0);
  if (!projects.length) { throw new Error('No .NET projects found in this workspace.'); }
  const result: RestoreProject[] = [];
  for (const file of projects.sort()) {
    checkCancelled(signal);
    const project: RestoreProject = { file, diagnostics: [] };
    try { project.assets = asObject(JSON.parse((await readBounded(path.join(path.dirname(file), 'obj', 'project.assets.json'), 64 * 1024 * 1024)).toString())); }
    catch { project.assets = assets.find(asset => path.resolve(String(asObject(asObject(asset.project).restore).projectPath)) === file); }
    if (!project.assets || !Object.keys(asObject(project.assets.targets)).length || !project.assets.libraries || Array.isArray(project.assets.libraries) || typeof project.assets.libraries !== 'object') {
      project.assets = undefined;
      project.diagnostics.push(`${path.relative(root, file)}: restore data missing or invalid. Run .NET: Restore, then Refresh. Custom intermediate directories must be inside the workspace and outside excluded directories.`);
    } else {
      const assetProject = asObject(project.assets.project);
      const owner = asObject(assetProject.restore).projectPath;
      if (typeof owner === 'string' && path.resolve(owner) !== file) {
        project.assets = undefined;
        project.diagnostics.push(`${file}: restore snapshot belongs to a different project. Restore again.`);
      }
      if (project.assets && Array.isArray(project.assets.logs)) {
        for (const raw of project.assets.logs) {
          const log = asObject(raw);
          if (String(log.level).toLowerCase() === 'error') { project.diagnostics.push(`${path.relative(root, file)}: ${String(log.code)} ${String(log.message)}`); }
        }
      }
    }
    result.push(project);
  }
  return result;
}

export async function loadNugetDependencyGraph(root: string, signal?: AbortSignal): Promise<DependencyGraph> {
  return buildNugetGraph(root, await readRestoreProjects(root, signal));
}

export async function buildNugetGraph(root: string, projects: RestoreProject[]): Promise<DependencyGraph> {
  const graph: DependencyGraph = { root, source: projects.some(p => p.assets) ? 'Restored' : 'Declared only', nodes: [], edges: [], diagnostics: projects.flatMap(p => p.diagnostics) };
  const nodes = new Map<string, DependencyNode>();
  const add = (id: string, name: string, kinds: DependencyKind[], version?: string, status: string[] = [], file?: string) => {
    if (!nodes.has(id)) { nodes.set(id, { id, name, version, kinds, status, path: file }); }
  };
  const edge = (source: string, target: string, name: string, kinds: DependencyKind[], requested?: string) => {
    graph.edges.push({ id: JSON.stringify([source, target, graph.edges.length]), source, target, name, kinds, requested });
  };
  add(root, path.basename(root), [], undefined, ['Workspace']);
  for (const project of projects) {
    const projectId = project.file;
    add(projectId, path.relative(root, project.file), ['project'], undefined, ['Project'], project.file);
    edge(root, projectId, path.basename(project.file), ['project']);
    if (!project.assets) {
      try {
        const xml = new XMLParser({ ignoreAttributes: false }).parse((await readBounded(project.file, 5 * 1024 * 1024)).toString());
        const visit = (value: unknown): void => {
          const obj = asObject(value);
          for (const [key, child] of Object.entries(obj)) {
            if (key === 'PackageReference' || key === 'ProjectReference') {
              for (const raw of Array.isArray(child) ? child : [child]) {
                const item = asObject(raw), name = String(item['@_Include'] ?? item['@_Update'] ?? '');
                if (!name) { continue; }
                const id = `${projectId}:declared:${name}`;
                const kind = key === 'PackageReference' ? 'package' : 'project';
                add(id, name, [kind], String(item['@_Version'] ?? item.Version ?? 'unresolved'), ['Declared only']);
                edge(projectId, id, name, [kind]);
              }
            } else if (Array.isArray(child)) { child.forEach(visit); } else if (typeof child === 'object') { visit(child); }
          }
        };
        visit(xml);
      } catch (error) { graph.diagnostics.push(`${project.file}: ${String(error)}`); }
      continue;
    }
    const asset = project.assets, libraries = asObject(asset.libraries);
    const frameworks = asObject(asObject(asset.project).frameworks);
    for (const [target, raw] of Object.entries(asObject(asset.targets))) {
      const targetId = `${projectId}:${target}`, resolved = asObject(raw), byName = new Map<string, string>();
      add(targetId, target, ['framework'], undefined, ['Framework / runtime']);
      edge(projectId, targetId, target, ['framework']);
      for (const [key, value] of Object.entries(resolved)) {
        const slash = key.lastIndexOf('/'), name = key.slice(0, slash), version = key.slice(slash + 1), info = asObject(value);
        const id = `${targetId}:${key}`, kind = info.type === 'project' ? 'project' : 'package';
        byName.set(name.toLowerCase(), id);
        const library = asObject(libraries[key]);
        const projectPath = typeof library.msbuildProject === 'string' ? path.resolve(path.dirname(project.file), library.msbuildProject) : undefined;
        add(id, name, [kind], version, [info.type === 'project' ? 'Project reference' : 'Resolved in restore snapshot'], projectPath);
      }
      const connect = (source: string, name: string, requested?: string) => {
        let id = byName.get(name.toLowerCase());
        if (!id) { id = `${targetId}:missing:${name}`; add(id, name, ['package'], undefined, ['missing']); }
        edge(source, id, name, nodes.get(id)!.kinds, requested);
      };
      for (const [key, value] of Object.entries(resolved)) {
        for (const [name, range] of Object.entries(asObject(asObject(value).dependencies))) { connect(`${targetId}:${key}`, name, String(range)); }
      }
      const framework = asObject(frameworks[target.split('/')[0]]);
      for (const [name, info] of Object.entries(asObject(framework.dependencies))) { connect(targetId, name, String(asObject(info).version ?? '')); }
      const restoreFramework = asObject(asObject(asObject(asset.project).restore).frameworks);
      for (const reference of Object.keys(asObject(asObject(restoreFramework[target.split('/')[0]]).projectReferences))) {
        const referencePath = path.resolve(path.dirname(project.file), reference);
        const entry = Object.entries(libraries).find(([, value]) => {
          const file = asObject(value).msbuildProject;
          return typeof file === 'string' && path.resolve(path.dirname(project.file), file) === referencePath;
        });
        if (entry && resolved[entry[0]]) { connect(targetId, entry[0].slice(0, entry[0].lastIndexOf('/'))); }
      }
      // Some older assets omit project.frameworks; preserve their top-level dependency groups.
      if (!Object.keys(framework).length) {
        const group = asObject(asset.projectFileDependencyGroups)[target.split('/')[0]];
        if (Array.isArray(group)) { for (const item of group) { if (typeof item === 'string') { connect(targetId, item.split(' ')[0], item); } } }
      }
    }
  }
  graph.nodes = [...nodes.values()];
  graph.diagnostics.unshift('Graph uses the last restore snapshot. Restore after changing project files, central package versions, or build properties.');
  return graph;
}

export function safePackagePath(folder: string, relative: string): string {
  const file = path.resolve(folder, relative);
  if (!contained(folder, file)) { throw new Error('Package path escapes the NuGet cache.'); }
  return file;
}
