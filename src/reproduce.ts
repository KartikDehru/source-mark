import { queryGraph } from './graph.js';
import { digestOf } from './receipt.js';
import { getFamily, type MetricSpec, type SourceSpec } from './registry.js';
import { median, tvlWeightedMean, type Answer } from './resolver.js';
import type { ReceiptBody, SignedReceipt } from './receipt.js';

/**
 * Re-derive a receipt against live Graph data at the blocks it named.
 *
 * This is the dispute decision function. If the recomputed answer hash matches,
 * the receipt stands and the dispute is rejected. If it does not match, the
 * holdback is slashable. If Graph cannot answer at those blocks, the outcome is
 * ambiguous and an arbiter would still be needed — we do not slash on doubt.
 */

export type ReproduceVerdict = 'MATCH' | 'MISMATCH' | 'AMBIGUOUS';

export interface SourceReproduction {
  deploymentId: string;
  protocol: string;
  block: number;
  ok: boolean;
  value?: number;
  weightUSD?: number;
  error?: string;
  servedBlock?: number;
}

export interface ReproduceResult {
  verdict: ReproduceVerdict;
  detail: string;
  expectedAnswerHash: `0x${string}`;
  recomputedAnswerHash: `0x${string}` | null;
  recomputedAnswer: Answer | null;
  sources: SourceReproduction[];
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

function extractMetric(
  rows: Array<Record<string, unknown>>,
  spec: MetricSpec,
  minMarketTvlUSD: number,
  asset?: string | null,
): { value: number; weightUSD: number } | { error: string } {
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
  if (tvl < minMarketTvlUSD) {
    return { error: `market TVL $${tvl.toFixed(0)} below floor` };
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

function sourceSpecFor(familyName: string, deploymentId: string): SourceSpec | null {
  const family = getFamily(familyName);
  if (!family) return null;
  return family.sources.find((s) => s.id === deploymentId) ?? null;
}

function aggregateAnswer(
  familyName: string,
  metric: string,
  survivors: Array<{ protocol: string; value: number; weightUSD: number }>,
): Answer | null {
  const family = getFamily(familyName);
  const spec = family?.metrics[metric];
  if (!family || !spec || survivors.length === 0) return null;

  const isPeer = family.comparability === 'peer';
  const values = survivors.map((s) => s.value);
  const headline = isPeer
    ? tvlWeightedMean(survivors.map((s) => ({ value: s.value, weightUSD: s.weightUSD })))
    : median(values);
  const lowest = survivors.reduce((a, b) => (a.value <= b.value ? a : b));
  const highest = survivors.reduce((a, b) => (a.value >= b.value ? a : b));
  const spread = highest.value - lowest.value;
  const spreadBps = headline === 0 ? null : Math.round((spread / Math.abs(headline)) * 10_000);

  return {
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
            min: lowest.value,
            minProtocol: lowest.protocol,
            max: highest.value,
            maxProtocol: highest.protocol,
          },
          caveat:
            'These sources are different protocols that share one schema, so they are not expected to agree. ' +
            'The headline value is weighted by each market\'s TVL, which answers "what does capital here actually earn" rather than treating a wound-down pool as equal to a multi-billion-dollar one. ' +
            'For a rate-sensitive decision use `range` and the per-source values, not the headline.',
        }
      : {}),
  };
}

