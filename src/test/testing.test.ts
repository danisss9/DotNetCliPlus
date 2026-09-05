import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
  baseTestFqn,
  buildFilterBatches,
  buildTestHierarchy,
  escapeFilterValue,
  parseListTestsOutput,
  splitTestFqn,
} from '../testing/list-tests';
import {
  aggregateTrxForTarget,
  mapTrxOutcome,
  matchTrxToTargets,
  mergeTrxResults,
  parseTrx,
  parseTrxDuration,
} from '../testing/trx';
import {
  coberturaFileCandidates,
  mergeCoverageLines,
  parseCobertura,
  parseConditionCoverage,
} from '../testing/cobertura';
import { scanTestSource } from '../testing/source-map';

// ── list-tests ────────────────────────────────────────────────────────────────

describe('parseListTestsOutput', () => {
  const SAMPLE = [
    'Microsoft (R) Test Execution Command Line Tool Version 17.8.0',
    'Copyright (c) Microsoft Corporation. All rights reserved.',
    '',
    'The following Tests are available:',
    '    MyApp.Tests.MathTests.Adds',
    '    MyApp.Tests.MathTests.Subtracts',
    '    MyApp.Tests.MathTests.Adds',
    '',
    'VSTest Version: 17.8',
  ].join('\r\n');

  it('extracts tests after the marker', () => {
    assert.deepStrictEqual(parseListTestsOutput(SAMPLE), [
      'MyApp.Tests.MathTests.Adds',
      'MyApp.Tests.MathTests.Subtracts',
    ]);
  });

  it('returns empty when the marker is missing', () => {
    assert.deepStrictEqual(parseListTestsOutput('Build succeeded.\n0 test(s) found'), []);
  });

  it('ignores non-indented noise lines after the marker', () => {
    const out = 'The following Tests are available:\n    A.B.C.M\nSome summary line\n';
    assert.deepStrictEqual(parseListTestsOutput(out), ['A.B.C.M']);
  });
});

describe('splitTestFqn', () => {
  it('splits namespace/class from method', () => {
    assert.deepStrictEqual(splitTestFqn('MyApp.Tests.MathTests.Adds'), {
      containerSegments: ['MyApp', 'Tests', 'MathTests'],
      testName: 'Adds',
    });
  });

  it('handles a bare method name', () => {
    assert.deepStrictEqual(splitTestFqn('Adds'), { containerSegments: [], testName: 'Adds' });
  });

  it('keeps generic suffixes on the method', () => {
    const parts = splitTestFqn('Ns.Class.Method[System.Int32]');
    assert.strictEqual(parts.testName, 'Method[System.Int32]');
    assert.deepStrictEqual(parts.containerSegments, ['Ns', 'Class']);
  });
});

describe('buildTestHierarchy', () => {
  it('groups tests under namespace/class nodes', () => {
    const root = buildTestHierarchy([
      'MyApp.Tests.MathTests.Adds',
      'MyApp.Tests.MathTests.Subtracts',
      'MyApp.Tests.StrTests.Empty',
    ]);
    assert.strictEqual(root.children.size, 1);
    const myApp = root.children.get('MyApp')!;
    const tests = myApp.children.get('Tests')!;
    const math = tests.children.get('MathTests')!;
    assert.deepStrictEqual(math.tests, ['MyApp.Tests.MathTests.Adds', 'MyApp.Tests.MathTests.Subtracts']);
    assert.strictEqual(math.children.size, 0);
    const str = tests.children.get('StrTests')!;
    assert.strictEqual(str.tests.length, 1);
  });
});

