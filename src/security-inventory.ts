import * as fs from 'fs/promises';
import * as path from 'path';
import { asObject } from './nuget-graph';
import { readRestoreProjects, buildNugetGraph, safePackagePath, type RestoreProject } from './nuget-graph-loader';
import { DependencyGraphIndex } from './nuget-graph-view-model';
import { checkCancelled, safeRealpath } from './security-files';
import { SECURITY_LIMITS, type InstalledPackage, type ScanCoverage } from './security-types';
export interface PackageInventory { root: string; projects: RestoreProject[]; packages: InstalledPackage[]; coverage: ScanCoverage }
export async function collectPackages(workspaceRoot: string, signal?: AbortSignal): Promise<PackageInventory> {
  const root = await fs.realpath(workspaceRoot), projects = await readRestoreProjects(root, signal);
  const graph = await buildNugetGraph(root, projects), index = new DependencyGraphIndex(graph);
  const graphPackages = new Map(graph.nodes.map(node => [`${node.name.toLowerCase()}/${node.version}`, node]));
  const packages = new Map<string, InstalledPackage>();
  const coverage: ScanCoverage = { component: 'inventory', state: projects.every(p => p.assets && !p.diagnostics.length) ? 'complete' : 'partial', checked: 0, messages: projects.flatMap(p => p.diagnostics) };
  coverage.messages.push('Inventory reflects the last NuGet restore, not unevaluated project edits.');
  for (const project of projects) {
    checkCancelled(signal);
    if (!project.assets) { continue; }
    for (const [key, value] of Object.entries(asObject(project.assets.libraries))) {
      const library = asObject(value);
      if (library.type !== 'package') { continue; }
      const slash = key.lastIndexOf('/'), name = key.slice(0, slash), version = key.slice(slash + 1);
      if (packages.size >= SECURITY_LIMITS.packages) { throw new Error('Package inventory limit exceeded.'); }
      let directory: string | undefined;
      for (const folder of Object.keys(asObject(project.assets.packageFolders))) {
        try {
          const cache = await fs.realpath(folder);
          const candidate = await safeRealpath(cache, safePackagePath(cache, String(library.path ?? `${name.toLowerCase()}/${version}`)));
          if ((await fs.stat(candidate)).isDirectory()) { directory = candidate; break; }
        } catch { /* Try alternate NuGet cache. */ }
      }
      const id = directory ?? `${name}/${version}`;
      if (!directory) { coverage.state = 'partial'; coverage.messages.push(`${key}: restored package directory is missing or unsafe. Restore packages again.`); }
      const existing = packages.get(id);
      if (existing) { existing.locations.push(project.file); continue; }
      const graphNode = graphPackages.get(`${name.toLowerCase()}/${version}`);
      packages.set(id, { id, name, version, directory: directory ?? '', manifest: library, locations: [project.file], kinds: ['package'], workspace: false,
        dependencyPath: graphNode ? index.shortestPath(graphNode.id).map(id => index.nodes.get(id)!.name) : [path.basename(project.file), name] });
    }
  }
  coverage.checked = packages.size;
  return { root, projects, packages: [...packages.values()], coverage };
}
