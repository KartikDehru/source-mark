import { chainHeads, measureFreshness, type Freshness } from './anchor.js';
import { queryGraph, type GraphResult } from './graph.js';
import {
  effectivePolicy,
  getFamily,
  usableSources,
  type FamilySpec,
  type FreshnessPolicy,
  type MetricSpec,
  type SourceSpec,
} from './registry.js';

/**
 * Fan out one query template across every deployment that claims to speak a
 * schema family, then decide whether the results are good enough to sell.
 *
 * The important behaviour in this file is the refusal path. When provenance
 * cannot be established the resolver returns REFUSED and the caller never
 * settles the payment, so a read the service cannot stand behind is free.
 */

export type RejectReason =
  | 'QUERY_FAILED'
  | 'PINNED_ID_MISMATCH'
  | 'INDEXING_ERRORS'
  | 'BLOCK_LAG_EXCEEDED'
  | 'STALE_TIMESTAMP'
  | 'NO_FRESHNESS_REFERENCE'
  | 'METRIC_UNAVAILABLE'
  | 'MARKET_NOT_LIQUID';

export interface SourceReport {
  protocol: string;
  chainId: number;
  deploymentId: string;
  status: 'OK' | 'REJECTED';
  why?: RejectReason;
  detail?: string;
  value?: number;
  /** Market TVL in USD backing this value. Used to weight peer-family answers. */
  weightUSD?: number;
  block?: number;
  blockHash?: string | null;
  timestamp?: number | null;
  blockLag?: number | null;
  ageSeconds?: number | null;
  reference?: Freshness['reference'];
  latencyMs: number;
}

export interface Answer {
  value: number;
  unit: string;
  /**
   * `median` for `identical` families, where every source indexes the same
   * facts and TVL is therefore the same number on both sides.
   *
   * `tvl-weighted` for `peer` families. A plain median across protocols treats
   * a rate on a $57k wound-down pool as equal to one on a $2.3B pool, which
   * lets a dead market move the headline number by more than a percentage
   * point. Weighting by the liquidity actually behind each rate fixes that
   * without an arbitrary cutoff — the alternative was tuning a TVL floor until
   * the output looked reasonable, which is not a defensible way to pick a
   * threshold.
   */
  method: 'median' | 'tvl-weighted';
  spread: number;
  /** Spread as a fraction of the headline value, in basis points. */
  spreadBps: number | null;
  contributors: number;
  comparability: FamilySpec['comparability'];
  /** Attribution of the extremes. Present on `peer` families, where the range is the useful part. */
  range?: { min: number; minProtocol: string; max: number; maxProtocol: string };
  /** Present on `peer` families, where spread is expected and no single number is "the" answer. */
  caveat?: string;
}

export type ResolveOutcome =
  | { resolved: true; answer: Answer; sources: SourceReport[]; policy: FreshnessPolicy; family: FamilySpec; chainHead: { chainId: number; block: number | null } }
  | {
      resolved: false;
      reason: 'UNKNOWN_FAMILY' | 'UNKNOWN_METRIC' | 'SOURCES_UNPINNED' | 'QUORUM_NOT_MET' | 'SOURCE_DISAGREEMENT';
      detail: string;
      sources: SourceReport[];
      policy: FreshnessPolicy | null;
      survived: number;
      required: number;
    };