describe('buildFilterBatches', () => {
  it('caps batches by test count', () => {
    const fqns = Array.from({ length: 250 }, (_, i) => `Ns.C.M${i}`);
    const batches = buildFilterBatches(fqns);
    assert.strictEqual(batches.length, 3);
    assert.ok(batches[0].startsWith('FullyQualifiedName=Ns.C.M0|'));
    assert.ok(batches.every((b) => b.split('|').length <= 100));
  });

  it('caps batches by character length', () => {
    const longName = `Ns.C.${'M'.repeat(900)}`;
    const batches = buildFilterBatches([longName, longName + 'X'], { maxTestsPerBatch: 10, maxChars: 1000 });
    assert.strictEqual(batches.length, 2);
  });

  it('escapes filter special characters', () => {
    const batches = buildFilterBatches(['Ns.C.Method(x)']);
    assert.strictEqual(batches[0], 'FullyQualifiedName=Ns.C.Method');
  });

  it('reduces theory display names to the base fqn and dedupes', () => {
    const batches = buildFilterBatches([
      'Ns.C.Cases(value: 1)',
      'Ns.C.Cases(value: 2)',
      'Ns.C.Other',
    ]);
    assert.deepStrictEqual(batches, ['FullyQualifiedName=Ns.C.Cases|FullyQualifiedName=Ns.C.Other']);
  });

  it('returns empty for no tests', () => {
    assert.deepStrictEqual(buildFilterBatches([]), []);
  });
});

describe('baseTestFqn', () => {
  it('strips trailing theory arguments', () => {
    assert.strictEqual(baseTestFqn('Ns.C.Cases(value: 1)'), 'Ns.C.Cases');
    assert.strictEqual(baseTestFqn('Ns.C.Cases (1, "a")'), 'Ns.C.Cases');
  });

  it('keeps names without argument lists', () => {
    assert.strictEqual(baseTestFqn('Ns.C.Method'), 'Ns.C.Method');
    assert.strictEqual(baseTestFqn('Ns.C.Method[System.Int32]'), 'Ns.C.Method[System.Int32]');
  });
});

describe('escapeFilterValue', () => {
  it('escapes vstest filter metacharacters', () => {
    assert.strictEqual(escapeFilterValue('A|B&C=D'), 'A\\|B\\&C\\=D');
    assert.strictEqual(escapeFilterValue('plain.Name_1'), 'plain.Name_1');
  });
});

// ── TRX ───────────────────────────────────────────────────────────────────────

describe('parseTrxDuration', () => {
  it('parses plain timespans', () => {
    assert.strictEqual(parseTrxDuration('00:00:01.5000001'), 1500);
    assert.strictEqual(parseTrxDuration('00:01:30'), 90_000);
  });

  it('parses days and garbage input', () => {
    assert.strictEqual(parseTrxDuration('1.02:03:04'), 93_784_000);
    assert.strictEqual(parseTrxDuration(undefined), 0);
    assert.strictEqual(parseTrxDuration('not a duration'), 0);
  });
});

describe('mapTrxOutcome', () => {
  it('maps vstest outcomes', () => {
    assert.strictEqual(mapTrxOutcome('Passed'), 'passed');
    assert.strictEqual(mapTrxOutcome('Failed'), 'failed');
    assert.strictEqual(mapTrxOutcome('NotRunnable'), 'failed');
    assert.strictEqual(mapTrxOutcome('NotExecuted'), 'skipped');
    assert.strictEqual(mapTrxOutcome('Skipped'), 'skipped');
    assert.strictEqual(mapTrxOutcome(undefined), 'skipped');
  });
});

const TRX_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="11111111-1111-1111-1111-111111111111" testId="a1" testName="MyApp.Tests.MathTests.Adds" computer="PC" duration="00:00:00.1230001" outcome="Passed" />
    <UnitTestResult executionId="22222222-2222-2222-2222-222222222222" testId="a2" testName="MyApp.Tests.MathTests.Subtracts" duration="00:00:01.5000001" outcome="Failed">
      <Output>
        <ErrorInfo>
          <Message><![CDATA[Assert.Equal() Failure: sizes differ]]></Message>
          <StackTrace><![CDATA[   at MyApp.Tests.MathTests.Subtracts() in C:\\repo\\MathTests.cs:line 12]]></StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
    <UnitTestResult executionId="33333333-3333-3333-3333-333333333333" testId="a3" testName="MyApp.Tests.MathTests.SkipMe" duration="00:00:00" outcome="NotExecuted" />
    <UnitTestResult executionId="44444444-4444-4444-4444-444444444444" testId="a4" testName="MyApp.Tests.MathTests.Cases(1)" duration="00:00:00.0100001" outcome="Passed" />
  </Results>
  <TestDefinitions>
    <UnitTest name="Adds" id="a1">
      <Execution id="11111111-1111-1111-1111-111111111111" />
      <TestMethod className="MyApp.Tests.MathTests" name="Adds" />
    </UnitTest>
    <UnitTest name="Subtracts" id="a2">
      <Execution id="22222222-2222-2222-2222-222222222222" />
      <TestMethod className="MyApp.Tests.MathTests" name="Subtracts" />
    </UnitTest>
    <UnitTest name="SkipMe" id="a3">
      <Execution id="33333333-3333-3333-3333-333333333333" />
      <TestMethod className="MyApp.Tests.MathTests" name="SkipMe" />
    </UnitTest>
    <UnitTest name="Cases" id="a4">
      <Execution id="44444444-4444-4444-4444-444444444444" />
      <TestMethod className="MyApp.Tests.MathTests" name="Cases" />
    </UnitTest>
  </TestDefinitions>
