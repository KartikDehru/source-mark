import { config } from './config.js';
import { appendTo, readCollection, writeCollection } from './store.js';
import type { SourceReport } from './resolver.js';

/**
 * Revenue routing and liability.
 *
 * Every settled read pays the deployments that actually answered it. A slice of
 * each payout is held back unvested for HOLDBACK_VESTING_SECONDS; that slice is
 * the liability pool. A proven-false receipt refunds the buyer out of the
 * responsible source's unvested balance.
 *
 * The consequence worth stating plainly: no source ever has to post collateral.
 * The penalty comes out of revenue the source has already earned but not yet
 * cleared, so a source that repeatedly serves stale data simply earns less and
 * eventually nothing.
 */

export interface Share {
  deploymentId: string;
  protocol: string;
  payoutAddress: string;
  amount: string;
  vested: string;
  heldBack: string;
}

export interface SplitResult {
  gross: string;
  routingFee: string;
  distributable: string;
  routingFeeBps: number;
  holdbackBps: number;
  holdbackVestingSeconds: number;
  shares: Share[];
  dust: string;
}

export interface LedgerEntry {
  ts: number;
  digest: string;
  family: string;
  metric: string;
  gross: string;
  routingFee: string;
  shares: Share[];
  transaction: string | null;
}

export interface DisputeEntry {
  ts: number;
  digest: string;
  claimant: string;
  reason: string;
  status: 'OPEN' | 'UPHELD' | 'REJECTED' | 'AMBIGUOUS';
  refunded: string;
  chargedTo: string[];
  /** How the gateway decided: re-derive against Graph, or arbiter override. */
  decision?: 'reproduce' | 'arbiter';
  reproduce?: {
    verdict: 'MATCH' | 'MISMATCH' | 'AMBIGUOUS';
    detail: string;
    expectedAnswerHash: string;
    recomputedAnswerHash: string | null;
  };
  onchain?: {
    ok: boolean;
    detail: string;
    openTx?: string;
    resolveTx?: string;
    openExplorer?: string;
    resolveExplorer?: string;
    upheld?: boolean;
  } | null;
}

export function computeSplit(
  gross: string,
  contributors: Array<{ deploymentId: string; protocol: string; payoutAddress: string }>,
): SplitResult {
  const total = BigInt(gross);
  const feeBps = BigInt(config.split.routingFeeBps);
  const holdBps = BigInt(config.split.holdbackBps);

  const routingFee = (total * feeBps) / 10_000n;
  const distributable = total - routingFee;

  const n = BigInt(Math.max(1, contributors.length));
  const per = distributable / n;

  const shares: Share[] = contributors.map((c) => {
    const heldBack = (per * holdBps) / 10_000n;
    return {
      deploymentId: c.deploymentId,
      protocol: c.protocol,
      payoutAddress: c.payoutAddress,
      amount: per.toString(),
      vested: (per - heldBack).toString(),
      heldBack: heldBack.toString(),
    };
  });

  const paidOut = per * n;

  return {
    gross: total.toString(),
    routingFee: routingFee.toString(),
    distributable: distributable.toString(),
    routingFeeBps: config.split.routingFeeBps,
    holdbackBps: config.split.holdbackBps,
    holdbackVestingSeconds: config.split.holdbackVestingSeconds,
    shares,
    dust: (distributable - paidOut).toString(),
  };
}

export function contributorsFrom(
  reports: SourceReport[],
  payoutByDeployment: Map<string, string>,
): Array<{ deploymentId: string; protocol: string; payoutAddress: string }> {
  return reports
    .filter((r) => r.status === 'OK')
    .map((r) => ({
      deploymentId: r.deploymentId,
      protocol: r.protocol,
      payoutAddress: payoutByDeployment.get(r.deploymentId) ?? 'unassigned',
    }));
}

export function recordSettlement(entry: LedgerEntry): void {
  appendTo<LedgerEntry>('ledger', entry);
}

