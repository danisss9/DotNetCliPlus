// Pure helpers for Microsoft.Testing.Platform (MTP) "native mode" projects
// (xUnit v3 without Microsoft.NET.Test.Sdk). MTP apps are plain executables
// driven with their own CLI flags after `dotnet run --project X --`.
// No vscode imports (unit-testable).

import { baseTestFqn, escapeFilterValue } from './list-tests';

/**
 * A test name listed by MTP: a dotted identifier path (`Ns.Class.Method`),
 * optionally with a theory display suffix (`Method(args...)`, `Method [x]`).
 */
const MTP_TEST_NAME = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+(?:[([].*)?[)\]]?$/;

/**
 * Extracts fully qualified test names from `--list-tests` output of an MTP
 * app. MTP prints one test name per line; banner, progress and summary lines
 * are skipped by only accepting FQN-shaped dotted names.
 */
export function parseMtpListTestsOutput(stdout: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || seen.has(line)) {
      continue;
    }
    // At least one dot is required: a bare method name without namespace is
    // indistinguishable from banner noise.
    if (!MTP_TEST_NAME.test(line)) {
      continue;
    }
    seen.add(line);
    names.push(line);
  }
  return names;
}

/**
 * Builds a single MTP `--filter` expression for the given test FQNs
 * (`FullyQualifiedName=A|FullyQualifiedName=B`). MTP accepts one filter value
 * with `|` as OR, so selection is always one combined expression.
 */
export function buildMtpFilter(fqns: string[]): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const fqn of fqns) {
    const part = `FullyQualifiedName=${escapeFilterValue(baseTestFqn(fqn))}`;
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('|') : null;
}

export interface MtpRunOptions {
  csprojPath: string;
  /** MTP app args (after `--`); `null` for the plain `dotnet run` part. */
  configFlags: string[];
  frameworkFlag?: string;
  noBuild: boolean;
  filter: string | null;
  trxFileName: string;
  resultsDirectory: string;
  coverage: boolean;
}

/**
 * Args for running an MTP project through `dotnet run`, producing a TRX in the
 * results directory (and cobertura when coverage is requested via `--coverage`,
 * which requires the Microsoft.Testing.Extensions.CodeCoverage package —
 * referenced by the xunit.v3 templates by default).
 */
export function buildMtpRunArgs(options: MtpRunOptions): string[] {
  return [
    'run',
    '--project',
    options.csprojPath,
    ...options.configFlags,
    ...(options.frameworkFlag ? ['-f', options.frameworkFlag] : []),
    ...(options.noBuild ? ['--no-build'] : []),
    '--',
    '--report-trx',
    `--report-trx-filename=${options.trxFileName}`,
    '--results-directory',
    options.resultsDirectory,
    ...(options.filter !== null ? ['--filter', options.filter] : []),
    ...(options.coverage ? ['--coverage'] : []),
  ];
}

/**
 * Args passed to the test host executable itself (used for debugging: the
 * debugger launches the built dll directly instead of `dotnet run`).
 */
export function buildMtpAppArgs(options: Omit<MtpRunOptions, 'csprojPath' | 'configFlags' | 'frameworkFlag' | 'noBuild'>): string[] {
  return [
    '--report-trx',
    `--report-trx-filename=${options.trxFileName}`,
    '--results-directory',
    options.resultsDirectory,
    ...(options.filter !== null ? ['--filter', options.filter] : []),
    ...(options.coverage ? ['--coverage'] : []),
  ];
}
