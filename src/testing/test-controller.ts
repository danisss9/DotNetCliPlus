import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CoberturaLine, ProjectEntry, TrxTestResult } from '../types';
import { discoverProjects, EXCLUDE_GLOB } from '../utils';
import { spawnManaged } from '../spawn';
import { configFlag, normalizePathKey } from '../pure-utils';
import { logDiagnostic } from '../state';
import {
  buildFilterBatches,
  parseListTestsOutput,
  splitTestFqn,
} from './list-tests';
import {
  aggregateTrxForTarget,
  matchTrxToTargets,
  mergeTrxResults,
  parseTrx,
} from './trx';
import {
  coberturaFileCandidates,
  mergeCoverageLines,
  parseCobertura,
} from './cobertura';
import { scanTestSource, type SourceTestLocation } from './source-map';

const REFRESH_DEBOUNCE_MS = 2000;
const LIST_TESTS_TIMEOUT_MS = 300_000;
const MAX_SOURCE_FILES_PER_PROJECT = 500;
const TRX_FLUSH_RETRIES = 8;
const TRX_FLUSH_DELAY_MS = 500;

interface ProjectNode {
  entry: ProjectEntry;
  item: vscode.TestItem;
  hasTestSdk: boolean;
  leafFqns: Set<string>;
  sourceLocations: Map<string, SourceTestLocation>;
  discoveryInFlight: Promise<void> | null;
}

interface RunGroup {
  node: ProjectNode;
  leaves: vscode.TestItem[];
  fullSet: boolean;
}

const PROJECT_ID_PREFIX = 'project:';
const TEST_ID_PREFIX = 'test:';

function projectNodeId(csprojPath: string): string {
  return `${PROJECT_ID_PREFIX}${csprojPath}`;
}

function testNodeId(csprojPath: string, fqn: string): string {
  return `${TEST_ID_PREFIX}${csprojPath}::${fqn}`;
}

function fqnFromTestItemId(id: string): string | null {
  if (!id.startsWith(TEST_ID_PREFIX)) {
    return null;
  }
  const fqn = id.slice(id.indexOf('::') + 2);
  return fqn.length > 0 ? fqn : null;
}

function looksGenerated(fsPath: string): boolean {
  return /[\\/](bin|obj|node_modules|\.git|\.vs|artifacts)[\\/]/.test(fsPath);
}