export interface PayoutSummary {
  deploymentId: string;
  protocol: string;
  payoutAddress: string;
  reads: number;
  earned: string;
  vested: string;
  unvestedHoldback: string;
  slashed: string;
}

export function payoutSummaries(now = Math.floor(Date.now() / 1000)): PayoutSummary[] {
  const ledger = readCollection<LedgerEntry>('ledger');
  const disputes = readCollection<DisputeEntry>('disputes').filter((d) => d.status === 'UPHELD');

  const slashedBy = new Map<string, bigint>();
  for (const d of disputes) {
    if (d.chargedTo.length === 0) continue;
    const each = BigInt(d.refunded) / BigInt(d.chargedTo.length);
    for (const id of d.chargedTo) {
      slashedBy.set(id, (slashedBy.get(id) ?? 0n) + each);
    }
  }

  const acc = new Map<string, PayoutSummary & { _earned: bigint; _vested: bigint; _held: bigint }>();

  for (const entry of ledger) {
    const matured = now - entry.ts >= config.split.holdbackVestingSeconds;
    for (const s of entry.shares) {
      const current = acc.get(s.deploymentId) ?? {
        deploymentId: s.deploymentId,
        protocol: s.protocol,
        payoutAddress: s.payoutAddress,
        reads: 0,
        earned: '0',
        vested: '0',
        unvestedHoldback: '0',
        slashed: '0',
        _earned: 0n,
        _vested: 0n,
        _held: 0n,
      };
      current.reads += 1;
      current._earned += BigInt(s.amount);
      current._vested += BigInt(s.vested) + (matured ? BigInt(s.heldBack) : 0n);
      current._held += matured ? 0n : BigInt(s.heldBack);
      acc.set(s.deploymentId, current);
    }
  }

  return [...acc.values()].map((v) => {
    const slashed = slashedBy.get(v.deploymentId) ?? 0n;
    return {
      deploymentId: v.deploymentId,
      protocol: v.protocol,
      payoutAddress: v.payoutAddress,
      reads: v.reads,
      earned: (v._earned - slashed).toString(),
      vested: v._vested.toString(),
      unvestedHoldback: (v._held - slashed > 0n ? v._held - slashed : 0n).toString(),
      slashed: slashed.toString(),
    };
  });
}

export function recordDispute(entry: DisputeEntry): DisputeEntry {
  const rows = readCollection<DisputeEntry>('disputes');
  rows.push(entry);
  writeCollection('disputes', rows);
  return entry;
}

/**
 * Uphold a dispute: refund the buyer out of the unvested holdback of every
 * source that contributed the falsified claim. Capped at what is actually
 * unvested — we never promise a refund we cannot fund.
 */
export function upholdDispute(
  digest: string,
  claimant: string,
  reason: string,
  chargedTo: string[],
  extra?: Partial<Pick<DisputeEntry, 'decision' | 'reproduce' | 'onchain'>>,
): DisputeEntry {
  const summaries = payoutSummaries();
  const available = chargedTo.reduce((sum, id) => {
    const s = summaries.find((x) => x.deploymentId === id);
    return sum + BigInt(s?.unvestedHoldback ?? '0');
  }, 0n);

  return recordDispute({
    ts: Math.floor(Date.now() / 1000),
    digest,
    claimant,
    reason,
    status: 'UPHELD',
    refunded: available.toString(),
    chargedTo,
    ...extra,
  });
}

export function rejectDispute(
  digest: string,
  claimant: string,
  reason: string,
  chargedTo: string[],
  status: 'REJECTED' | 'AMBIGUOUS',
  extra?: Partial<Pick<DisputeEntry, 'decision' | 'reproduce' | 'onchain'>>,
): DisputeEntry {
  return recordDispute({
    ts: Math.floor(Date.now() / 1000),
    digest,
    claimant,
    reason,
    status,
    refunded: '0',
    chargedTo,
    ...extra,
  });
}
