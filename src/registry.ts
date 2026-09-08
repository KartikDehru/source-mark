import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

/**
 * The conformance registry: schema family -> the set of pinned deployments that
 * claim to speak that schema. This is the reusable artefact. Adding a protocol
 * is an edit to registry/families.json; no code changes, no redeploy of logic.
 */

export type MetricSpec =
  | { unit: string; kind: 'rate'; side: string; type: string }
  | { unit: string; kind: 'field'; field: string };

export interface SourceSpec {
  protocol: string;
  chainId: number;
  idKind: 'deployment' | 'subgraph';
  id: string;
  payoutAddress: string;
  consent: string;
}

export interface FreshnessPolicy {
  maxBlockLag: number;
  maxAgeSeconds: number;
  minSources: number;
}

/**
 * Whether the sources in a family are supposed to return the same answer.
 *
 * `identical` — same protocol, same chain, same schema. They index the same
 *   underlying facts, so they should agree. Disagreement is a fault, not
 *   variance, and the read is refused.
 *
 * `peer` — different protocols that happen to share a schema. A USDC supply
 *   rate genuinely differs between Aave and Spark, so spread is information
 *   about the market rather than evidence of a bug. No agreement check.
 *
 * Conflating these two would be the easy mistake: a median across unrelated
 * protocols is not a measurement of anything.
 */
export type Comparability = 'identical' | 'peer';

export interface FamilySpec {
  label: string;
  schema: string;
  /** Schema IPFS hash from The Graph's network subgraph. Conformance is byte-identity, not a label. */
  schemaIpfsHash?: string;
  schemaUrl?: string;
  comparability: Comparability;
  comparabilityNote?: string;
  /** Max tolerated spread as a fraction of the median, in bps. Only for `identical` families. */
  agreementToleranceBps?: number;
  /** Markets below this TVL are dropped for rate metrics. A rate on an empty market is not quotable. */
  minMarketTvlUSD?: number;
  policy: FreshnessPolicy;
  rowsPath: string;
  metrics: Record<string, MetricSpec>;
  query: string;
  sources: SourceSpec[];
}

export interface Registry {
  version: number;
  note?: string;
  families: Record<string, FamilySpec>;
}

const PLACEHOLDER = /^<FILL:/;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

let cached: Registry | null = null;

export function loadRegistry(force = false): Registry {
  if (cached && !force) return cached;
  const path = resolve(process.cwd(), 'registry', 'families.json');
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Registry;
  if (!parsed.families || typeof parsed.families !== 'object') {
    throw new Error('registry/families.json: missing "families" object');
  }
  cached = parsed;
  return parsed;
}

export function getFamily(name: string): FamilySpec | undefined {
  return loadRegistry().families[name];
}

/**
 * A family's effective policy is the strictest of the global default and the
 * family's own setting. A family may tighten a bound; it may never loosen one.
 */
export function effectivePolicy(family: FamilySpec, overrideMinSources?: number): FreshnessPolicy {
  const base: FreshnessPolicy = {
    maxBlockLag: Math.min(config.policy.maxBlockLag, family.policy.maxBlockLag),
    maxAgeSeconds: Math.min(config.policy.maxAgeSeconds, family.policy.maxAgeSeconds),
    minSources: Math.max(config.policy.minSources, family.policy.minSources),
  };
  if (overrideMinSources !== undefined && overrideMinSources > base.minSources) {
    return { ...base, minSources: overrideMinSources };
  }
  return base;
}

/** Sources that are actually usable: pinned to a real id, not a placeholder. */
export function usableSources(family: FamilySpec): SourceSpec[] {
  return family.sources.filter((s) => !isPlaceholder(s.id));
}

export function registrySummary(): Array<{
  family: string;
  label: string;
  schema: string;
  policy: FreshnessPolicy;
  metrics: string[];
  sources: Array<{ protocol: string; chainId: number; id: string; pinned: boolean }>;
  ready: boolean;
  schemaIpfsHash?: string;
  comparability: Comparability;
  comparabilityNote?: string;
  agreementToleranceBps?: number;
}> {
  const reg = loadRegistry();
  return Object.entries(reg.families).map(([name, f]) => {
    const sources = f.sources.map((s) => ({
      protocol: s.protocol,
      chainId: s.chainId,
      id: isPlaceholder(s.id) ? 'UNPINNED' : s.id,
      pinned: !isPlaceholder(s.id),
    }));
    return {
      family: name,
      label: f.label,
      schema: f.schema,
      schemaIpfsHash: f.schemaIpfsHash,
      comparability: f.comparability,
      comparabilityNote: f.comparabilityNote,
      agreementToleranceBps: f.agreementToleranceBps,
      policy: effectivePolicy(f),
      metrics: Object.keys(f.metrics),
      sources,
      ready: sources.filter((s) => s.pinned).length >= effectivePolicy(f).minSources,
    };
  });
}
