import * as fs from 'fs/promises';
import * as path from 'path';
import type { PackageInventory } from './security-inventory';
import { checkCancelled, errorMessage, readBounded, safeRealpath } from './security-files';
import { SECURITY_LIMITS, type ScanCoverage, type ScanInput } from './security-types';

/** Scan package-owned build scripts as data; never execute MSBuild or package hooks. */
export async function discoverInstallInputs(inventory: PackageInventory, signal?: AbortSignal): Promise<{ inputs: ScanInput[]; coverage: ScanCoverage; bytes: number }> {
  const inputs: ScanInput[] = [], coverage: ScanCoverage = { component: 'scripts', state: 'complete', checked: 0, messages: [] };
  let bytes = 0, visited = 0;
  for (const pkg of inventory.packages) {
    checkCancelled(signal);
    if (!pkg.directory) { coverage.state = 'partial'; coverage.messages.push(`${pkg.name}: package files unavailable.`); continue; }
    async function walk(folder: string, depth: number): Promise<void> {
      checkCancelled(signal);
      if (depth > SECURITY_LIMITS.depth) { throw new Error('Package directory depth limit exceeded.'); }
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        checkCancelled(signal);
        if (++visited > 100000) { throw new Error('Package discovery entry limit exceeded.'); }
        const file = path.join(folder, item.name);
        if (item.isSymbolicLink()) { coverage.state = 'partial'; coverage.messages.push(`${file}: symbolic link excluded.`); continue; }
        if (item.isDirectory()) { await walk(file, depth + 1); continue; }
        if (!item.isFile() || !/\.(targets|props|ps1|psm1|cmd|bat|sh|js|csx)$/i.test(item.name)) { continue; }
        if (inputs.length >= SECURITY_LIMITS.files) { throw new Error('Script input count limit exceeded.'); }
        const real = await safeRealpath(pkg.directory, file);
        const raw = await readBounded(real, SECURITY_LIMITS.fileBytes);
        // PowerShell and MSBuild files commonly use UTF-16 with a BOM.
        const data = raw[0] === 0xff && raw[1] === 0xfe ? Buffer.from(raw.subarray(2).toString('utf16le'))
          : raw[0] === 0xfe && raw[1] === 0xff ? Buffer.from(Buffer.from(raw.subarray(2)).swap16().toString('utf16le')) : raw;
        if (bytes + data.length > SECURITY_LIMITS.totalBytes) { throw new Error('Script byte limit exceeded.'); }
        bytes += data.length;
        inputs.push({ key: real, bytes: data, packageId: pkg.id, kind: 'source', evidence: [{ file: real, line: 1, column: 1,
          snippet: data.toString().slice(0, 500), chain: [pkg.name, path.relative(pkg.directory, real)] }] });
      }
    }
    try { await walk(pkg.directory, 0); }
    catch (error) { checkCancelled(signal); coverage.state = 'partial'; coverage.messages.push(`${pkg.name}: ${errorMessage(error)}`); }
    if (visited > 100000 || inputs.length >= SECURITY_LIMITS.files || bytes >= SECURITY_LIMITS.totalBytes) { break; }
  }
  coverage.checked = inputs.length;
  coverage.messages.push('Scans package .targets, .props and script files, including tools scripts. Compiled tasks, assemblies, external imports and runtime downloads are outside scope.');
  return { inputs, coverage, bytes };
}
