import * as fs from 'fs/promises';
import * as path from 'path';
import { asObject } from './nuget-graph';
import { packageFinding } from './security-catalog';
import { checkCancelled, contained, errorMessage } from './security-files';
import { spawnManaged, type SpawnManagedResult } from './managed-process';
import { SECURITY_LIMITS, type InstalledPackage, type ScanCoverage, type SecurityFinding, type Severity } from './security-types';
import { readRestoreProjects } from './nuget-graph-loader';

export function parseAudit(data: unknown, packages: InstalledPackage[]): { findings: SecurityFinding[]; diagnostics: string[] } {
  const audit = asObject(data), findings = new Map<string, SecurityFinding>(), diagnostics: string[] = [];
  if (audit.version !== 1 || !Array.isArray(audit.projects) || !audit.projects.length) { throw new Error('Unsupported or empty NuGet audit JSON (requires .NET SDK 7.0.200 or later).'); }
  const problems = (value: Record<string, unknown>) => {
    if (Array.isArray(value.problems)) { for (const problem of value.problems) { diagnostics.push(String(asObject(problem).text ?? JSON.stringify(problem))); } }
  };
  problems(audit);
  for (const raw of audit.projects) {
    const project = asObject(raw); problems(project);
    if (!Array.isArray(project.frameworks) || !project.frameworks.length) { diagnostics.push(`${String(project.path)}: no framework audit results.`); continue; }
    for (const rawFramework of project.frameworks) {
      const framework = asObject(rawFramework); problems(framework);
      for (const field of ['topLevelPackages', 'transitivePackages']) {
        if (framework[field] !== undefined && !Array.isArray(framework[field])) { throw new Error('Malformed NuGet package list.'); }
        for (const rawPackage of (framework[field] as unknown[] | undefined) ?? []) {
          const item = asObject(rawPackage);
          if (!Array.isArray(item.vulnerabilities)) { continue; }
          const affected = packages.filter(pkg => pkg.name.toLowerCase() === String(item.id).toLowerCase() && pkg.version === item.resolvedVersion
            && (typeof project.path !== 'string' || pkg.locations.some(location => path.resolve(location) === path.resolve(project.path as string))));
          if (!affected.length) { diagnostics.push(`${String(item.id)}: advisory could not be mapped to the restored version; restore and rescan.`); }
          for (const pkg of affected) {
            for (const rawVulnerability of item.vulnerabilities) {
              const vulnerability = asObject(rawVulnerability), url = vulnerability.advisoryurl ?? vulnerability.advisoryUrl;
              if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) { diagnostics.push(`${pkg.name}: invalid advisory URL.`); continue; }
              const severity = String(vulnerability.severity).toLowerCase();
              const finding = packageFinding(pkg, 'vulnerability', url);
              findings.set(finding.id, { ...finding, severity: (['low', 'moderate', 'high', 'critical'].includes(severity) ? severity : 'moderate') as Severity,
                confidence: 'high', title: `NuGet advisory affecting ${pkg.name}`, description: `NuGet reports ${pkg.name} ${pkg.version} as vulnerable (${String(framework.framework)}).`,
                recommendation: 'Review the advisory and upgrade the direct dependency or the parent that introduces this transitive package. Restore and rescan after updating.', references: [url] });
            }
          }
        }
      }
    }
  }
  return { findings: [...findings.values()], diagnostics };
}

async function findDotnet(root: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory) || contained(root, directory)) { continue; }
    try {
      const candidate = await fs.realpath(path.join(directory, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'));
      if (!contained(root, candidate) && (await fs.stat(candidate)).isFile()) { return candidate; }
    } catch { /* Try next system PATH directory. */ }
  }
  throw new Error('dotnet SDK executable not found on the system PATH.');
}
export async function runNugetAudit(root: string, packages: InstalledPackage[], enabled: boolean, signal?: AbortSignal,
  runner?: () => Promise<SpawnManagedResult>): Promise<{ findings: SecurityFinding[]; coverage: ScanCoverage }> {
  const coverage: ScanCoverage = { component: 'nuget-audit', state: 'complete', messages: [], checked: 0 }, findings = new Map<string, SecurityFinding>();
  if (!enabled) { coverage.state = 'skipped'; coverage.messages.push('Live NuGet audit disabled in settings.'); return { findings: [], coverage }; }
  try {
    const projects = await readRestoreProjects(root, signal);
    const executable = runner ? '' : await findDotnet(root);
    const common = { cwd: root, shell: false, timeoutMs: SECURITY_LIMITS.auditMs, maxOutputBytes: SECURITY_LIMITS.outputBytes, signal };
    for (const project of projects) {
      checkCancelled(signal);
      if (!project.assets) { coverage.state = 'partial'; coverage.messages.push(`${project.file}: no restore data; audit skipped.`); continue; }
      // Probe in the project's directory so nested global.json files select the same SDK for both calls.
      // Older SDKs do not accept --no-restore and never auto-restore for this command.
      const help = runner ? undefined : await spawnManaged(executable, ['list', 'package', '--help'], { ...common, cwd: path.dirname(project.file) });
      checkCancelled(signal);
      if (help && (help.exitCode !== 0 || help.timedOut || help.outputLimited || !help.standardOutput.includes('--format'))) {
        coverage.state = 'partial'; coverage.messages.push(`${project.file}: NuGet JSON audit requires .NET SDK 7.0.200 or later. Check global.json and the installed SDK.`); continue;
      }
      const args = ['list', project.file, 'package', '--vulnerable', '--include-transitive', '--format', 'json', '--output-version', '1'];
      if (help?.standardOutput.includes('--no-restore')) { args.push('--no-restore'); }
      const result = runner ? await runner() : await spawnManaged(executable, args, { ...common, cwd: path.dirname(project.file) });
      checkCancelled(signal);
      if (result.timedOut || result.outputLimited || result.exitCode !== 0) {
        coverage.state = 'partial'; coverage.messages.push(`${project.file}: audit failed${result.timedOut ? ' (timeout)' : ''}: ${result.standardError.slice(0, 1000) || result.standardOutput.slice(0, 1000)}`); continue;
      }
      const parsed = parseAudit(JSON.parse(result.standardOutput), packages);
      parsed.findings.forEach(finding => findings.set(finding.id, finding));
      coverage.checked++;
      if (parsed.diagnostics.length || result.standardError.trim()) { coverage.state = 'partial'; coverage.messages.push(...parsed.diagnostics, ...(result.standardError.trim() ? [result.standardError.slice(0, 2000)] : [])); }
    }
    coverage.messages.push('Checked count is projects audited. Includes direct and transitive NuGet advisories from configured audit/package sources.');
  } catch (error) { checkCancelled(signal); coverage.state = 'failed'; coverage.messages.push(errorMessage(error)); }
  return { findings: [...findings.values()], coverage };
}
