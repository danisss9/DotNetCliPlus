// Heuristic source scan that maps discovered test FQNs to file/line by
// finding [Fact]/[Theory]/[Test]-style attributes and the method that
// follows them. Pure string processing (unit-testable).

const TEST_ATTRIBUTE_RE =
  /^\[\s*(Fact|Theory|Test|TestMethod|DataTestMethod|TestCase)\b/;

const METHOD_NAME_RE = /([A-Za-z_]\w*)\s*\(/;

const KEYWORD_IDENTIFIERS = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'using',
  'return',
  'throw',
  'typeof',
  'nameof',
  'base',
  'this',
  'new',
  'lock',
  'await',
  'yield',
  'get',
  'set',
]);

const NAMESPACE_RE = /^namespace\s+([A-Za-z_][\w.]*)\s*(;|\{)?/;
const CLASS_RE = /\b(?:partial\s+)?class\s+([A-Za-z_]\w*)/;

export interface SourceTestLocation {
  filePath: string;
  /** 0-based line of the test method declaration */
  line: number;
}

function stripBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function findMethodName(line: string): string | null {
  const match = METHOD_NAME_RE.exec(line);
  if (!match || KEYWORD_IDENTIFIERS.has(match[1])) {
    return null;
  }
  return match[1];
}

/**
 * Scans C# source and returns a map of
 * `Namespace.Class[.NestedClass].Method` → location for each method marked
 * with a test attribute. Handles file-scoped and block namespaces (incl.
 * nested) and nested classes.
 */
export function scanTestSource(content: string, filePath: string): Map<string, SourceTestLocation> {
  const results = new Map<string, SourceTestLocation>();
  const lines = stripBlockComments(content).split(/\r?\n/);

  let namespaceSegments: string[] = [];
  let fileScopedNamespace = false;
  const namespaceDecls: Array<{ segments: number; closeDepth: number }> = [];
  let pendingNamespaceDecl: { segments: number } | null = null;
  const classStack: string[] = [];
  const classCloseDepths: number[] = [];
  let pendingClass: string | null = null;
  let pendingTestAttributeLine: number | null = null;
  let braceDepth = 0;

  const pushFqn = (methodName: string, methodLine: number) => {
    const fqn = [...namespaceSegments, ...classStack, methodName].join('.');
    if (!results.has(fqn)) {
      results.set(fqn, { filePath, line: methodLine });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) {
      continue;
    }

    // Namespace declarations (top-level or nested blocks, or file-scoped).
    // No `continue` here: the opening brace of `namespace X {` still needs to
    // be counted by the walk below.
    if (!fileScopedNamespace && classStack.length === 0 && pendingClass === null) {
      const nsMatch = NAMESPACE_RE.exec(trimmed);
      if (nsMatch) {
        const segments = nsMatch[1].split('.');
        namespaceSegments.push(...segments);
        if (nsMatch[2] === ';') {
          fileScopedNamespace = true;
        } else {
          pendingNamespaceDecl = { segments: segments.length };
        }
      }
    }

    // Test attribute found — remember it and try the same-line case
    // (`[Fact] public void Test1()`).
    if (pendingTestAttributeLine === null && TEST_ATTRIBUTE_RE.test(trimmed)) {
      const closeBracket = trimmed.indexOf(']');
      const afterAttribute = closeBracket >= 0 ? trimmed.slice(closeBracket + 1) : '';
      const sameLineMethod = afterAttribute.length > 0 ? findMethodName(afterAttribute) : null;
      if (sameLineMethod) {
        pushFqn(sameLineMethod, i);
      } else {
        pendingTestAttributeLine = i;
      }
      continue;
    }

    // Method declaration on a line after the attribute (skipping further
    // attribute lines such as [InlineData(...)]).
    if (
      pendingTestAttributeLine !== null &&
      pendingTestAttributeLine < i &&
      !trimmed.startsWith('[')
    ) {
      const methodName = findMethodName(trimmed);
      if (methodName) {
        pushFqn(methodName, i);
        pendingTestAttributeLine = null;
      }
    }

    if (pendingClass === null && pendingTestAttributeLine === null) {
      const classMatch = CLASS_RE.exec(trimmed);
      if (classMatch) {
        pendingClass = classMatch[1];
      }
    }

    for (const ch of rawLine) {
      if (ch === '{') {
        braceDepth++;
        if (pendingNamespaceDecl !== null) {
          namespaceDecls.push({ ...pendingNamespaceDecl, closeDepth: braceDepth });
          pendingNamespaceDecl = null;
        } else if (pendingClass !== null) {
          classStack.push(pendingClass);
          classCloseDepths.push(braceDepth);
          pendingClass = null;
        }
      } else if (ch === '}') {
        while (classCloseDepths.length > 0 && classCloseDepths[classCloseDepths.length - 1] === braceDepth) {
          classCloseDepths.pop();
          classStack.pop();
        }
        while (
          namespaceDecls.length > 0 &&
          namespaceDecls[namespaceDecls.length - 1].closeDepth === braceDepth
        ) {
          const decl = namespaceDecls.pop()!;
          namespaceSegments.splice(decl.segments * -1, decl.segments);
        }
        braceDepth--;
      }
    }
  }

  return results;
}
