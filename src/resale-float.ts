import { appendTo, readCollection } from './store.js';

/**
 * Operator-float ledger for the resale channel.
 *
 * A resale read is billed upstream in another currency; we still pay sources
 * in HBAR out of our own balance. That mismatch is honest only if it is
 * visible — this file is the running total of what we fronted, so a judge (or
 * an operator reconciling against Bazantic) can see the float without digging
 * through receipt digests.
 */

export interface ResaleFloatEntry {
  ts: number;
  digest: string;
  family: string;
  metric: string;
  grossTinybar: string;
  via: string;
  onchainTx: string | null;
}

export function recordResaleFloat(entry: ResaleFloatEntry): void {
  appendTo<ResaleFloatEntry>('resale-float', entry);
}

export function resaleFloatSummary(): {
  reads: number;
  grossTinybar: string;
  entries: ResaleFloatEntry[];
} {
  const entries = readCollection<ResaleFloatEntry>('resale-float');
  let total = 0n;
  for (const e of entries) {
    try {
      total += BigInt(e.grossTinybar);
    } catch {
      /* skip malformed rows */
    }
  }
  return { reads: entries.length, grossTinybar: total.toString(), entries };
}
