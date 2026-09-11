const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { loadNugetDependencyGraph } = require('../out/nuget-graph-loader');
const { collectPackages } = require('../out/security-inventory');
const { runNugetAudit } = require('../out/security-audit');
async function main() {
  const root = path.resolve('.dependency-test-results/real-dotnet');
  for (const dir of ['App', 'Library']) { await fs.mkdir(path.join(root, dir), { recursive: true }); }
  await fs.writeFile(path.join(root, 'Directory.Packages.props'), '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="Newtonsoft.Json" Version="12.0.1" /></ItemGroup></Project>');
  await fs.writeFile(path.join(root, 'Library/Library.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Newtonsoft.Json" /></ItemGroup></Project>');
  const project = path.join(root, 'App/App.csproj');
  await fs.writeFile(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../Library/Library.csproj" /></ItemGroup></Project>');
  await execFile('dotnet', ['restore', project, '--source', 'https://api.nuget.org/v3/index.json'], { cwd: root, windowsHide: true, timeout: 120000 });
  const graph = await loadNugetDependencyGraph(root);
  assert.ok(graph.nodes.some(n => n.name === 'Newtonsoft.Json' && n.version === '12.0.1'));
  assert.ok(graph.nodes.some(n => n.name === 'Library' && n.status.includes('Project reference')));
  const inventory = await collectPackages(root);
  assert.equal(inventory.coverage.state, 'complete', JSON.stringify(inventory.coverage));
  const audit = await runNugetAudit(root, inventory.packages, true);
  await fs.writeFile(path.join(root, 'audit-result.json'), JSON.stringify(audit, null, 2));
  assert.equal(audit.coverage.state, 'complete', JSON.stringify(audit.coverage));
  assert.ok(audit.findings.some(f => f.packageName === 'Newtonsoft.Json'), JSON.stringify(audit));
  console.log('Real .NET restore: central package versions, project reference, transitive graph and live vulnerability audit passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
