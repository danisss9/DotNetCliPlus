// Pure cobertura XML (coverage.cobertura.xml) parsing helpers.
// No vscode imports (unit-testable).

import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import type { CoberturaClass, CoberturaLine, CoberturaReport } from '../types';

interface RawCoverage {
  coverage?: {
    '@lines-covered'?: string;
    '@lines-valid'?: string;
    '@branches-covered'?: string;
    '@branches-valid'?: string;
    sources?: { source?: string | string[] };
    packages?: {
      package?: unknown;
    };
  };
}

interface RawClass {
  '@name'?: string;
  '@filename'?: string;
  lines?: {
    line?: RawLine | RawLine[];
  };
}

interface RawLine {
  '@number'?: string;
  '@hits'?: string;
  '@branch'?: string;
  '@condition-coverage'?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function toInt(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Parses a condition-coverage attribute like `75% (3/4)` into
 * covered/total branch counts.
 */
export function parseConditionCoverage(value: string | undefined): { covered: number; total: number } | undefined {
  if (!value) {
    return undefined;
  }
  const match = /(\d+)\s*%\s*\((\d+)\s*\/\s*(\d+)\)/.exec(value);
  if (!match) {
    return undefined;
  }
  const covered = parseInt(match[2], 10);
  const total = parseInt(match[3], 10);
  if (total <= 0) {
    return undefined;
  }
  return { covered, total };
}

/** Parses a cobertura document into classes with per-line hit data. */
export function parseCobertura(xml: string): CoberturaReport | null {
  let doc: RawCoverage;
  try {
    doc = parser.parse(xml) as RawCoverage;
  } catch {
    return null;
  }
  const coverage = doc?.coverage;
  if (!coverage) {
    return null;
  }

  const sources = asArray(coverage.sources?.source).filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );

  const classes: CoberturaClass[] = [];
  const packages = asArray(coverage.packages?.package as Record<string, unknown> | Record<string, unknown>[] | undefined);
  for (const pkg of packages) {
    const rawClasses = asArray((pkg.classes as { class?: RawClass | RawClass[] } | undefined)?.class);
    for (const raw of rawClasses) {
      const name = raw['@name'];
      const filename = raw['@filename'];
      if (!filename || !name) {
        continue;
      }
      const lines: CoberturaLine[] = [];
      const seen = new Set<number>();
      for (const rawLine of asArray(raw.lines?.line)) {
        const number = toInt(rawLine['@number']);
        if (number <= 0 || seen.has(number)) {
          continue;
        }
        seen.add(number);
        const branch = rawLine['@branch']?.toLowerCase() === 'true';
        const condition = parseConditionCoverage(rawLine['@condition-coverage']);
        lines.push({
          number,
          hits: toInt(rawLine['@hits']),
          branch,
          ...(branch && condition ? { branchCovered: condition.covered, branchTotal: condition.total } : {}),
        });
      }
      if (lines.length > 0) {
        classes.push({ name, filename, lines });
      }
    }
  }

  return {
    sources,
    classes,
    linesCovered: toInt(coverage['@lines-covered']),
    linesValid: toInt(coverage['@lines-valid']),
    branchesCovered: toInt(coverage['@branches-covered']),
    branchesValid: toInt(coverage['@branches-valid']),
  };
}

/**
 * Produces candidate absolute paths for a cobertura class filename: the raw
 * filename when absolute, else resolved against each `<source>` entry and the
 * project directory. The caller checks existence (case-insensitively on
 * Windows).
 */
export function coberturaFileCandidates(
  filename: string,
  sources: string[],
  projectDir: string,
): string[] {
  const candidates: string[] = [];
  const normalized = filename.replace(/\//g, path.sep);
  if (path.isAbsolute(normalized)) {
    candidates.push(normalized);
  } else {
    for (const source of sources) {
      const base = source.replace(/[\\/]+$/, '');
      if (path.isAbsolute(base)) {
        candidates.push(path.resolve(path.join(base, normalized)));
      }
    }
    candidates.push(path.resolve(path.join(projectDir, normalized)));
    // Source paths may be nested below the project dir (e.g. repo root).
    candidates.push(path.resolve(path.join(projectDir, '..', normalized)));
  }
  const seen = new Set<string>(candidates.map((c) => c.toLowerCase()));
  return candidates.filter((c) => {
    const key = c.toLowerCase();
    if (seen.has(key)) {
      seen.delete(key);
      return true;
    }
    return false;
  });
}

export interface MergedCoverageLine {
  number: number;
  hits: number;
  branch: boolean;
  branchCovered: number;
  branchTotal: number;
}

/**
 * Merges line coverage for the same file across TFMs/assemblies, taking the
 * max hit count per line (parallel runs of the same source).
 */
export function mergeCoverageLines(
  lineSets: Array<{ lines: CoberturaLine[] }>,
): MergedCoverageLine[] {
  const byNumber = new Map<number, MergedCoverageLine>();
  for (const set of lineSets) {
    for (const line of set.lines) {
      const existing = byNumber.get(line.number);
      if (!existing) {
        byNumber.set(line.number, {
          number: line.number,
          hits: line.hits,
          branch: line.branch,
          branchCovered: line.branchCovered ?? 0,
          branchTotal: line.branchTotal ?? 0,
        });
        continue;
      }
      existing.hits = Math.max(existing.hits, line.hits);
      existing.branch = existing.branch || line.branch;
      existing.branchCovered = Math.max(existing.branchCovered, line.branchCovered ?? 0);
      existing.branchTotal = Math.max(existing.branchTotal, line.branchTotal ?? 0);
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}
