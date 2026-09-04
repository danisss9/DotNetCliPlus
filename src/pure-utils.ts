import * as path from 'path';
import type {
  CsprojInfo,
  DotnetTemplate,
  LaunchProfile,
  MsbuildIssue,
  NuGetSearchResult,
  ProjectOutdatedPackages,
  RuntimeInfo,
  SdkInfo,
  SlnProject,
} from './types';

export const SOLUTION_FOLDER_TYPE_GUID = '2150E333-8FDC-42A3-9474-1A3956D46DE8';

export function normalizePathKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

export function quoteShellPath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath.replace(/"/g, '\\"')}"` : filePath;
}

export function escapeShellArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function buildTerminalCommand(parts: string[]): string {
  return parts.map(escapeShellArg).join(' ');
}

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ── Solution parsing ──────────────────────────────────────────────────────────

const SLN_PROJECT_LINE =
  /^Project\("\{?([0-9A-Fa-f-]+)\}?"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"\{?([0-9A-Fa-f-]+)\}?"\s*$/gm;

export function parseSln(content: string): SlnProject[] | null {
  const projects: SlnProject[] = [];
  SLN_PROJECT_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SLN_PROJECT_LINE.exec(content)) !== null) {
    const typeGuid = match[1].toUpperCase();
    projects.push({
      name: match[2],
      relativePath: match[3].replace(/\\/g, path.sep),
      typeGuid,
      projectGuid: match[4].toUpperCase(),
      isSolutionFolder: typeGuid === SOLUTION_FOLDER_TYPE_GUID,
    });
  }
  if (projects.length === 0 && !/Microsoft Visual Studio Solution File/.test(content)) {
    return null;
  }
  return projects;
}

export function parseSlnx(content: string): string[] | null {
  if (!/<Solution/i.test(content)) {
    return null;
  }
  const paths: string[] = [];
  const re = /<Project\b[^>]*\bPath="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    paths.push(match[1].replace(/\\/g, path.sep));
  }
  return paths;
}

// ── Project (csproj) parsing ──────────────────────────────────────────────────

function readTag(content: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(content);
  return match ? match[1] : undefined;
}

export function parseCsproj(content: string): CsprojInfo | null {
  const sdkMatch = /<Project\b[^>]*\sSdk="([^"]+)"/.exec(content);
  if (!sdkMatch) {
    return null;
  }
  const sdk = sdkMatch[1];

  const targetFrameworks: string[] = [];
  const multi = readTag(content, 'TargetFrameworks');
  if (multi) {
    targetFrameworks.push(
      ...multi
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  } else {
    const single = readTag(content, 'TargetFramework');
    if (single) {
      targetFrameworks.push(single);
    }
  }

  const packageReferences: Array<{ id: string; version?: string }> = [];
  const pkgTagRe = /<PackageReference\b([^>]*)>/g;
  let pkgMatch: RegExpExecArray | null;
  while ((pkgMatch = pkgTagRe.exec(content)) !== null) {
    const attrs = pkgMatch[1];
    const includeMatch = /\bInclude="([^"]+)"/.exec(attrs);
    if (!includeMatch) {
      continue;
    }
    const versionMatch = /\bVersion="([^"]*)"/.exec(attrs);
    packageReferences.push({ id: includeMatch[1], version: versionMatch?.[1] || undefined });
  }

  const projectReferences: string[] = [];
  const projTagRe = /<ProjectReference\b([^>]*)>/g;
  let projMatch: RegExpExecArray | null;
  while ((projMatch = projTagRe.exec(content)) !== null) {
    const includeMatch = /\bInclude="([^"]+)"/.exec(projMatch[1]);
    if (includeMatch) {
      projectReferences.push(includeMatch[1].replace(/\\/g, path.sep));
    }
  }

  const isTestProject = /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(content) ||
    packageReferences.some((p) => p.id === 'Microsoft.NET.Test.Sdk');

  const packableRaw = readTag(content, 'IsPackable');

  return {
    sdk,
    sdkStyle: true,
    isWeb: sdk === 'Microsoft.NET.Sdk.Web',
    targetFrameworks,
    outputType: readTag(content, 'OutputType') ?? 'Library',
    assemblyName: readTag(content, 'AssemblyName'),
    rootNamespace: readTag(content, 'RootNamespace'),
    isPackable: packableRaw === undefined ? true : packableRaw.toLowerCase() === 'true',
    isTestProject,
    userSecretsId: readTag(content, 'UserSecretsId'),
    packageReferences,
    projectReferences,
  };
}

export function isRunnableProject(csproj: CsprojInfo | null): boolean {
  if (!csproj) {
    return false;
  }
  return csproj.outputType === 'Exe' || csproj.outputType === 'WinExe' || csproj.isWeb;
}

