import type * as vscode from 'vscode';

export type TerminalCommandState = 'running' | 'terminated' | 'errored' | 'killed';

export interface PersistedTerminalEntry {
  command: string;
  cwd: string;
}

export interface RunEntry {
  terminal: vscode.Terminal;
  command: string;
  cwd: string;
}

export interface SlnProject {
  name: string;
  relativePath: string;
  typeGuid: string;
  projectGuid: string;
  isSolutionFolder: boolean;
}

export interface SlnInfo {
  filePath: string;
  directory: string;
  projects: SlnProject[];
}

export interface PackageReferenceInfo {
  id: string;
  version?: string;
}

export interface CsprojInfo {
  sdk: string;
  sdkStyle: boolean;
  isWeb: boolean;
  targetFrameworks: string[];
  outputType: string;
  assemblyName?: string;
  rootNamespace?: string;
  isPackable: boolean;
  isTestProject: boolean;
  userSecretsId?: string;
  packageReferences: PackageReferenceInfo[];
  projectReferences: string[];
}

export interface ProjectEntry {
  name: string;
  csprojPath: string;
  csproj: CsprojInfo | null;
}

export interface LaunchProfile {
  name: string;
  commandName?: string;
  applicationUrl?: string;
  environmentVariables?: Record<string, string>;
}

export interface MsbuildIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  project?: string;
}

export interface DotnetTemplate {
  name: string;
  shortName: string;
  type: string;
  languages: string[];
  tags: string;
  category: string;
}

export interface SdkInfo {
  version: string;
  path: string;
}

export interface RuntimeInfo {
  name: string;
  version: string;
  path: string;
}

export interface NuGetSearchResult {
  id: string;
  latestVersion: string;
  source?: string;
}

export interface OutdatedPackage {
  project: string;
  projectPath: string;
  id: string;
  current: string;
  latest: string;
}

export interface ProjectOutdatedPackages {
  project: string;
  projectPath: string;
  packages: Array<{ id: string; current: string; latest: string }>;
}

export type BuildTarget =
  | { kind: 'solution'; path: string; name: string }
  | { kind: 'project'; entry: ProjectEntry };

// ── Testing (Test Explorer / TRX) ─────────────────────────────────────────────

export type TrxOutcome = 'passed' | 'failed' | 'skipped';

export interface TrxTestResult {
  /** Display name as reported in the TRX UnitTestResult element */
  testName: string;
  /** Class name from the TestDefinitions entry, when available */
  className?: string;
  /** Method name from the TestDefinitions entry, when available */
  methodName?: string;
  outcome: TrxOutcome;
  durationMs: number;
  message?: string;
  stackTrace?: string;
  stdOut?: string;
}

// ── Testing (code coverage / cobertura) ───────────────────────────────────────

export interface CoberturaLine {
  number: number;
  hits: number;
  branch: boolean;
  branchCovered?: number;
  branchTotal?: number;
}

export interface CoberturaClass {
  name: string;
  filename: string;
  lines: CoberturaLine[];
}

export interface CoberturaReport {
  sources: string[];
  classes: CoberturaClass[];
  linesCovered: number;
  linesValid: number;
  branchesCovered: number;
  branchesValid: number;
}
