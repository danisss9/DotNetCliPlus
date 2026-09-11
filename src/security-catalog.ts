import { createHash } from 'crypto';
import type { InstalledPackage, SecurityFinding } from './security-types';
export const CATALOG_VERSION = 'not bundled for NuGet';
export function findingId(...parts: string[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24); }
export function packageFinding(pkg: InstalledPackage, category: SecurityFinding['category'], ruleId: string): SecurityFinding {
  return { id: findingId(pkg.id, category, ruleId), category, severity: 'low', confidence: 'low', packageId: pkg.id,
    packageName: pkg.name, version: pkg.version, location: pkg.directory, dependencyPath: pkg.dependencyPath,
    ruleId, title: '', description: '', recommendation: '', references: [], evidence: [] };
}
