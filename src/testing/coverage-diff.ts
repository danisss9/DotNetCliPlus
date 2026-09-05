// Pure coverage diff helpers: compare the current coverage run against a
// stored previous-run snapshot. No vscode imports (unit-testable).

import type { MergedCoverageLine } from './cobertura';
import { computeCoverageTotals, type CoverageTotals } from './cobertura';

/** Serialized per-run snapshot persisted between sessions. */
export interface CoverageSnapshot {
  timestamp: number;
  totals: {
    linesCovered: number;
    linesValid: number;
    branchesCovered: number;
    branchesValid: number;
  };
  /** Normalized file path → line number → hit count. */
  files: Record<string, Record<string, number>>;
}

/** Builds a storable snapshot from merged per-file coverage lines. */
export function buildCoverageSnapshot(files: Map<string, MergedCoverageLine[]>): CoverageSnapshot {
  const totals = computeCoverageTotals([...files.values()]);
  const serialized: Record<string, Record<string, number>> = {};
  for (const [key, lines] of files) {
    const lineHits: Record<string, number> = {};
    for (const line of lines) {
      lineHits[String(line.number)] = line.hits;
    }
    serialized[key] = lineHits;
  }
  return {
    timestamp: Date.now(),
    totals: {
      linesCovered: totals.linesCovered,
      linesValid: totals.linesValid,
      branchesCovered: totals.branchesCovered,
      branchesValid: totals.branchesValid,
    },
    files: serialized,
  };
}

export function snapshotTotals(snapshot: CoverageSnapshot): CoverageTotals {
  const t = snapshot.totals;
  return {
    ...t,
    linePercent: t.linesValid > 0 ? (t.linesCovered / t.linesValid) * 100 : null,
    branchPercent: t.branchesValid > 0 ? (t.branchesCovered / t.branchesValid) * 100 : null,
  };
}

export interface FileCoverageDelta {
  file: string;
  /** Percentage-point change in line coverage for the file (negative = worse). */
  lineDelta: number;
  linesLost: number;
}

export interface CoverageDiff {
  current: CoverageTotals;
  previous: CoverageTotals;
  /** Percentage-point changes (null when a side has no instrumented data). */
  lineDelta: number | null;
  branchDelta: number | null;
  /** Files whose line coverage decreased, worst first. */
  regressions: FileCoverageDelta[];
  filesAdded: number;
  filesRemoved: number;
}

function filePercent(lineHits: Record<string, number>): number | null {
  const numbers = Object.values(lineHits);
  if (numbers.length === 0) {
    return null;
  }
  const covered = numbers.filter((hits) => hits > 0).length;
  return (covered / numbers.length) * 100;
}

/**
 * Diffs the current merged per-file coverage against a previous-run snapshot.
 */
export function computeCoverageDiff(
  current: Map<string, MergedCoverageLine[]>,
  previous: CoverageSnapshot | null,
): CoverageDiff {
  const currentTotals = computeCoverageTotals([...current.values()]);
  const previousTotals = previous ? snapshotTotals(previous) : currentTotals;

  const regressions: FileCoverageDelta[] = [];
  let filesAdded = 0;
  let filesRemoved = 0;

  if (previous) {
    const currentHits = new Map<string, Record<string, number>>();
    for (const [key, lines] of current) {
      const hits: Record<string, number> = {};
      for (const line of lines) {
        hits[String(line.number)] = line.hits;
      }
      currentHits.set(key, hits);
    }

    for (const [key, prevHits] of Object.entries(previous.files)) {
      const currHits = currentHits.get(key);
      if (!currHits) {
        filesRemoved++;
        continue;
      }
      const prevPct = filePercent(prevHits);
      const currPct = filePercent(currHits);
      if (prevPct === null || currPct === null) {
        continue;
      }
      const delta = currPct - prevPct;
      if (delta < -0.05) {
        const lost = Object.keys(prevHits).filter(
          (n) => prevHits[n] > 0 && (currHits[n] ?? 0) === 0,
        ).length;
        regressions.push({ file: key, lineDelta: delta, linesLost: lost });
      }
    }
    for (const key of currentHits.keys()) {
      if (!(key in previous.files)) {
        filesAdded++;
      }
    }
    regressions.sort((a, b) => a.lineDelta - b.lineDelta);
  }

  return {
    current: currentTotals,
    previous: previousTotals,
    lineDelta:
      currentTotals.linePercent !== null && previousTotals.linePercent !== null
        ? currentTotals.linePercent - previousTotals.linePercent
        : null,
    branchDelta:
      currentTotals.branchPercent !== null && previousTotals.branchPercent !== null
        ? currentTotals.branchPercent - previousTotals.branchPercent
        : null,
    regressions,
    filesAdded,
    filesRemoved,
  };
}

export function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

export function formatSigned(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} pts`;
}
