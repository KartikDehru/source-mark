/**
 * Acting buyer: pay for a proven rate, decide against a threshold, optionally
 * confirm with a second paid read, then emit a signed action intent.
 *
 * REFUSED ticks never act and are never charged — that is the whole point.
 */

import { payAndRead, type PayAndReadResult } from './buyer.js';
import { appendTo, readCollection } from './store.js';
import { canonicalize, digestOf } from './receipt.js';
import { config } from './config.js';
import { privateKeyToAccount } from 'viem/accounts';

export type ActDecision = 'ENTER' | 'HOLD' | 'NONE';

export interface ActionIntentBody {
  v: 1;
  kind: 'supply-threshold';
  family: string;
  metric: string;
  asset: string | null;
  answerValue: number | null;
  unit: string | null;
  threshold: number;
  decision: ActDecision;
  receiptDigest: string | null;
  /** True when a second paid confirm read still cleared the threshold. */
  confirmed: boolean;
  confirmValue: number | null;
  confirmReceiptDigest: string | null;
  note: string;
  at: number;
}

export interface SignedActionIntent {
  digest: `0x${string}`;
  signature: `0x${string}` | null;
  signer: `0x${string}` | null;
  body: ActionIntentBody;
}

export interface ActTickResult {
  url: string;
  read: PayAndReadResult;
  confirm?: PayAndReadResult;
  intent: SignedActionIntent;
}

function signingAccount() {
  const key = config.receipts.signingKey;
  if (!key) return null;
  const normalized = (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
  return privateKeyToAccount(normalized);
}

export async function signActionIntent(body: ActionIntentBody): Promise<SignedActionIntent> {
  const digest = digestOf(body);
  const account = signingAccount();
  if (!account) return { digest, signature: null, signer: null, body };
  const signature = await account.signMessage({ message: { raw: digest } });
  return { digest, signature, signer: account.address, body };
}

export function decideThreshold(value: number | null | undefined, threshold: number): ActDecision {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'NONE';
  return value >= threshold ? 'ENTER' : 'HOLD';
}

function answerFrom(body: unknown): { value: number; unit: string } | null {
  const a = (body as { answer?: { value?: number; unit?: string } } | undefined)?.answer;
  if (!a || typeof a.value !== 'number') return null;
  return { value: a.value, unit: a.unit ?? '' };
}

function digestFrom(body: unknown): string | null {
  const d = (body as { receipt?: { digest?: string } } | undefined)?.receipt?.digest;
  return typeof d === 'string' ? d : null;
}

export async function runActTick(opts: {
  base: string;
  family: string;
  metric: string;
  asset?: string;
  threshold: number;
  /** When ENTER, pay again with a tighter lag to confirm before acting. */
  confirm?: boolean;
  strictLagConfirm?: number;
}): Promise<ActTickResult> {
  const url = new URL(`/v1/reads/${opts.family}`, opts.base);
  url.searchParams.set('metric', opts.metric);
  if (opts.asset) url.searchParams.set('asset', opts.asset);

  const read = await payAndRead(url.toString());
  let decision: ActDecision = 'NONE';
  let answer = null as { value: number; unit: string } | null;
  let confirm: PayAndReadResult | undefined;
  let confirmed = false;
  let confirmValue: number | null = null;
  let confirmReceiptDigest: string | null = null;
  let note = '';

  if (read.ok) {
    answer = answerFrom(read.body);
    decision = decideThreshold(answer?.value, opts.threshold);
    if (decision === 'ENTER' && opts.confirm !== false) {
      const confirmUrl = new URL(url.toString());
      confirmUrl.searchParams.set('strictLag', String(opts.strictLagConfirm ?? 2));
      confirm = await payAndRead(confirmUrl.toString());
      if (confirm.ok) {
        const ca = answerFrom(confirm.body);
        confirmValue = ca?.value ?? null;
        confirmReceiptDigest = digestFrom(confirm.body);
        const still = decideThreshold(confirmValue, opts.threshold);
        confirmed = still === 'ENTER';
        if (!confirmed) {
          decision = 'HOLD';
          note = 'Initial read cleared the threshold; confirm read did not — holding.';
        } else {
          note = `ENTER: rate ≥ ${opts.threshold} on read + confirm; agent would size a position.`;
        }
      } else if (confirm.status === 409) {
        decision = 'HOLD';
        note = 'Confirm read REFUSED — agent does not act on an unproven second look.';
      } else {
        decision = 'HOLD';
        note = `Confirm read failed HTTP ${confirm.status} — no action.`;
      }
    } else if (decision === 'ENTER') {
      confirmed = true;
      note = `ENTER: rate ≥ ${opts.threshold}; confirm step skipped.`;
    } else {
      note = `HOLD: rate below threshold ${opts.threshold}; agent takes no position.`;
    }
  } else if (read.status === 409) {
    decision = 'NONE';
    note = 'REFUSED — not charged, agent takes no action.';
  } else {
    decision = 'NONE';
    note = `ERROR HTTP ${read.status} — agent takes no action.`;
  }

  const intent = await signActionIntent({
    v: 1,
    kind: 'supply-threshold',
    family: opts.family,
    metric: opts.metric,
    asset: opts.asset ?? null,
    answerValue: answer?.value ?? null,
    unit: answer?.unit ?? null,
    threshold: opts.threshold,
    decision,
    receiptDigest: digestFrom(read.body),
    confirmed,
    confirmValue,
    confirmReceiptDigest,
    note,
    at: Math.floor(Date.now() / 1000),
  });

  appendTo('agent-intents', intent);
  return { url: url.toString(), read, confirm, intent };
}

export function listActionIntents(limit = 50): SignedActionIntent[] {
  const rows = readCollection<SignedActionIntent>('agent-intents');
  return rows.slice(-limit).reverse();
}

/** Exported for tests / debugging of canonical bytes. */
export function intentCanonical(body: ActionIntentBody): string {
  return canonicalize(body);
}