async function collectFilesRecursive(
  dir: string,
  filter: (name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (filter(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function cancellationFor(token: vscode.CancellationToken) {
  const subscriptions = new Map<() => void, vscode.Disposable>();
  return {
    onCancellationRequested: (callback: () => void): void => {
      subscriptions.set(callback, token.onCancellationRequested(callback));
    },
    offCancellationRequested: (callback: () => void): void => {
      subscriptions.get(callback)?.dispose();
      subscriptions.delete(callback);
    },
    isCancellationRequested: (): boolean => token.isCancellationRequested,
  };
}

/** Extracts a file/line location from a .NET stack trace, if possible. */
function locationFromStackTrace(stackTrace: string): vscode.Location | undefined {
  const match = /in\s+([^\s+]+?\.(?:cs|vb|fs)):(\d+)/.exec(stackTrace);
  if (!match) {
    return undefined;
  }
  return new vscode.Location(
    vscode.Uri.file(match[1]),
    new vscode.Position(Math.max(0, parseInt(match[2], 10) - 1), 0),
  );
}

class TestExplorer implements vscode.Disposable {
  readonly controller: vscode.TestController;
  private readonly output = vscode.window.createOutputChannel('DotNet CLI Plus: test');
  private readonly projectNodes = new Map<string, ProjectNode>();
  private readonly disposables: vscode.Disposable[] = [this.output];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshQueued: Promise<void> | null = null;
  private readonly nodeRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.controller = vscode.tests.createTestController('dotnet-cli-plus', '.NET Tests');
    this.disposables.push(this.controller);

    this.controller.resolveHandler = async (item?: vscode.TestItem) => {
      if (!item) {
        await this.refreshProjects();
        return;
      }
      if (item.id.startsWith(PROJECT_ID_PREFIX)) {
        const node = this.projectNodes.get(normalizePathKey(item.id.slice(PROJECT_ID_PREFIX.length)));
        if (node) {
          await this.discoverTestsForProject(node);
        }
      }
    };
    this.controller.refreshHandler = () => this.refreshProjects();

    const runProfile = this.controller.createRunProfile(
      'DotNet CLI Plus: Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.executeRun(request, token, 'run'),
    );
    const debugProfile = this.controller.createRunProfile(
      'DotNet CLI Plus: Debug',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.executeRun(request, token, 'debug'),
    );
    const coverageProfile = this.controller.createRunProfile(
      'DotNet CLI Plus: Coverage',
      vscode.TestRunProfileKind.Coverage,
      (request, token) => this.executeRun(request, token, 'coverage'),
    );
    this.disposables.push(runProfile, debugProfile, coverageProfile);

    this.setupWatchers();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    for (const timer of this.nodeRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.nodeRefreshTimers.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  // ── Project & test discovery ────────────────────────────────────────────────

  private setupWatchers(): void {
    const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.{csproj,fsproj,vbproj,sln,slnx}');
    const onProjectChange = () => {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        void this.refreshProjects();
      }, REFRESH_DEBOUNCE_MS);
    };
    this.disposables.push(
      projectWatcher,
      projectWatcher.onDidChange(onProjectChange),
      projectWatcher.onDidCreate(onProjectChange),
      projectWatcher.onDidDelete(onProjectChange),
    );

    const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
    const onSourceChange = (uri: vscode.Uri) => {
      if (looksGenerated(uri.fsPath)) {
        return;
      }
      for (const node of this.projectNodes.values()) {
        const projectDir = path.dirname(node.entry.csprojPath);
        if (normalizePathKey(uri.fsPath).startsWith(normalizePathKey(projectDir + path.sep))) {
          this.scheduleNodeRefresh(node);
        }
      }
    };
    this.disposables.push(
      sourceWatcher,
      sourceWatcher.onDidChange(onSourceChange),
      sourceWatcher.onDidCreate(onSourceChange),
      sourceWatcher.onDidDelete(onSourceChange),
    );
  }

  private scheduleNodeRefresh(node: ProjectNode): void {
    const key = normalizePathKey(node.entry.csprojPath);
    const existing = this.nodeRefreshTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.nodeRefreshTimers.set(
      key,
      setTimeout(() => {
        this.nodeRefreshTimers.delete(key);
        void this.discoverTestsForProject(node);
      }, REFRESH_DEBOUNCE_MS),
    );
  }

  async refreshProjects(): Promise<void> {
    if (!this.refreshQueued) {
      this.refreshQueued = this.doRefreshProjects().finally(() => {
        this.refreshQueued = null;
      });
    }
    return this.refreshQueued;
  }

  private async doRefreshProjects(): Promise<void> {
    const entries = new Map<string, ProjectEntry>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        for (const entry of await discoverProjects(folder.uri.fsPath, null)) {
          if (entry.csproj?.isTestProject) {
            entries.set(normalizePathKey(entry.csprojPath), entry);
          }
        }
      } catch (err) {
        logDiagnostic(`Test discovery failed for ${folder.uri.fsPath}: ${err}`);
      }
    }

    for (const key of [...this.projectNodes.keys()]) {
      if (!entries.has(key)) {
        this.projectNodes.delete(key);
      }
    }

    const items: vscode.TestItem[] = [];
    for (const [key, entry] of entries) {
      let node = this.projectNodes.get(key);
      if (!node) {
        const item = this.controller.createTestItem(
          projectNodeId(entry.csprojPath),
          entry.name,
          vscode.Uri.file(entry.csprojPath),
        );
        item.canResolveChildren = true;
        node = {
          entry,
          item,
          hasTestSdk: entry.csproj?.packageReferences.some((p) => p.id === 'Microsoft.NET.Test.Sdk') ?? false,
          leafFqns: new Set(),
          sourceLocations: new Map(),
          discoveryInFlight: null,
        };
        this.projectNodes.set(key, node);
      } else {
        node.entry = entry;
        node.hasTestSdk = entry.csproj?.packageReferences.some((p) => p.id === 'Microsoft.NET.Test.Sdk') ?? false;
      }
      items.push(node.item);
    }
    this.controller.items.replace(items);

    // Sequential: dotnet builds contend for the same obj/ directories.
    for (const node of this.projectNodes.values()) {
      await this.discoverTestsForProject(node);
    }
  }

  private async discoverTestsForProject(node: ProjectNode): Promise<void> {
    if (node.discoveryInFlight) {
      return node.discoveryInFlight;
    }
    node.discoveryInFlight = this.doDiscoverTestsForProject(node).finally(() => {
      node.discoveryInFlight = null;
    });
    return node.discoveryInFlight;
  }

  private async doDiscoverTestsForProject(node: ProjectNode): Promise<void> {
    const csprojPath = node.entry.csprojPath;
    const projectItem = node.item;
    const csproj = node.entry.csproj;
    if (!csproj) {
      projectItem.error = 'Could not parse the project file.';
      return;
    }

    if (!node.hasTestSdk) {
      projectItem.error = undefined;
      node.leafFqns = new Set();
      const warning = this.controller.createTestItem(
        `${projectNodeId(csprojPath)}:mtp`,
        'Microsoft.Testing.Platform projects are not supported — add the Microsoft.NET.Test.Sdk package or use dotnet test in a terminal.',
      );
      warning.canResolveChildren = false;
      projectItem.children.replace([warning]);
      return;
    }

    const projectDir = path.dirname(csprojPath);
    const tfmList =
      csproj.targetFrameworks.length > 1 ? csproj.targetFrameworks : [undefined];
    const fqns = new Set<string>();
    let firstError: string | null = null;

    for (const tfm of tfmList) {
      const args = [
        'test',
        csprojPath,
        ...(tfm ? ['-f', tfm] : []),
        '--list-tests',
        '--nologo',
      ];
      const result = await this.spawn(args, projectDir, LIST_TESTS_TIMEOUT_MS);
      if (result.exitCode !== 0) {
        firstError ??= `dotnet test --list-tests failed (exit code ${result.exitCode}). Check the "DotNet CLI Plus: test" output.`;
        continue;
      }
      for (const fqn of parseListTestsOutput(result.stdout)) {
        fqns.add(fqn);
      }
    }

    node.leafFqns = fqns;
    if (fqns.size === 0) {
      projectItem.error = firstError ?? undefined;
      if (!firstError) {
        const empty = this.controller.createTestItem(
          `${projectNodeId(csprojPath)}:empty`,
          'No tests found',
        );
        empty.canResolveChildren = false;
        projectItem.children.replace([empty]);
      } else {
        projectItem.children.replace([]);
      }
      return;
    }
    projectItem.error = undefined;

    const locate = vscode.workspace
      .getConfiguration('dotnetCliPlus')
      .get<boolean>('testExplorer.locateInSource', true);
    node.sourceLocations = locate ? await this.scanProjectSources(csprojPath) : new Map();

    this.rebuildProjectItems(node, [...fqns].sort());
  }

  private rebuildProjectItems(node: ProjectNode, fqns: string[]): void {
    const csprojPath = node.entry.csprojPath;
    const projectItem = node.item;
    projectItem.children.replace([]);

    const containers = new Map<string, vscode.TestItem>();
    const ensureContainer = (containerFqn: string): vscode.TestItem => {
      const existing = containers.get(containerFqn);
      if (existing) {
        return existing;
      }
      const lastDot = containerFqn.lastIndexOf('.');
      const parentItem =
        lastDot === -1 ? projectItem : ensureContainer(containerFqn.slice(0, lastDot));
      const item = this.controller.createTestItem(
        `${projectNodeId(csprojPath)}:group:${containerFqn}`,
        lastDot === -1 ? containerFqn : containerFqn.slice(lastDot + 1),
      );
      item.canResolveChildren = false;
      parentItem.children.add(item);
      containers.set(containerFqn, item);
      return item;
    };

    for (const fqn of fqns) {
      const { containerSegments, testName } = splitTestFqn(fqn);
      const parentItem =
        containerSegments.length > 0
          ? ensureContainer(containerSegments.join('.'))
          : projectItem;
      const location = node.sourceLocations.get(fqn);
      const item = this.controller.createTestItem(
        testNodeId(csprojPath, fqn),
        testName,
        location ? vscode.Uri.file(location.filePath) : undefined,
      );
      if (location) {
        item.range = new vscode.Range(location.line, 0, location.line, 0);
      }
      parentItem.children.add(item);
    }
  }

  private async scanProjectSources(csprojPath: string): Promise<Map<string, SourceTestLocation>> {
    const projectDir = path.dirname(csprojPath);
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectDir, '**/*.cs'),
        EXCLUDE_GLOB,
        MAX_SOURCE_FILES_PER_PROJECT,
      );
    } catch {
      return new Map();
    }
    const merged = new Map<string, SourceTestLocation>();
    for (const uri of uris) {
      if (looksGenerated(uri.fsPath)) {
        continue;
      }
      try {
        const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
        for (const [fqn, location] of scanTestSource(content, uri.fsPath)) {
          if (!merged.has(fqn)) {
            merged.set(fqn, location);
          }
        }
      } catch {
        // unreadable file — skip
      }
    }
    return merged;
  }

  private async spawn(
    args: string[],
    cwd: string,
    timeoutMs?: number,
    token?: vscode.CancellationToken,
  ): Promise<{ stdout: string; exitCode: number }> {
    this.output.appendLine(`> dotnet ${args.join(' ')}`);
    return spawnManaged('dotnet', args, {
      cwd,
      shell: false,
      timeoutMs,
      ...(token ? { cancellation: cancellationFor(token) } : {}),
      onStdout: (chunk) => this.output.append(chunk),
      onStderr: (chunk) => this.output.append(chunk),
    });
  }

  // ── Run / debug / coverage execution ────────────────────────────────────────

  private async executeRun(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    kind: 'run' | 'debug' | 'coverage',
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const resultsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dnclp-test-'));
    try {
      // Self-heal if a run is requested before anything resolved the tree.
      if (this.projectNodes.size === 0) {
        await this.refreshProjects();
      }
      const groups = this.groupRequestedTests(request.include);
      if (groups.length === 0) {
        return;
      }
      for (const group of groups) {
        for (const leaf of group.leaves) {
          run.enqueued(leaf);
        }
      }

      const projectDirs: string[] = [];
      let projectIndex = 0;
      for (const group of groups) {
        if (token.isCancellationRequested) {
          return;
        }
        projectDirs.push(path.dirname(group.node.entry.csprojPath));
        await this.runProject(group, run, token, kind, resultsDir, projectIndex++);
      }

      if (kind === 'coverage' && !token.isCancellationRequested) {
        await this.applyCoverage(run, resultsDir, projectDirs);
      }
    } finally {
      run.end();
      void fs.promises.rm(resultsDir, { recursive: true, force: true });
    }
  }

  private groupRequestedTests(include: readonly vscode.TestItem[] | undefined): RunGroup[] {
    const leavesByProject = new Map<ProjectNode, Set<vscode.TestItem>>();
    const addLeaf = (leaf: vscode.TestItem) => {
      let root = leaf;
      while (root.parent) {
        root = root.parent;
      }
      let node: ProjectNode | undefined;
      for (const candidate of this.projectNodes.values()) {
        if (candidate.item === root) {
          node = candidate;
          break;
        }
      }
      if (!node) {
        return;
      }
      const set = leavesByProject.get(node) ?? new Set<vscode.TestItem>();
      set.add(leaf);
      leavesByProject.set(node, set);
    };

    if (include && include.length > 0) {
      for (const item of include) {
        this.collectLeaves(item, addLeaf);
      }
    } else {
      for (const node of this.projectNodes.values()) {
        this.collectLeaves(node.item, addLeaf);
      }
    }

    const groups: RunGroup[] = [];
    for (const [node, leafSet] of leavesByProject) {
      const leaves = [...leafSet];
      const fqns = new Set(
        leaves
          .map((leaf) => fqnFromTestItemId(leaf.id))
          .filter((fqn): fqn is string => fqn !== null),
      );
      groups.push({
        node,
        leaves,
        fullSet: node.leafFqns.size > 0 && fqns.size === node.leafFqns.size,
      });
    }
    return groups;
  }

  private collectLeaves(item: vscode.TestItem, out: (leaf: vscode.TestItem) => void): void {
    if (item.children.size === 0) {
      if (item.id.startsWith(TEST_ID_PREFIX)) {
        out(item);
      }
      return;
    }
    item.children.forEach((child) => this.collectLeaves(child, out));
  }

  private async runProject(
    group: RunGroup,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
    kind: 'run' | 'debug' | 'coverage',
    rootResultsDir: string,
    projectIndex: number,
  ): Promise<void> {
    const { node, leaves } = group;
    const csprojPath = node.entry.csprojPath;
    const projectDir = path.dirname(csprojPath);
    const projectResultsDir = path.join(rootResultsDir, `p${projectIndex}`);
    await fs.promises.mkdir(projectResultsDir, { recursive: true });

    const fqns = leaves
      .map((leaf) => fqnFromTestItemId(leaf.id))
      .filter((fqn): fqn is string => fqn !== null);

    let batches: Array<string | null>;
    if (kind === 'debug') {
      // Debug prefers a single combined invocation but falls back to
      // multiple sequential sessions for very large selections.
      batches = group.fullSet
        ? [null]
        : buildFilterBatches(fqns, { maxTestsPerBatch: 10_000, maxChars: 30_000 });
    } else {
      batches = group.fullSet ? [null] : buildFilterBatches(fqns);
    }

    const configuration = vscode.workspace
      .getConfiguration('dotnetCliPlus')
      .get<string>('build.configuration', 'default');
    const noBuild = vscode.workspace
      .getConfiguration('dotnetCliPlus')
      .get<boolean>('test.noBuild', false);

    for (const leaf of leaves) {
      run.started(leaf);
    }

    let invocationFailed = false;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      if (token.isCancellationRequested) {
        return;
      }
      const filter = batches[batchIndex];
      const args = [
        'test',
        csprojPath,
        ...configFlag(configuration),
        ...(noBuild ? ['--no-build'] : []),
        ...(filter !== null ? ['--filter', filter] : []),
        '--logger',
        `trx;LogFileName=run-${batchIndex}.trx`,
        '--results-directory',
        projectResultsDir,
        ...(kind === 'coverage' ? ['--collect', 'XPlat Code Coverage'] : []),
        '-v',
        'quiet',
      ];

      run.appendOutput(`> dotnet ${args.join(' ')}\n`);
      if (kind === 'debug') {
        const launched = await this.launchDebugRun(node, args, run, token);
        if (!launched) {
          invocationFailed = true;
        }
      } else {
        const result = await this.spawn(args, projectDir, undefined, token);
        if (token.isCancellationRequested) {
          return;
        }
        run.appendOutput(result.stdout);
        // Exit code 1 = failing tests (expected); anything else is infra.
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          invocationFailed = true;
        }
      }
    }

    if (token.isCancellationRequested) {
      return;
    }

    const results = await this.readTrxResults(projectResultsDir, kind === 'debug');
    this.applyTrxResults(run, leaves, results, invocationFailed);
  }

  private async launchDebugRun(
    node: ProjectNode,
    args: string[],
    run: vscode.TestRun,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const csprojPath = node.entry.csprojPath;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(csprojPath));
    const sessionName = `.NET Test Debug (${node.entry.name})`;
    const config: vscode.DebugConfiguration = {
      type: 'coreclr',
      request: 'launch',
      name: sessionName,
      program: 'dotnet',
      args,
      cwd: path.dirname(csprojPath),
      justMyCode: true,
      requireExactSource: false,
      logging: { moduleLoad: false },
    };

    let resolveEnded: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const sessionWatcher = vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.name === sessionName) {
        resolveEnded();
      }
    });
    const cancelSub = token.onCancellationRequested(() => void vscode.debug.stopDebugging());

    try {
      const started = await vscode.debug.startDebugging(folder, config, { testRun: run });
      if (!started) {
        run.appendOutput('Failed to start the debug session. Is the C# extension (ms-dotnettools.csharp) installed?\n');
        return false;
      }
      await ended;
      return true;
    } finally {
      sessionWatcher.dispose();
      cancelSub.dispose();
    }
  }

  private async readTrxResults(dir: string, waitForFlush: boolean): Promise<TrxTestResult[]> {
    let files: string[] = [];
    for (let attempt = 0; attempt < TRX_FLUSH_RETRIES; attempt++) {
      try {
        files = (await fs.promises.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.trx'));
      } catch {
        return [];
      }
      if (files.length > 0 || !waitForFlush || attempt === TRX_FLUSH_RETRIES - 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, TRX_FLUSH_DELAY_MS));
    }
    const results: TrxTestResult[] = [];
    for (const file of files) {
      try {
        const xml = await fs.promises.readFile(path.join(dir, file), 'utf-8');
        results.push(...parseTrx(xml));
      } catch (err) {
        logDiagnostic(`Failed to read TRX ${file}: ${err}`);
      }
    }
    return results;
  }

  private applyTrxResults(
    run: vscode.TestRun,
    leaves: vscode.TestItem[],
    results: TrxTestResult[],
    invocationFailed: boolean,
  ): void {
    if (results.length === 0) {
      const message = invocationFailed
        ? 'dotnet test failed to run (build error or crash). See the "DotNet CLI Plus: test" output for details.'
        : 'No test results were produced for the selected tests.';
      for (const leaf of leaves) {
        run.errored(leaf, new vscode.TestMessage(message));
      }
      return;
    }

    const targets = leaves
      .map((leaf) => {
        const fqn = fqnFromTestItemId(leaf.id);
        return fqn !== null ? { fqn, item: leaf } : null;
      })
      .filter((t): t is { fqn: string; item: vscode.TestItem } => t !== null);

    const { matched, unmatched } = matchTrxToTargets(mergeTrxResults(results), targets);

    const byTarget = new Map<vscode.TestItem, TrxTestResult[]>();
    for (const { result, target } of matched) {
      const list = byTarget.get(target.item) ?? [];
      list.push(result);
      byTarget.set(target.item, list);
    }
    for (const [item, list] of byTarget) {
      const aggregated = aggregateTrxForTarget(list);
      if (!aggregated) {
        continue;
      }
      this.reportResult(run, item, aggregated);
    }

    // Theory cases and other results that did not map to a discovered item
    // are reported as ad-hoc entries so they are not silently lost.
    for (const result of unmatched) {
      const item = this.controller.createTestItem(
        `adhoc:${result.testName}`,
        result.testName,
      );
      item.canResolveChildren = false;
      run.started(item);
      this.reportResult(run, item, result);
    }
  }

  private reportResult(run: vscode.TestRun, item: vscode.TestItem, result: TrxTestResult): void {
    switch (result.outcome) {
      case 'passed':
        run.passed(item, result.durationMs);
        break;
      case 'skipped':
        run.skipped(item);
        break;
      case 'failed': {
        const message = new vscode.TestMessage(result.message ?? 'Test failed');
        const messages: vscode.TestMessage[] = [message];
        if (result.stackTrace) {
          const stack = new vscode.TestMessage(result.stackTrace);
          const location = locationFromStackTrace(result.stackTrace);
          if (location) {
            message.location = location;
            stack.location = location;
          }
          messages.push(stack);
        }
        run.failed(item, messages, result.durationMs);
        break;
      }
    }
  }

  // ── Coverage ────────────────────────────────────────────────────────────────

  private async applyCoverage(
    run: vscode.TestRun,
    resultsDir: string,
    projectDirs: string[],
  ): Promise<void> {
    const coberturaFiles = await collectFilesRecursive(
      resultsDir,
      (name) => name === 'coverage.cobertura.xml',
    );
    if (coberturaFiles.length === 0) {
      run.appendOutput('No coverage.cobertura.xml was produced by --collect "XPlat Code Coverage".\n');
      return;
    }

    const candidateDirs = [
      ...projectDirs,
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    ];

    const byFile = new Map<string, { uri: vscode.Uri; lineSets: Array<{ lines: CoberturaLine[] }> }>();
    let totalClasses = 0;
    for (const file of coberturaFiles) {
      let report;
      try {
        report = parseCobertura(await fs.promises.readFile(file, 'utf-8'));
      } catch (err) {
        logDiagnostic(`Failed to read cobertura file ${file}: ${err}`);
        continue;
      }
      if (!report) {
        continue;
      }
      for (const cls of report.classes) {
        totalClasses++;
        const resolved = this.resolveCoveragePath(cls.filename, report.sources, candidateDirs);
        if (!resolved) {
          continue;
        }
        const key = normalizePathKey(resolved);
        const entry = byFile.get(key) ?? { uri: vscode.Uri.file(resolved), lineSets: [] };
        entry.lineSets.push({ lines: cls.lines });
        byFile.set(key, entry);
      }
    }

    for (const { uri, lineSets } of byFile.values()) {
      const merged = mergeCoverageLines(lineSets);
      const details = merged.map((line) => {
        const range = new vscode.Range(line.number - 1, 0, line.number - 1, 1);
        const branches =
          line.branch && line.branchTotal > 0
            ? Array.from(
                { length: line.branchTotal },
                (_, i) =>
                  new vscode.BranchCoverage(i < line.branchCovered ? 1 : 0, range),
              )
            : undefined;
        return new vscode.StatementCoverage(line.hits, range, branches);
      });
      run.addCoverage(vscode.FileCoverage.fromDetails(uri, details));
    }

    if (byFile.size === 0) {
      if (totalClasses === 0) {
        run.appendOutput(
          'Coverage reports were produced but contained no instrumented source files (empty cobertura). ' +
            'Verify the coverlet.collector / Microsoft.NET.Test.Sdk versions are compatible with your SDK and runtime.\n',
        );
      } else {
        run.appendOutput(
          `Coverage contained ${totalClasses} classes but their source files could not be resolved inside the workspace.\n`,
        );
      }
    }
  }

  private resolveCoveragePath(
    filename: string,
    sources: string[],
    candidateDirs: string[],
  ): string | null {
    for (const dir of candidateDirs) {
      for (const candidate of coberturaFileCandidates(filename, sources, dir)) {
        try {
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        } catch {
          // ignore and try the next candidate
        }
      }
    }
    return null;
  }
}

// ── Module lifecycle ──────────────────────────────────────────────────────────

let activeExplorer: TestExplorer | null = null;

function isTestExplorerEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('dotnetCliPlus')
    .get<boolean>('testExplorer.enabled', true);
}

export function activateTestExplorer(context: vscode.ExtensionContext): void {
  const sync = () => {
    if (isTestExplorerEnabled()) {
      if (!activeExplorer) {
        activeExplorer = new TestExplorer();
        context.subscriptions.push(activeExplorer);
        // No eager refresh here: discovery triggers a dotnet build, so it is
        // driven lazily by the resolveHandler when the Testing view opens.
      }
    } else if (activeExplorer) {
      activeExplorer.dispose();
      activeExplorer = null;
    }
  };
  sync();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dotnetCliPlus.testExplorer')) {
        sync();
      }
    }),
  );
}

export async function refreshAllTests(): Promise<void> {
  if (activeExplorer) {
    await activeExplorer.refreshProjects();
  } else {
    vscode.window.showInformationMessage(
      'The DotNet CLI Plus test explorer is disabled (dotnetCliPlus.testExplorer.enabled).',
    );
  }
}