</TestRun>`;

describe('parseTrx', () => {
  it('parses results and joins definitions via executionId', () => {
    const results = parseTrx(TRX_SAMPLE);
    assert.strictEqual(results.length, 4);

    const adds = results.find((r) => r.testName === 'MyApp.Tests.MathTests.Adds')!;
    assert.strictEqual(adds.outcome, 'passed');
    assert.strictEqual(adds.durationMs, 123);
    assert.strictEqual(adds.className, 'MyApp.Tests.MathTests');
    assert.strictEqual(adds.methodName, 'Adds');

    const subtracts = results.find((r) => r.testName === 'MyApp.Tests.MathTests.Subtracts')!;
    assert.strictEqual(subtracts.outcome, 'failed');
    assert.strictEqual(subtracts.durationMs, 1500);
    assert.ok(subtracts.message?.includes('Assert.Equal() Failure'));
    assert.ok(subtracts.stackTrace?.includes('line 12'));

    const skipped = results.find((r) => r.testName === 'MyApp.Tests.MathTests.SkipMe')!;
    assert.strictEqual(skipped.outcome, 'skipped');
  });

  it('returns empty for malformed xml', () => {
    assert.deepStrictEqual(parseTrx('<not-trx'), []);
    assert.deepStrictEqual(parseTrx('<foo></foo>'), []);
  });
});

describe('mergeTrxResults', () => {
  it('keeps the worst outcome and sums durations for duplicate names', () => {
    const merged = mergeTrxResults([
      { testName: 'A', outcome: 'passed', durationMs: 10 },
      { testName: 'A', outcome: 'failed', durationMs: 5, message: 'boom' },
    ]);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].outcome, 'failed');
    assert.strictEqual(merged[0].durationMs, 15);
    assert.strictEqual(merged[0].message, 'boom');
  });
});

describe('matchTrxToTargets', () => {
  const targets = [
    { fqn: 'MyApp.Tests.MathTests.Adds', item: 'item-adds' },
    { fqn: 'MyApp.Tests.MathTests.Cases', item: 'item-cases' },
    { fqn: 'MyApp.Tests.MathTests.Unused', item: 'item-unused' },
  ];

  it('matches by exact fqn', () => {
    const { matched, unmatched } = matchTrxToTargets(
      [{ testName: 'MyApp.Tests.MathTests.Adds', outcome: 'passed', durationMs: 0 }],
      targets,
    );
    assert.strictEqual(matched.length, 1);
    assert.strictEqual(matched[0].target.item, 'item-adds');
    assert.strictEqual(unmatched.length, 0);
  });

  it('matches theory display names by fqn prefix', () => {
    const { matched } = matchTrxToTargets(
      [
        { testName: 'MyApp.Tests.MathTests.Cases(1)', outcome: 'passed', durationMs: 0 },
        { testName: 'MyApp.Tests.MathTests.Cases (2, 3)', outcome: 'failed', durationMs: 0 },
      ],
      targets,
    );
    assert.strictEqual(matched.length, 2);
    assert.ok(matched.every((m) => m.target.item === 'item-cases'));
  });

  it('matches by className.methodName when testName differs', () => {
    const { matched } = matchTrxToTargets(
      [
        {
          testName: 'Adds (custom display)',
          className: 'MyApp.Tests.MathTests',
          methodName: 'Adds',
          outcome: 'passed',
          durationMs: 0,
        },
      ],
      targets,
    );
    assert.strictEqual(matched.length, 1);
    assert.strictEqual(matched[0].target.item, 'item-adds');
  });

  it('reports unmatched results', () => {
    const { matched, unmatched } = matchTrxToTargets(
      [{ testName: 'Other.Test.M', outcome: 'failed', durationMs: 0 }],
      targets,
    );
    assert.strictEqual(matched.length, 0);
    assert.strictEqual(unmatched.length, 1);
  });
});

describe('aggregateTrxForTarget', () => {
  const result = (outcome: 'passed' | 'failed' | 'skipped') => ({
    testName: 'T',
    outcome,
    durationMs: 1,
  });

  it('prefers failure over pass', () => {
    assert.strictEqual(aggregateTrxForTarget([result('passed'), result('failed')])!.outcome, 'failed');
    assert.strictEqual(aggregateTrxForTarget([result('skipped'), result('passed')])!.outcome, 'passed');
    assert.strictEqual(aggregateTrxForTarget([result('skipped')])!.outcome, 'skipped');
    assert.strictEqual(aggregateTrxForTarget([]), null);
  });
});

// ── cobertura ─────────────────────────────────────────────────────────────────

describe('parseConditionCoverage', () => {
  it('parses percentages and fractions', () => {
    assert.deepStrictEqual(parseConditionCoverage('75% (3/4)'), { covered: 3, total: 4 });
    assert.deepStrictEqual(parseConditionCoverage('100% (2/2)'), { covered: 2, total: 2 });
  });

  it('rejects garbage and zero totals', () => {
    assert.strictEqual(parseConditionCoverage('n/a'), undefined);
    assert.strictEqual(parseConditionCoverage('0% (0/0)'), undefined);
    assert.strictEqual(parseConditionCoverage(undefined), undefined);
  });
});

const COBERTURA_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="0.5" branch-rate="0.5" lines-covered="2" lines-valid="4" branches-covered="1" branches-valid="2" complexity="4" version="1.9" timestamp="0">
  <sources>
    <source>${path.join(os.tmpdir(), 'repo')}${path.sep}</source>
  </sources>
  <packages>
    <package name="MyApp" line-rate="0.5" branch-rate="0.5" complexity="4">
      <classes>
        <class name="MyApp.Math" filename="MyApp/Math.cs" line-rate="0.5" branch-rate="0.5" complexity="4">
          <methods />
          <lines>
            <line number="5" hits="2" branch="False" />
            <line number="7" hits="0" branch="True" condition-coverage="50% (1/2)" />
          </lines>
        </class>
        <class name="MyApp.Empty" filename="MyApp/Empty.cs" line-rate="0" branch-rate="0" complexity="0">
          <methods />
          <lines />
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

describe('parseCobertura', () => {
  it('parses totals, sources and per-line data', () => {
    const report = parseCobertura(COBERTURA_SAMPLE)!;
    assert.ok(report);
    assert.strictEqual(report.linesCovered, 2);
    assert.strictEqual(report.linesValid, 4);
    assert.strictEqual(report.branchesCovered, 1);
    assert.strictEqual(report.branchesValid, 2);
    assert.strictEqual(report.classes.length, 1, 'classes without lines are dropped');

    const math = report.classes[0];
    assert.strictEqual(math.filename, 'MyApp/Math.cs');
    assert.strictEqual(math.lines.length, 2);
    assert.strictEqual(math.lines[0].hits, 2);
    assert.strictEqual(math.lines[1].branch, true);
    assert.strictEqual(math.lines[1].branchCovered, 1);
    assert.strictEqual(math.lines[1].branchTotal, 2);
  });

  it('returns null for malformed xml', () => {
    assert.strictEqual(parseCobertura('<coverage'), null);
    assert.strictEqual(parseCobertura('<other></other>'), null);
  });
});

describe('coberturaFileCandidates', () => {
  it('resolves relative filenames against absolute sources and project dir', () => {
    const base = path.join(os.tmpdir(), 'repo');
    const projectDir = path.join(os.tmpdir(), 'work', 'MyApp');
    const candidates = coberturaFileCandidates('MyApp/Math.cs', [`${base}${path.sep}`], projectDir);
    assert.ok(candidates.includes(path.resolve(path.join(base, 'MyApp', 'Math.cs'))));
    assert.ok(candidates.includes(path.resolve(path.join(projectDir, 'MyApp', 'Math.cs'))));
  });

  it('keeps absolute filenames as-is', () => {
    const abs = path.join(os.tmpdir(), 'repo', 'Math.cs');
    const candidates = coberturaFileCandidates(abs, [], path.join(os.tmpdir(), 'work'));
    assert.deepStrictEqual(candidates, [abs]);
  });
});

describe('mergeCoverageLines', () => {
  it('merges by line number taking max hits', () => {
    const merged = mergeCoverageLines([
      {
        lines: [
          { number: 5, hits: 1, branch: false },
          { number: 7, hits: 0, branch: true, branchCovered: 0, branchTotal: 2 },
        ],
      },
      {
        lines: [
          { number: 7, hits: 3, branch: true, branchCovered: 2, branchTotal: 2 },
          { number: 9, hits: 1, branch: false },
        ],
      },
    ]);
    assert.deepStrictEqual(merged, [
      { number: 5, hits: 1, branch: false, branchCovered: 0, branchTotal: 0 },
      { number: 7, hits: 3, branch: true, branchCovered: 2, branchTotal: 2 },
      { number: 9, hits: 1, branch: false, branchCovered: 0, branchTotal: 0 },
    ]);
  });
});

// ── source-map ────────────────────────────────────────────────────────────────

function lineOf(content: string, needle: string): number {
  const index = content.split('\n').findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `needle not found: ${needle}`);
  return index;
}

describe('scanTestSource', () => {
  it('finds xunit facts and theories with data attributes', () => {
    const source = [
      'using Xunit;',
      '',
      'namespace MyApp.Tests',
      '{',
      '    public class MathTests',
      '    {',
      '        [Fact]',
      '        public void Adds()',
      '        {',
      '        }',
      '',
      '        [Theory]',
      '        [InlineData(1)]',
      '        [InlineData(2)]',
      '        public void Cases(int x)',
      '        {',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const map = scanTestSource(source, 'MathTests.cs');
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get('MyApp.Tests.MathTests.Adds')!.line, lineOf(source, 'public void Adds()'));
    assert.strictEqual(map.get('MyApp.Tests.MathTests.Cases')!.line, lineOf(source, 'public void Cases(int x)'));
  });

  it('finds nunit tests and test cases', () => {
    const source = [
      'namespace MyApp.NUnitTests',
      '{',
      '    [TestFixture]',
      '    public class FooTests',
      '    {',
      '        [Test]',
      '        public void Bar() { }',
      '',
      '        [TestCase(1)]',
      '        [TestCase(2)]',
      '        public void Baz(int x) { }',
      '    }',
      '}',
    ].join('\n');
    const map = scanTestSource(source, 'FooTests.cs');
    assert.strictEqual(map.size, 2);
    assert.ok(map.has('MyApp.NUnitTests.FooTests.Bar'));
    assert.ok(map.has('MyApp.NUnitTests.FooTests.Baz'));
  });

  it('finds mstest test methods', () => {
    const source = [
      'namespace MyApp.MsTests',
      '{',
      '    [TestClass]',
      '    public class UnitTests',
      '    {',
      '        [TestMethod]',
      '        public void Test1() { }',
      '',
      '        [DataTestMethod]',
      '        [DataRow(1)]',
      '        public void Test2(int x) { }',
      '    }',
      '}',
    ].join('\n');
    const map = scanTestSource(source, 'UnitTests.cs');
    assert.strictEqual(map.size, 2);
    assert.ok(map.has('MyApp.MsTests.UnitTests.Test1'));
    assert.ok(map.has('MyApp.MsTests.UnitTests.Test2'));
  });

  it('handles file-scoped namespaces and nested classes', () => {
    const source = [
      'namespace A',
      '{',
      '    public class Outer',
      '    {',
      '        public class Nested',
      '        {',
      '            [Fact]',
      '            public void Deep() { }',
      '        }',
      '    }',
      '}',
      '',
      'namespace B',
      '{',
      '    public class Other',
      '    {',
      '        [Fact]',
      '        public void Also() { }',
      '    }',
      '}',
    ].join('\n');
    const map = scanTestSource(source, 'Nested.cs');
    assert.ok(map.has('A.Outer.Nested.Deep'));
    assert.ok(map.has('B.Other.Also'));
  });

  it('handles nested block namespaces', () => {
    const source = [
      'namespace A',
      '{',
      '    namespace B',
      '    {',
      '        public class C',
      '        {',
      '            [Fact]',
      '            public void M() { }',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const map = scanTestSource(source, 'C.cs');
    assert.ok(map.has('A.B.C.M'));
  });

  it('supports single-line attribute and method declarations', () => {
    const source = [
      'namespace Single;',
      '',
      'public class Tests',
      '{',
      '    [Fact] public void OneLiner() { Assert.True(true); }',
      '}',
    ].join('\n');
    const map = scanTestSource(source, 'Single.cs');
    assert.ok(map.has('Single.Tests.OneLiner'));
  });

  it('ignores commented-out tests and non-test methods', () => {
    const source = [
      'namespace X;',
      '',
      'public class Tests',
      '{',
      '    // [Fact]',
      '    // public void CommentedOut()',
      '    public void Helper()',
      '    {',
      '    }',
      '',
      '    /* [Fact] public void BlockCommented() { } */',
      '',
      '    [Fact]',
      '    public void Real()',
      '    {',
      '    }',
      '}',
    ].join('\n');
    const map = scanTestSource(source, 'X.cs');
    assert.strictEqual(map.size, 1);
    assert.ok(map.has('X.Tests.Real'));
  });

  it('ignores async and task-returning test method names correctly', () => {
    const source = [
      'namespace Async;',
      '',
      'public class Tests',
      '{',
      '    [Fact]',
      '    public async Task DoesWorkAsync()',
      '    {',
      '        await Task.CompletedTask;',
      '    }',
      '}',
    ].join('\n');
    const map = scanTestSource(source, 'Async.cs');
    assert.ok(map.has('Async.Tests.DoesWorkAsync'));
  });
});

// ── mtp ───────────────────────────────────────────────────────────────────────

import {
  buildMtpAppArgs,
  buildMtpFilter,
  buildMtpRunArgs,
  parseMtpListTestsOutput,
} from '../testing/mtp';
import { computeCoverageTotals } from '../testing/cobertura';
import {
  buildCoverageSnapshot,
  computeCoverageDiff,
  formatPercent,
  formatSigned,
} from '../testing/coverage-diff';

describe('parseMtpListTestsOutput', () => {
  it('extracts test names while skipping banner noise', () => {
    const out = [
      'Test execution command line for the MTP V1',
      '',
      'MyApp.Tests.CalculatorTests.Adds',
      'MyApp.Tests.CalculatorTests.Subtracts',
      'MyApp.Tests.CalculatorTests.Adds',
      '',
      '0 failures reported',
    ].join('\n');
    assert.deepStrictEqual(parseMtpListTestsOutput(out), [
      'MyApp.Tests.CalculatorTests.Adds',
      'MyApp.Tests.CalculatorTests.Subtracts',
    ]);
  });

  it('keeps theory display names with arguments', () => {
    assert.deepStrictEqual(parseMtpListTestsOutput('Ns.C.M(value: 1)\n'), ['Ns.C.M(value: 1)']);
  });

  it('returns empty for empty output', () => {
    assert.deepStrictEqual(parseMtpListTestsOutput(''), []);
  });
});

describe('buildMtpFilter', () => {
  it('builds a single OR filter with deduplicated base FQNs', () => {
    assert.strictEqual(
      buildMtpFilter(['Ns.C.M(1)', 'Ns.C.M', 'Ns.C.Other']),
      'FullyQualifiedName=Ns.C.M|FullyQualifiedName=Ns.C.Other',
    );
  });

  it('returns null for no tests', () => {
    assert.strictEqual(buildMtpFilter([]), null);
  });
});

describe('buildMtpRunArgs', () => {
  it('produces dotnet run args with report-trx and coverage', () => {
    assert.deepStrictEqual(
      buildMtpRunArgs({
        csprojPath: 'C:\proj\Tests.csproj',
        configFlags: ['-c', 'Debug'],
        noBuild: true,
        filter: 'FullyQualifiedName=Ns.C.M',
        trxFileName: 'run-0.trx',
        resultsDirectory: 'C:\tmp\p0',
        coverage: true,
      }),
      [
        'run',
        '--project',
        'C:\proj\Tests.csproj',
        '-c',
        'Debug',
        '--no-build',
        '--',
        '--report-trx',
        '--report-trx-filename=run-0.trx',
        '--results-directory',
        'C:\tmp\p0',
        '--filter',
        'FullyQualifiedName=Ns.C.M',
        '--coverage',
      ],
    );
  });

  it('omits filter when null', () => {
    const args = buildMtpRunArgs({
      csprojPath: 'p.csproj',
      configFlags: [],
      noBuild: false,
      filter: null,
      trxFileName: 'run-0.trx',
      resultsDirectory: 'r',
      coverage: false,
    });
    assert.ok(!args.includes('--filter'));
    assert.ok(!args.includes('--coverage'));
  });

  it('app args target the test host directly', () => {
    assert.deepStrictEqual(
      buildMtpAppArgs({
        filter: null,
        trxFileName: 'run-0.trx',
        resultsDirectory: 'r',
        coverage: false,
      }),
      ['--report-trx', '--report-trx-filename=run-0.trx', '--results-directory', 'r'],
    );
  });
});

// ── coverage totals & diff ────────────────────────────────────────────────────

function lines(entries: Array<[number, number, boolean?, number?, number?]>) {
  return entries.map(([number, hits, branch, branchCovered, branchTotal]) => ({
    number,
    hits,
    branch: branch ?? false,
    branchCovered: branchCovered ?? 0,
    branchTotal: branchTotal ?? 0,
  }));
}

describe('computeCoverageTotals', () => {
  it('computes weighted line and branch percentages', () => {
    const totals = computeCoverageTotals([
      lines([
        [10, 1],
        [11, 0],
        [12, 1, true, 1, 2],
      ]),
      lines([[20, 0]]),
    ]);
    assert.strictEqual(totals.linesCovered, 2);
    assert.strictEqual(totals.linesValid, 4);
    assert.strictEqual(totals.branchesCovered, 1);
    assert.strictEqual(totals.branchesValid, 2);
    assert.strictEqual(totals.linePercent, 50);
    assert.strictEqual(totals.branchPercent, 50);
  });

  it('returns null percentages for empty data', () => {
    const totals = computeCoverageTotals([]);
    assert.strictEqual(totals.linePercent, null);
    assert.strictEqual(totals.branchPercent, null);
  });
});

describe('computeCoverageDiff', () => {
  const currentFile = lines([
    [10, 1],
    [11, 0],
  ]);
  const previousFile = lines([
    [10, 1],
    [11, 1],
  ]);

  it('reports regressions and deltas vs the previous snapshot', () => {
    const previous = buildCoverageSnapshot(new Map([['math.cs', previousFile]]));
    const diff = computeCoverageDiff(new Map([['math.cs', currentFile]]), previous);
    assert.strictEqual(diff.previous.linePercent, 100);
    assert.strictEqual(diff.current.linePercent, 50);
    assert.strictEqual(diff.lineDelta, -50);
    assert.strictEqual(diff.regressions.length, 1);
    assert.strictEqual(diff.regressions[0].file, 'math.cs');
    assert.strictEqual(diff.regressions[0].linesLost, 1);
  });

  it('counts added and removed files', () => {
    const previous = buildCoverageSnapshot(new Map([['old.cs', previousFile]]));
    const diff = computeCoverageDiff(new Map([['new.cs', currentFile]]), previous);
    assert.strictEqual(diff.filesAdded, 1);
    assert.strictEqual(diff.filesRemoved, 1);
    assert.deepStrictEqual(diff.regressions, []);
  });

  it('no baseline yields zero deltas and no regressions', () => {
    const diff = computeCoverageDiff(new Map([['math.cs', currentFile]]), null);
    assert.strictEqual(diff.lineDelta, 0);
    assert.deepStrictEqual(diff.regressions, []);
  });

  it('formats percentages and signed points', () => {
    assert.strictEqual(formatPercent(50), '50.0%');
    assert.strictEqual(formatPercent(null), 'n/a');
    assert.strictEqual(formatSigned(1.25), '+1.3 pts');
    assert.strictEqual(formatSigned(-2), '-2.0 pts');
    assert.strictEqual(formatSigned(null), 'n/a');
  });
});