export function buildProgramPath(
  csprojDir: string,
  targetFramework: string,
  assemblyName: string | undefined,
  projectName: string,
  configuration = 'Debug',
): string {
  return path.join(
    csprojDir,
    'bin',
    configuration,
    targetFramework,
    `${assemblyName || projectName}.dll`,
  );
}

// ── launchSettings.json ───────────────────────────────────────────────────────

export function parseLaunchSettingsProfiles(parsed: unknown): LaunchProfile[] {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const profiles = (parsed as { profiles?: Record<string, unknown> }).profiles;
  if (!profiles || typeof profiles !== 'object') {
    return [];
  }
  const result: LaunchProfile[] = [];
  for (const [name, value] of Object.entries(profiles)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const profile = value as {
      commandName?: unknown;
      applicationUrl?: unknown;
      environmentVariables?: unknown;
    };
    let applicationUrl: string | undefined;
    if (typeof profile.applicationUrl === 'string') {
      applicationUrl = profile.applicationUrl;
    }
    let environmentVariables: Record<string, string> | undefined;
    if (profile.environmentVariables && typeof profile.environmentVariables === 'object') {
      environmentVariables = {};
      for (const [k, v] of Object.entries(
        profile.environmentVariables as Record<string, unknown>,
      )) {
        environmentVariables[k] = String(v);
        if (
          !applicationUrl &&
          k.toUpperCase() === 'ASPNETCORE_URLS' &&
          typeof v === 'string'
        ) {
          applicationUrl = v;
        }
      }
    }
    result.push({
      name,
      commandName: typeof profile.commandName === 'string' ? profile.commandName : undefined,
      applicationUrl,
      environmentVariables,
    });
  }
  return result;
}

// ── MSBuild output parsing ────────────────────────────────────────────────────

const MSBUILD_LINE = /^(.+?)\((\d+)(?:,(\d+))?\):\s*(error|warning)\s+([A-Z][A-Z0-9]*\d+):\s*(.+?)(?:\s+\[([^\[\]]+)\])?$/;
const MSBUILD_BARE = /^(error|warning)\s+([A-Z][A-Z0-9]*\d+):\s*(.+)$/;

export function parseMsbuildIssues(output: string): MsbuildIssue[] {
  const issues: MsbuildIssue[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = MSBUILD_LINE.exec(line);
    if (match) {
      issues.push({
        file: match[1],
        line: Number(match[2]),
        column: match[3] ? Number(match[3]) : undefined,
        severity: match[4] as 'error' | 'warning',
        code: match[5],
        message: match[6].trim(),
        project: match[7],
      });
      continue;
    }
    const bare = MSBUILD_BARE.exec(line);
    if (bare) {
      issues.push({
        severity: bare[1] as 'error' | 'warning',
        code: bare[2],
        message: bare[3].trim(),
      });
    }
  }
  return issues;
}

export function countErrors(issues: MsbuildIssue[]): number {
  return issues.filter((i) => i.severity === 'error').length;
}

// ── SDK / runtime output parsing ──────────────────────────────────────────────

export function parseSdkList(output: string): SdkInfo[] {
  const sdks: SdkInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+\[(.+)\]\s*$/.exec(line.trim());
    if (match) {
      sdks.push({ version: match[1], path: match[2] });
    }
  }
  return sdks;
}

export function parseRuntimeList(output: string): RuntimeInfo[] {
  const runtimes: RuntimeInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\[(.+)\]\s*$/.exec(line.trim());
    if (match) {
      runtimes.push({ name: match[1], version: match[2], path: match[3] });
    }
  }
  return runtimes;
}

// ── dotnet new parsing ────────────────────────────────────────────────────────

const CATEGORY_BY_SHORT: Record<string, string> = {
  console: 'Common',
  classlib: 'Common',
  'console-app': 'Common',
  xunit: 'Test',
  nunit: 'Test',
  mstest: 'Test',
  webapi: 'Web',
  web: 'Web',
  webapp: 'Web',
  mvc: 'Web',
  blazor: 'Web',
  blazorwasm: 'Web',
  razorclasslib: 'Web',
  angular: 'Web',
  react: 'Web',
  vue: 'Web',
  worker: 'Services',
  grpc: 'Services',
  wpf: 'Desktop',
  winforms: 'Desktop',
  winformslib: 'Desktop',
  wpfusercontrollib: 'Desktop',
  wpfcontrollib: 'Desktop',
  wpflib: 'Desktop',
  maui: 'Mobile',
  sln: 'Solution',
  gitignore: 'Files',
  editorconfig: 'Files',
  globaljson: 'Files',
  nugetconfig: 'Files',
  dotnetgitignore: 'Files',
};

