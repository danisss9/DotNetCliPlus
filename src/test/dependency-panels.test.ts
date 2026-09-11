import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveEvidenceFile } from '../security-command';
import type { SecurityReviewReport } from '../security-types';

describe('NuGet analysis integration', () => {
  it('registers graph and security commands in the extension host', async () => {
    const extension = vscode.extensions.getExtension('danisss9.dotnet-cli-plus');
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('dotnet-cli-plus.showDependencyGraph'));
    assert.ok(commands.includes('dotnet-cli-plus.reviewPackageSecurity'));
  });

  it('opens only report-owned cache evidence, including cache files outside the workspace', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-evidence-'));
    try {
      const root = path.join(temporary, 'workspace'), cache = path.join(temporary, 'cache', 'pkg');
      await fs.mkdir(root); await fs.mkdir(cache, { recursive: true });
      const file = path.join(cache, 'pkg.targets'); await fs.writeFile(file, '<Project/>');
      const report = { findings: [{ id: 'host-finding', location: cache, evidence: [{ file, line: 2, column: 4 }] }] } as SecurityReviewReport;
      assert.deepStrictEqual(await resolveEvidenceFile(root, report, 'host-finding', 0), { file: await fs.realpath(file), line: 1, column: 3 });
      assert.strictEqual(await resolveEvidenceFile(root, report, 'forged-id', 0), undefined);
      assert.strictEqual(await resolveEvidenceFile(root, report, 'host-finding', -1), undefined);
      report.findings[0].evidence[0].file = path.join(temporary, 'outside.targets');
      assert.strictEqual(await resolveEvidenceFile(root, report, 'host-finding', 0), undefined);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});
