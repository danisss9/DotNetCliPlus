// Pure TRX (Visual Studio Test Results XML) parsing and matching helpers.
// No vscode imports (unit-testable).

import { XMLParser } from 'fast-xml-parser';
import type { TrxOutcome, TrxTestResult } from '../types';

interface TrxRaw {
  TestRun?: {
    Results?: {
      UnitTestResult?: RawUnitTestResult | RawUnitTestResult[];
    };
    TestDefinitions?: {
      UnitTest?: RawUnitTest | RawUnitTest[];
    };
  };
}

interface RawUnitTestResult {
  '@testName'?: string;
  '@outcome'?: string;
  '@duration'?: string;
  Output?: {
    ErrorInfo?: {
      Message?: unknown;
      StackTrace?: unknown;
    };
    StdOut?: unknown;
    DebugTrace?: unknown;
  };
  Messages?: {
    Message?: unknown;
  };
}

interface RawUnitTest {
  '@name'?: string;
  '@id'?: string;
  Execution?: {
    '@id'?: string;
  };
  TestMethod?: {
    '@className'?: string;
    '@name'?: string;
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    const text = (value as Record<string, unknown>)['#text'];
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

/** Parses a TimeSpan string like `dd:hh:mm:ss.fff` (days optional) into ms. */
export function parseTrxDuration(duration: string | undefined): number {
  if (!duration) {
    return 0;
  }
  const match =
    /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(duration.trim());
  if (!match) {
    return 0;
  }
  const days = match[1] ? parseInt(match[1], 10) : 0;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  const seconds = parseFloat(match[4]);
  return Math.round(
    (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000,
  );
}

export function mapTrxOutcome(outcome: string | undefined): TrxOutcome {
  switch ((outcome ?? '').toLowerCase()) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'notrunnable':
    case 'aborted':
    case 'error':
      return 'failed';
    default:
      // NotExecuted, Skipped, None, inconclusive
      return 'skipped';
  }
}

/**
 * Parses a TRX document into test results, joining UnitTestResult entries
 * with their TestDefinitions (className/methodName) via executionId.
 */
export function parseTrx(xml: string): TrxTestResult[] {
  let doc: TrxRaw;
  try {
    doc = parser.parse(xml) as TrxRaw;
  } catch {
    return [];
  }
  const testRun = doc?.TestRun;
  if (!testRun) {
    return [];
  }

  const definitionsByExecutionId = new Map<string, RawUnitTest>();
  for (const unitTest of asArray(testRun.TestDefinitions?.UnitTest)) {
    const executionId = unitTest.Execution?.['@id'];
    if (executionId) {
      definitionsByExecutionId.set(executionId, unitTest);
    }
  }

  const results: TrxTestResult[] = [];
  for (const raw of asArray(testRun.Results?.UnitTestResult)) {
    const testName = asText(raw['@testName']);
    if (!testName) {
      continue;
    }
    let className: string | undefined;
    let methodName: string | undefined;
    const executionId = (raw as RawUnitTestResult & { '@executionId'?: string })['@executionId'];
    const definition = executionId ? definitionsByExecutionId.get(executionId) : undefined;
    if (definition?.TestMethod) {
      className = asText(definition.TestMethod['@className']);
      methodName = asText(definition.TestMethod['@name']);
    }
    const message =
      asText(raw.Output?.ErrorInfo?.Message) ?? asText(raw.Messages?.Message);
    const stackTrace = asText(raw.Output?.ErrorInfo?.StackTrace);
    const stdOut =
      asText(raw.Output?.StdOut) ?? asText(raw.Output?.DebugTrace);
    results.push({
      testName,
      className,
      methodName,
      outcome: mapTrxOutcome(asText(raw['@outcome'])),
      durationMs: parseTrxDuration(asText(raw['@duration'])),
      ...(message !== undefined ? { message } : {}),
      ...(stackTrace !== undefined ? { stackTrace } : {}),
      ...(stdOut !== undefined ? { stdOut } : {}),
    });
  }
  return results;
}

/**
 * Merges TRX results across batch files. When the same display name appears
 * multiple times (e.g. a batched run reporting the same theory case), the
 * worst outcome wins so a single failing case fails the test item.
 */
export function mergeTrxResults(results: TrxTestResult[]): TrxTestResult[] {
  const byName = new Map<string, TrxTestResult>();
  for (const result of results) {
    const existing = byName.get(result.testName);
    if (!existing) {
      byName.set(result.testName, result);
      continue;
    }
    const rank = { failed: 0, skipped: 1, passed: 2 } as const;
    const winner = rank[result.outcome] <= rank[existing.outcome] ? result : existing;
    byName.set(result.testName, {
      ...winner,
      durationMs: existing.durationMs + result.durationMs,
      message: winner.message ?? existing.message,
      stackTrace: winner.stackTrace ?? existing.stackTrace,
      stdOut: existing.stdOut ?? result.stdOut,
    });
  }
  return [...byName.values()];
}

export interface TrxMatchTarget {
  /** Fully qualified name of the discovered test item */
  fqn: string;
}

export interface TrxMatch<T extends TrxMatchTarget> {
  result: TrxTestResult;
  target: T;
}

/**
 * Matches TRX results to discovered test items:
 *  1. exact FQN vs display name,
 *  2. exact `Class.Method` vs display name,
 *  3. theory/parameterized display names like `Method (args)` or
 *     `Method(args)` that start with the FQN.
 * Returns matched pairs plus results that could not be matched (these are
 * reported as ad-hoc test entries by the caller).
 */
export function matchTrxToTargets<T extends TrxMatchTarget>(
  results: TrxTestResult[],
  targets: T[],
): { matched: TrxMatch<T>[]; unmatched: TrxTestResult[] } {
  const byFqn = new Map<string, T>();
  for (const target of targets) {
    byFqn.set(target.fqn, target);
  }
  const byClassMethod = new Map<string, T>();
  for (const target of targets) {
    const dot = target.fqn.lastIndexOf('.');
    if (dot > 0) {
      byClassMethod.set(`${target.fqn.slice(0, dot)}.${target.fqn.slice(dot + 1)}`, target);
    }
  }

  const matched: TrxMatch<T>[] = [];
  const unmatched: TrxTestResult[] = [];

  for (const result of results) {
    const testName = result.testName.trim();
    let target = byFqn.get(testName);
    if (target) {
      matched.push({ result, target });
      continue;
    }
    const classMethod = result.className && result.methodName
      ? `${result.className}.${result.methodName}`
      : undefined;
    if (classMethod) {
      target = byFqn.get(classMethod) ?? byClassMethod.get(classMethod);
      if (target) {
        matched.push({ result, target });
        continue;
      }
    }
    // Theory display names: `Fqn(args)`, `Fqn (args)`, `Fqn [args]`, `Fqn: args`.
    // Several cases may legitimately map to the same target (aggregated later).
    let prefixMatch: T | undefined;
    for (const [fqn, candidate] of byFqn) {
      if (
        testName.startsWith(`${fqn}(`) ||
        testName.startsWith(`${fqn} (`) ||
        testName.startsWith(`${fqn}[`) ||
        testName.startsWith(`${fqn} [`) ||
        testName.startsWith(`${fqn}: `)
      ) {
        prefixMatch = candidate;
        break;
      }
    }
    if (prefixMatch) {
      matched.push({ result, target: prefixMatch });
      continue;
    }
    unmatched.push(result);
  }
  return { matched, unmatched };
}

/**
 * Aggregates multiple TRX results that map to the same target (theories with
 * several cases): any failure → failed; otherwise any pass → passed; else skipped.
 */
export function aggregateTrxForTarget(results: TrxTestResult[]): TrxTestResult | null {
  if (results.length === 0) {
    return null;
  }
  const failed = results.find((r) => r.outcome === 'failed');
  if (failed) {
    return failed;
  }
  const passed = results.find((r) => r.outcome === 'passed');
  if (passed) {
    return passed;
  }
  return results[0];
}