export async function reproduceReceipt(receipt: SignedReceipt): Promise<ReproduceResult> {
  const body: ReceiptBody = receipt.body;
  const family = getFamily(body.family);
  if (!family) {
    return {
      verdict: 'AMBIGUOUS',
      detail: `Unknown family "${body.family}" — cannot re-derive`,
      expectedAnswerHash: body.answerHash,
      recomputedAnswerHash: null,
      recomputedAnswer: null,
      sources: [],
    };
  }

  const metric = body.request.metric;
  const spec = family.metrics[metric];
  if (!spec) {
    return {
      verdict: 'AMBIGUOUS',
      detail: `Family no longer exposes metric "${metric}"`,
      expectedAnswerHash: body.answerHash,
      recomputedAnswerHash: null,
      recomputedAnswer: null,
      sources: [],
    };
  }

  const minMarketTvlUSD = family.minMarketTvlUSD ?? 10_000;
  const asset = body.request.asset;

  const sources: SourceReproduction[] = [];
  const survivors: Array<{ protocol: string; value: number; weightUSD: number }> = [];

  for (const anchor of body.sources) {
    const src = sourceSpecFor(body.family, anchor.deploymentId);
    if (!src) {
      sources.push({
        deploymentId: anchor.deploymentId,
        protocol: anchor.protocol,
        block: anchor.block,
        ok: false,
        error: 'deployment no longer in registry',
      });
      continue;
    }

    const result = await queryGraph(src, family.query, { first: 100 }, family.rowsPath, 20_000, anchor.block);
    if (!result.ok) {
      sources.push({
        deploymentId: anchor.deploymentId,
        protocol: anchor.protocol,
        block: anchor.block,
        ok: false,
        error: `${result.error}${result.detail ? `: ${result.detail}` : ''}`,
      });
      continue;
    }

    if (src.idKind === 'deployment' && result.meta.deployment && result.meta.deployment !== src.id) {
      sources.push({
        deploymentId: anchor.deploymentId,
        protocol: anchor.protocol,
        block: anchor.block,
        ok: false,
        servedBlock: result.meta.block.number,
        error: `pinned id mismatch: served ${result.meta.deployment}`,
      });
      continue;
    }

    const extracted = extractMetric(result.rows, spec, minMarketTvlUSD, asset);
    if ('error' in extracted) {
      sources.push({
        deploymentId: anchor.deploymentId,
        protocol: anchor.protocol,
        block: anchor.block,
        ok: false,
        servedBlock: result.meta.block.number,
        error: extracted.error,
      });
      continue;
    }

    sources.push({
      deploymentId: anchor.deploymentId,
      protocol: anchor.protocol,
      block: anchor.block,
      ok: true,
      value: extracted.value,
      weightUSD: extracted.weightUSD,
      servedBlock: result.meta.block.number,
    });
    survivors.push({
      protocol: anchor.protocol,
      value: extracted.value,
      weightUSD: extracted.weightUSD,
    });
  }

  if (survivors.length < body.sources.length || survivors.length === 0) {
    return {
      verdict: 'AMBIGUOUS',
      detail:
        `Could not re-query ${body.sources.length - survivors.length} of ${body.sources.length} ` +
        'sources at their receipt blocks (pruned history, gateway error, or registry drift). No slash on doubt.',
      expectedAnswerHash: body.answerHash,
      recomputedAnswerHash: null,
      recomputedAnswer: null,
      sources,
    };
  }

  const answer = aggregateAnswer(body.family, metric, survivors);
  if (!answer) {
    return {
      verdict: 'AMBIGUOUS',
      detail: 'Failed to aggregate a recomputed answer',
      expectedAnswerHash: body.answerHash,
      recomputedAnswerHash: null,
      recomputedAnswer: null,
      sources,
    };
  }

  // Original peer answers include a fixed `caveat` string — hash with it.
  const recomputedAnswerHash = digestOf(answer);
  const expected = body.answerHash.toLowerCase();
  const matches = recomputedAnswerHash.toLowerCase() === expected;

  let valueAligned = matches;
  if (!matches) {
    valueAligned = body.sources.every((a) => {
      const got = sources.find((s) => s.deploymentId === a.deploymentId);
      return got?.ok && typeof got.value === 'number' && Math.abs(got.value - a.value) < 1e-12;
    });
  }

  if (matches || valueAligned) {
    return {
      verdict: 'MATCH',
      detail: matches
        ? 'Re-derived answer hash matches the receipt. Dispute rejected — no slash.'
        : 'Per-source values at the recorded blocks match the receipt anchors. Dispute rejected — no slash.',
      expectedAnswerHash: body.answerHash,
      recomputedAnswerHash,
      recomputedAnswer: answer,
      sources,
    };
  }

  return {
    verdict: 'MISMATCH',
    detail:
      'Re-derived answer does not match the receipt answerHash. Sources are slashable from unvested holdback.',
    expectedAnswerHash: body.answerHash,
    recomputedAnswerHash,
    recomputedAnswer: answer,
    sources,
  };
}