export function categorizeTemplate(shortName: string, tags: string): string {
  const mapped = CATEGORY_BY_SHORT[shortName];
  if (mapped) {
    return mapped;
  }
  const first = tags.split('/')[0].trim();
  if (first && /^[a-z]/.test(first)) {
    return first.charAt(0).toUpperCase() + first.slice(1);
  }
  return first || 'Other';
}

export function parseNewListJson(json: unknown): DotnetTemplate[] {
  const root = json as { templates?: unknown } | null;
  if (!root || !Array.isArray(root.templates)) {
    return [];
  }
  const templates: DotnetTemplate[] = [];
  for (const raw of root.templates) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const t = raw as {
      name?: unknown;
      shortName?: unknown;
      type?: unknown;
      languages?: unknown;
      tags?: unknown;
    };
    if (typeof t.shortName !== 'string' || typeof t.name !== 'string') {
      continue;
    }
    const languages = Array.isArray(t.languages) ? t.languages.map(String) : [];
    const tags = typeof t.tags === 'string' ? t.tags : '';
    templates.push({
      name: t.name,
      shortName: t.shortName,
      type: typeof t.type === 'string' ? t.type : 'project',
      languages,
      tags,
      category: categorizeTemplate(t.shortName, tags),
    });
  }
  return templates;
}

export function parseNewListText(text: string): DotnetTemplate[] {
  const templates: DotnetTemplate[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || /^-+\s/.test(line.trim()) || /^Templates\b/i.test(line.trim())) {
      continue;
    }
    const cols = line.trim().split(/\s{2,}/).filter((c) => c.length > 0);
    if (cols.length < 2 || cols.length > 4) {
      continue;
    }
    const name = cols[0];
    const shortName = cols[1];
    if (!/^[a-z][\w.-]*$/i.test(shortName)) {
      continue;
    }
    const tags = cols.length === 4 ? cols[3] : cols.length === 3 ? cols[2] : '';
    templates.push({
      name,
      shortName,
      type: 'project',
      languages: cols.length === 4 ? [cols[2]] : [],
      tags,
      category: categorizeTemplate(shortName, tags),
    });
  }
  return templates;
}

// ── NuGet parsing ─────────────────────────────────────────────────────────────

export function parsePackageSearchJson(json: unknown): NuGetSearchResult[] {
  const root = json as { searchResult?: unknown } | null;
  if (!root || !Array.isArray(root.searchResult)) {
    return [];
  }
  const results: NuGetSearchResult[] = [];
  for (const source of root.searchResult) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    const src = source as { sourceName?: unknown; packages?: unknown };
    const packages = Array.isArray(src.packages) ? src.packages : [];
    for (const raw of packages) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const pkg = raw as { id?: unknown; latestVersion?: unknown };
      if (typeof pkg.id !== 'string') {
        continue;
      }
      results.push({
        id: pkg.id,
        latestVersion: typeof pkg.latestVersion === 'string' ? pkg.latestVersion : '',
        source: typeof src.sourceName === 'string' ? src.sourceName : undefined,
      });
    }
  }
  return results;
}

export function parsePackageListOutdatedJson(json: unknown): ProjectOutdatedPackages[] {
  const root = json as { projects?: unknown } | null;
  if (!root || !Array.isArray(root.projects)) {
    return [];
  }
  const output: ProjectOutdatedPackages[] = [];
  for (const rawProject of root.projects) {
    if (!rawProject || typeof rawProject !== 'object') {
      continue;
    }
    const project = rawProject as { path?: unknown; frameworks?: unknown };
    if (typeof project.path !== 'string') {
      continue;
    }
    const packages: Array<{ id: string; current: string; latest: string }> = [];
    const frameworks = Array.isArray(project.frameworks) ? project.frameworks : [];
    for (const rawFramework of frameworks) {
      if (!rawFramework || typeof rawFramework !== 'object') {
        continue;
      }
      const framework = rawFramework as { topLevelPackages?: unknown };
      const topLevel = Array.isArray(framework.topLevelPackages) ? framework.topLevelPackages : [];
      for (const rawPackage of topLevel) {
        if (!rawPackage || typeof rawPackage !== 'object') {
          continue;
        }
        const pkg = rawPackage as {
          id?: unknown;
          resolvedVersion?: unknown;
          requestedVersion?: unknown;
          latestVersion?: unknown;
        };
        if (typeof pkg.id !== 'string' || typeof pkg.latestVersion !== 'string') {
          continue;
        }
        const current =
          typeof pkg.resolvedVersion === 'string' && pkg.resolvedVersion.length > 0
            ? pkg.resolvedVersion
            : typeof pkg.requestedVersion === 'string'
              ? pkg.requestedVersion
              : '—';
        if (pkg.latestVersion === current) {
          continue;
        }
        if (packages.some((p) => p.id === pkg.id)) {
          continue;
        }
        packages.push({ id: pkg.id, current, latest: pkg.latestVersion });
      }
    }
    if (packages.length > 0) {
      output.push({
        project: path.basename(project.path),
        projectPath: project.path,
        packages,
      });
    }
  }
  return output;
}

