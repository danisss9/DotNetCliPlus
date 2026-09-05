// Pure helpers for `dotnet test --list-tests` output parsing, hierarchy
// building and vstest filter batching. No vscode imports (unit-testable).

export const LIST_TESTS_MARKER = 'The following Tests are available:';

/**
 * Extracts fully qualified test names from `dotnet test --list-tests` output.
 * Anything before the marker line (build output, banners, restore logs) is
 * ignored; indented lines after it are test names.
 */
export function parseListTestsOutput(stdout: string): string[] {
  const markerIndex = stdout.indexOf(LIST_TESTS_MARKER);
  if (markerIndex === -1) {
    return [];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.slice(markerIndex + LIST_TESTS_MARKER.length).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    // vstest may print trailing summary/blank lines; test lines are indented
    // in the canonical output. Accept any non-empty line defensively, but skip
    // obvious banner/noise lines.
    if (!rawLine.startsWith(' ') && !rawLine.startsWith('\t')) {
      continue;
    }
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    names.push(line);
  }
  return names;
}

export interface TestFqnParts {
  /** Namespace + nested class segments, e.g. ["MyApp", "Tests", "MathTests"] */
  containerSegments: string[];
  /** Method name, e.g. "AddsNumbers" */
  testName: string;
}

/**
 * Splits `A.B.C.Method` into container segments and the method name.
 * The last dot-separated segment is the method, everything before it forms
 * the namespace/class path. Generic suffixes like `Method[T]` stay attached
 * to the method name.
 */
export function splitTestFqn(fqn: string): TestFqnParts {
  const trimmed = fqn.trim();
  // Generic methods render as `Ns.Class.Method[System.Int32]`; the bracket
  // suffix belongs to the method, so only look for the split dot before it.
  const bracket = trimmed.indexOf('[');
  const base = bracket === -1 ? trimmed : trimmed.slice(0, bracket);
  const suffix = bracket === -1 ? '' : trimmed.slice(bracket);
  const lastDot = base.lastIndexOf('.');
  if (lastDot === -1) {
    return { containerSegments: [], testName: trimmed };
  }
  const container = base.slice(0, lastDot);
  if (container.length === 0) {
    return { containerSegments: [], testName: trimmed };
  }
  return {
    containerSegments: container.split('.').map((s) => s.trim()).filter((s) => s.length > 0),
    testName: base.slice(lastDot + 1) + suffix,
  };
}

export interface TestHierarchyNode {
  label: string;
  children: Map<string, TestHierarchyNode>;
  tests: string[];
}

/**
 * Groups FQNs into a namespace → class → test tree. Tests without a
 * container namespace land directly under the root.
 */
export function buildTestHierarchy(fqns: string[]): TestHierarchyNode {
  const root: TestHierarchyNode = { label: '', children: new Map(), tests: [] };
  for (const fqn of fqns) {
    const { containerSegments, testName } = splitTestFqn(fqn);
    let node = root;
    for (const segment of containerSegments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { label: segment, children: new Map(), tests: [] };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.tests.push(fqn);
  }
  return root;
}

/** Characters with special meaning in vstest filter expressions. */
const FILTER_SPECIAL_CHARS = new Set(['\\', '|', '&', '(', ')', '=', '!', '~', ',', "'", '"', '%', '$', '<', '>']);

export function escapeFilterValue(value: string): string {
  let out = '';
  for (const ch of value) {
    if (FILTER_SPECIAL_CHARS.has(ch)) {
      out += '\\';
    }
    out += ch;
  }
  return out;
}

/**
 * Strips trailing theory display arguments: `Ns.C.M(1, 2)` → `Ns.C.M`.
 * `dotnet test --list-tests` shows per-case display names for theories
 * (xUnit: `Method(value: 1)`), but the vstest `--filter` FQN property is the
 * base method name — verified against real xUnit output.
 */
export function baseTestFqn(fqn: string): string {
  const trimmed = fqn.trim();
  const open = trimmed.indexOf('(');
  if (open === -1 || !trimmed.endsWith(')')) {
    return trimmed;
  }
  return trimmed.slice(0, open).trim();
}

export interface FilterBatchOptions {
  maxTestsPerBatch?: number;
  maxChars?: number;
}

/**
 * Splits test FQNs into batches; each batch becomes one
 * `FullyQualifiedName=A|FullyQualifiedName=B` filter string (exact match —
 * contains would over-match, e.g. `Test1` inside `UnitTest1`). Theory display
 * names are reduced to their base method FQN and deduplicated. Batches are
 * capped so the spawned argv stays well below Windows length limits.
 */
export function buildFilterBatches(fqns: string[], options?: FilterBatchOptions): string[] {
  const maxTests = options?.maxTestsPerBatch ?? 100;
  const maxChars = options?.maxChars ?? 8000;
  const batches: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  const seen = new Set<string>();

  const flush = () => {
    if (current.length > 0) {
      batches.push(current.join('|'));
      current = [];
      currentLength = 0;
    }
  };

  for (const fqn of fqns) {
    const part = `FullyQualifiedName=${escapeFilterValue(baseTestFqn(fqn))}`;
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    const separatorLength = current.length > 0 ? 1 : 0;
    if (current.length >= maxTests || currentLength + separatorLength + part.length > maxChars) {
      flush();
    }
    current.push(part);
    currentLength += separatorLength + part.length;
  }
  flush();
  return batches;
}