export interface ResolveRequest {
  family: string;
  metric: string;
  asset?: string;
  minSources?: number;
  /** Caller-tightened block-lag bound. Can only ever be stricter than the policy. */
  forceMaxBlockLag?: number;
  /**
   * Caller-tightened age bound, in seconds. This is the reliable lever for
   * demonstrating refusal: healthy sources routinely sit at lag 0, so a lag
   * bound cannot be made to fail on demand, but a source is always at least a
   * few seconds old.
   */
  forceMaxAgeSeconds?: number;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function symbolOf(row: Record<string, unknown>): string | null {
  const token = row['inputToken'] as { symbol?: unknown } | undefined;
  return typeof token?.symbol === 'string' ? token.symbol : null;
}

/** Pick the deepest-liquidity row matching the asset filter, then read the metric off it. */
function extractMetric(
  rows: Array<Record<string, unknown>>,
  spec: MetricSpec,
  minMarketTvlUSD: number,
  asset?: string,
): { value: number; weightUSD: number } | { error: string; reason?: RejectReason } {
  const candidates = asset
    ? rows.filter((r) => symbolOf(r)?.toUpperCase() === asset.toUpperCase())
    : rows;

  if (candidates.length === 0) {
    return { error: asset ? `no market for asset ${asset}` : 'no rows returned' };
  }

  const ranked = [...candidates].sort(
    (a, b) => (num(b['totalValueLockedUSD']) ?? 0) - (num(a['totalValueLockedUSD']) ?? 0),
  );
  const row = ranked[0];
  if (!row) return { error: 'no rows returned' };

  const tvl = num(row['totalValueLockedUSD']) ?? 0;

  if (spec.kind === 'field') {
    const value = num(row[spec.field]);
    return value === null ? { error: `field ${spec.field} missing` } : { value, weightUSD: tvl };
  }

  // A rate on a market with literally nothing in it is not a rate at all —
  // deprecated deployments keep serving markets at 0% forever. The floor is
  // set low on purpose: it exists to drop empty markets, not to filter out
  // small ones. Small-but-real markets are handled by TVL weighting instead,
  // so this threshold never has to be tuned to make an answer look right.
  if (tvl < minMarketTvlUSD) {
    return {
      error: `market TVL $${tvl.toFixed(0)} is below the $${minMarketTvlUSD} floor; a rate on an empty market is not quotable`,
      reason: 'MARKET_NOT_LIQUID',
    };
  }

  const rates = row['rates'];
  if (!Array.isArray(rates)) return { error: 'rates array missing' };

  const match = (rates as Array<Record<string, unknown>>).find(
    (r) => r['side'] === spec.side && r['type'] === spec.type,
  );
  if (!match) return { error: `no ${spec.side}/${spec.type} rate` };

  const value = num(match['rate']);
  return value === null ? { error: 'rate not numeric' } : { value, weightUSD: tvl };
}

export function tvlWeightedMean(rows: Array<{ value: number; weightUSD: number }>): number {
  const totalWeight = rows.reduce((sum, r) => sum + r.weightUSD, 0);
  if (totalWeight <= 0) return median(rows.map((r) => r.value));
  return rows.reduce((sum, r) => sum + r.value * r.weightUSD, 0) / totalWeight;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function judge(
  source: SourceSpec,
  result: Awaited<ReturnType<typeof queryGraph>>,
  spec: MetricSpec,
  policy: FreshnessPolicy,
  head: number | null,
  bestPeerBlock: number | null,
  minMarketTvlUSD: number,
  asset?: string,
): SourceReport {
  const base = {
    protocol: source.protocol,
    chainId: source.chainId,
    deploymentId: source.id,
    latencyMs: result.latencyMs,
  };

  if (!result.ok) {
    return { ...base, status: 'REJECTED', why: 'QUERY_FAILED', detail: `${result.error}${result.detail ? `: ${result.detail}` : ''}` };
  }

  const ok = result as GraphResult;

  // A response is only evidence about the deployment we pinned. If the gateway
  // served something else, we do not merge it — we drop it.
  if (source.idKind === 'deployment' && ok.meta.deployment && ok.meta.deployment !== source.id) {
    return { ...base, status: 'REJECTED', why: 'PINNED_ID_MISMATCH', detail: `served ${ok.meta.deployment}` };
  }

  if (ok.meta.hasIndexingErrors) {
    return { ...base, status: 'REJECTED', why: 'INDEXING_ERRORS', block: ok.meta.block.number };
  }

  const fresh = measureFreshness(ok.meta.block.number, ok.meta.block.timestamp, head, bestPeerBlock);
  const withFreshness = {
    ...base,
    block: ok.meta.block.number,
    blockHash: ok.meta.block.hash,
    timestamp: ok.meta.block.timestamp,
    blockLag: fresh.blockLag,
    ageSeconds: fresh.ageSeconds,
    reference: fresh.reference,
  };

  if (fresh.reference === 'none') {
    return { ...withFreshness, status: 'REJECTED', why: 'NO_FRESHNESS_REFERENCE' };
  }
  if (fresh.blockLag !== null && fresh.blockLag > policy.maxBlockLag) {
    return { ...withFreshness, status: 'REJECTED', why: 'BLOCK_LAG_EXCEEDED', detail: `${fresh.blockLag} > ${policy.maxBlockLag}` };
  }
  if (fresh.ageSeconds !== null && fresh.ageSeconds > policy.maxAgeSeconds) {
    return { ...withFreshness, status: 'REJECTED', why: 'STALE_TIMESTAMP', detail: `${fresh.ageSeconds}s > ${policy.maxAgeSeconds}s` };
  }

  const extracted = extractMetric(ok.rows, spec, minMarketTvlUSD, asset);
  if ('error' in extracted) {
    return {
      ...withFreshness,
      status: 'REJECTED',
      why: extracted.reason ?? 'METRIC_UNAVAILABLE',
      detail: extracted.error,
    };
  }

  return { ...withFreshness, status: 'OK', value: extracted.value, weightUSD: extracted.weightUSD };
}

export async function resolve(req: ResolveRequest): Promise<ResolveOutcome> {
  const family = getFamily(req.family);
  if (!family) {
    return { resolved: false, reason: 'UNKNOWN_FAMILY', detail: `no family "${req.family}" in the registry`, sources: [], policy: null, survived: 0, required: 0 };
  }

  const spec = family.metrics[req.metric];
  if (!spec) {
    return { resolved: false, reason: 'UNKNOWN_METRIC', detail: `family "${req.family}" exposes: ${Object.keys(family.metrics).join(', ')}`, sources: [], policy: null, survived: 0, required: 0 };
  }

  const basePolicy = effectivePolicy(family, req.minSources);
  const policy: FreshnessPolicy = {
    ...basePolicy,
    ...(req.forceMaxBlockLag === undefined ? {} : { maxBlockLag: req.forceMaxBlockLag }),
    ...(req.forceMaxAgeSeconds === undefined ? {} : { maxAgeSeconds: req.forceMaxAgeSeconds }),
  };
  const minMarketTvlUSD = family.minMarketTvlUSD ?? 10_000;

  const sources = usableSources(family);
  if (sources.length < policy.minSources) {
    return {
      resolved: false,
      reason: 'SOURCES_UNPINNED',
      detail: `${sources.length} pinned source(s) in the registry, ${policy.minSources} required. Fill registry/families.json and run \`npm run registry:doctor\`.`,
      sources: [],
      policy,
      survived: sources.length,
      required: policy.minSources,
    };
  }

  const [heads, results] = await Promise.all([
    chainHeads(sources.map((s) => s.chainId)),
    Promise.all(sources.map((s) => queryGraph(s, family.query, { first: 100 }, family.rowsPath))),
  ]);

  // Best-peer fallback is computed per chain, and only used where no head is known.
  const bestPeerByChain = new Map<number, number>();
  results.forEach((r, i) => {
    const src = sources[i];
    if (!src || !r.ok) return;
    const current = bestPeerByChain.get(src.chainId) ?? 0;
    if (r.meta.block.number > current) bestPeerByChain.set(src.chainId, r.meta.block.number);
  });

  const reports = results.map((r, i) => {
    const src = sources[i] as SourceSpec;
    return judge(
      src,
      r,
      spec,
      policy,
      heads.get(src.chainId) ?? null,
      bestPeerByChain.get(src.chainId) ?? null,
      minMarketTvlUSD,
      req.asset,
    );
  });

  const survivors = reports.filter((r) => r.status === 'OK' && typeof r.value === 'number');

  if (survivors.length < policy.minSources) {
    return {
      resolved: false,
      reason: 'QUORUM_NOT_MET',
      detail: `${survivors.length} source(s) satisfied the policy, ${policy.minSources} required`,
      sources: reports,
      policy,
      survived: survivors.length,
      required: policy.minSources,
    };
  }

  const values = survivors.map((s) => s.value as number);
  const anchorChain = sources[0]?.chainId ?? 0;

  const isPeer = family.comparability === 'peer';
  const weighted = survivors.map((s) => ({ value: s.value as number, weightUSD: s.weightUSD ?? 0 }));
  const headline = isPeer ? tvlWeightedMean(weighted) : median(values);

  const lowest = survivors.reduce((a, b) => ((a.value as number) <= (b.value as number) ? a : b));
  const highest = survivors.reduce((a, b) => ((a.value as number) >= (b.value as number) ? a : b));
  const spread = (highest.value as number) - (lowest.value as number);
  const spreadBps = headline === 0 ? null : Math.round((spread / Math.abs(headline)) * 10_000);

  // On an `identical` family the sources index the same protocol on the same
  // chain, so they should return the same number. If they don't, at least one
  // is wrong and we cannot tell which — so we refuse rather than publish a
  // median that splits the difference between a right answer and a wrong one.
  //
  // This is what stops the freshness gate from being merely a recency check:
  // recent and wrong is still wrong.
  if (family.comparability === 'identical' && spreadBps !== null) {
    const tolerance = family.agreementToleranceBps ?? 100;
    if (spreadBps > tolerance) {
      return {
        resolved: false,
        reason: 'SOURCE_DISAGREEMENT',
        detail:
          `sources disagree by ${spreadBps} bps, tolerance is ${tolerance} bps. ` +
          'These deployments index the same protocol on the same chain, so they should match. ' +
          'At least one is wrong and the gateway cannot determine which.',
        sources: reports,
        policy,
        survived: survivors.length,
        required: policy.minSources,
      };
    }
  }

  return {
    resolved: true,
    answer: {
      value: headline,
      unit: spec.unit,
      method: isPeer ? 'tvl-weighted' : 'median',
      spread,
      spreadBps,
      contributors: survivors.length,
      comparability: family.comparability,
      ...(isPeer
        ? {
            range: {
              min: lowest.value as number,
              minProtocol: lowest.protocol,
              max: highest.value as number,
              maxProtocol: highest.protocol,
            },
            caveat:
              'These sources are different protocols that share one schema, so they are not expected to agree. ' +
              'The headline value is weighted by each market\'s TVL, which answers "what does capital here actually earn" rather than treating a wound-down pool as equal to a multi-billion-dollar one. ' +
              'For a rate-sensitive decision use `range` and the per-source values, not the headline.',
          }
        : {}),
    },
    sources: reports,
    policy,
    family,
    chainHead: { chainId: anchorChain, block: heads.get(anchorChain) ?? null },
  };
}