export function parseNuGetSourcesList(output: string): Array<{
  name: string;
  url: string;
  enabled: boolean;
}> {
  const sources: Array<{ name: string; url: string; enabled: boolean }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+\.\s+(\S+)\s+(\S+)\s+\[(Enabled|Disabled)\]\s*$/.exec(line);
    if (match) {
      sources.push({
        name: match[1],
        url: match[2],
        enabled: match[3] === 'Enabled',
      });
    }
  }
  return sources;
}

// ── Path matching ─────────────────────────────────────────────────────────────

export function findBestProjectForPath(
  filePath: string,
  projects: Array<{ name: string; csprojPath: string }>,
): string | null {
  let bestName: string | null = null;
  let bestDirLength = -1;
  for (const project of projects) {
    const dir = path.dirname(project.csprojPath);
    const rel = path.relative(dir, filePath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }
    if (dir.length > bestDirLength) {
      bestDirLength = dir.length;
      bestName = project.name;
    }
  }
  return bestName;
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateProjectName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'Project name cannot be empty';
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return 'Project name may only contain letters, digits, ".", "_" and "-"';
  }
  if (trimmed.startsWith('.')) {
    return 'Project name cannot start with "."';
  }
  return null;
}

export function validatePackageId(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    return 'Package id cannot be empty';
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return 'Package id contains invalid characters';
  }
  return null;
}

export function validateTestFilter(filter: string): string | null {
  const trimmed = filter.trim();
  if (trimmed.length === 0) {
    return 'Filter cannot be empty';
  }
  if (/["`]/.test(trimmed)) {
    return 'Filter cannot contain double quotes or backticks';
  }
  return null;
}

const DANGEROUS_COMMAND_TOKENS = new Set([
  'rm',
  'del',
  'rmdir',
  'rd',
  'format',
  'mkfs',
  'shutdown',
  'regedit',
  'reg',
  'diskpart',
  'cipher',
]);

export function validateCustomCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return 'Command cannot be empty';
  }
  if (/\$\(|`|;|\||&|>|</.test(trimmed)) {
    return 'Command cannot contain $(), backticks, ;, |, &, < or >';
  }
  const firstToken = trimmed.split(/\s+/)[0].toLowerCase();
  if (DANGEROUS_COMMAND_TOKENS.has(firstToken)) {
    return `Command cannot start with '${firstToken}'`;
  }
  return null;
}

export function validateNuGetSourceName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'Source name cannot be empty';
  }
  if (/\s/.test(trimmed)) {
    return 'Source name cannot contain spaces';
  }
  return null;
}

// ── Companion file switching ──────────────────────────────────────────────────

export function markupCompanionCandidates(fileName: string): string[] {
  if (fileName.endsWith('.razor.cs')) {
    const base = fileName.slice(0, -3);
    return [base, `${base}.css`];
  }
  if (fileName.endsWith('.razor')) {
    return [`${fileName}.cs`, `${fileName}.css`];
  }
  if (fileName.endsWith('.xaml.cs')) {
    return [fileName.slice(0, -3)];
  }
  if (fileName.endsWith('.xaml')) {
    return [`${fileName}.cs`];
  }
  if (fileName.endsWith('.cshtml.cs')) {
    return [fileName.slice(0, -3)];
  }
  if (fileName.endsWith('.cshtml')) {
    return [`${fileName}.cs`];
  }
  return [];
}

export function isCodeBehindFile(fileName: string): boolean {
  return (
    fileName.endsWith('.razor.cs') ||
    fileName.endsWith('.xaml.cs') ||
    fileName.endsWith('.cshtml.cs')
  );
}

export function testFileCandidates(fileName: string): string[] {
  if (!fileName.endsWith('.cs') || isCodeBehindFile(fileName)) {
    return [];
  }
  const base = fileName.slice(0, -3);
  return [`${base}Tests.cs`, `${base}Test.cs`, `${base}Facts.cs`];
}

export function sourceBaseForTestFile(fileName: string): string | null {
  const match = /^(.*)Tests\.cs$/i.exec(fileName) ?? /^(.*)Test\.cs$/i.exec(fileName) ?? /^(.*)Facts\.cs$/i.exec(fileName);
  return match ? match[1] : null;
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

export function configFlag(configuration: string | undefined): string[] {
  if (configuration === 'debug') {
    return ['-c', 'Debug'];
  }
  if (configuration === 'release') {
    return ['-c', 'Release'];
  }
  return [];
}

export function configurationLabel(configuration: string | undefined): string {
  if (configuration === 'debug') {
    return 'Debug';
  }
  if (configuration === 'release') {
    return 'Release';
  }
  return 'Default';
}
