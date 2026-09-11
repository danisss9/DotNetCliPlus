export type DependencyKind = 'package' | 'project' | 'framework';
export type GraphSource = 'Restored' | 'Declared only';
export interface DependencyNode {
  id: string;
  name: string;
  version?: string;
  path?: string;
  kinds: DependencyKind[];
  status: string[];
}
export interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  name: string;
  requested?: string;
  kinds: DependencyKind[];
}
export interface DependencyGraph {
  source: GraphSource;
  root: string;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  diagnostics: string[];
}

type JsonObject = Record<string, unknown>;
export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : {};
}

