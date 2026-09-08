import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import type { Answer, SourceReport } from './resolver.js';
import type { FreshnessPolicy } from './registry.js';

/**
 * A receipt is the evidence a third party needs to check our work later: the
 * exact question, the answer's hash, and every pinned deployment plus the block
 * each one's claim rests on. Anyone holding a receipt and a gateway key can
 * re-derive the claim and, if it does not reproduce, open a dispute.
 *
 * The chain is the authority; the receipt is a pointer to where to look.
 */

export interface ReceiptSourceAnchor {
  deploymentId: string;
  protocol: string;
  chainId: number;
  block: number;
  blockHash: string | null;
  timestamp: number | null;
  value: number;
}

export interface ReceiptBody {
  v: 1;
  family: string;
  request: { metric: string; asset: string | null };
  answerHash: `0x${string}`;
  policy: FreshnessPolicy;
  sources: ReceiptSourceAnchor[];
  chainHead: { chainId: number; block: number | null };
  payment: {
    network: string;
    amount: string;
    asset: string;
    payer: string | null;
    transaction: string | null;
  };
  issuedAt: number;
}

export interface SignedReceipt {
  digest: `0x${string}`;
  signature: `0x${string}` | null;
  signer: `0x${string}` | null;
  body: ReceiptBody;
}

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function digestOf(value: unknown): `0x${string}` {
  return keccak256(toHex(canonicalize(value)));
}

function signingAccount() {
  const key = config.receipts.signingKey;
  if (!key) return null;
  const normalized = (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
  return privateKeyToAccount(normalized);
}

export function receiptSignerAddress(): `0x${string}` | null {
  return signingAccount()?.address ?? null;
}

export async function issueReceipt(input: {
  family: string;
  metric: string;
  asset?: string;
  answer: Answer;
  sources: SourceReport[];
  policy: FreshnessPolicy;
  chainHead: { chainId: number; block: number | null };
  payment: { network: string; amount: string; asset: string; payer?: string; transaction?: string };
}): Promise<SignedReceipt> {
  const anchors: ReceiptSourceAnchor[] = input.sources
    .filter((s) => s.status === 'OK' && typeof s.value === 'number')
    .map((s) => ({
      deploymentId: s.deploymentId,
      protocol: s.protocol,
      chainId: s.chainId,
      block: s.block ?? 0,
      blockHash: s.blockHash ?? null,
      timestamp: s.timestamp ?? null,
      value: s.value as number,
    }));

  const body: ReceiptBody = {
    v: 1,
    family: input.family,
    request: { metric: input.metric, asset: input.asset ?? null },
    answerHash: digestOf(input.answer),
    policy: input.policy,
    sources: anchors,
    chainHead: input.chainHead,
    payment: {
      network: input.payment.network,
      amount: input.payment.amount,
      asset: input.payment.asset,
      payer: input.payment.payer ?? null,
      transaction: input.payment.transaction ?? null,
    },
    issuedAt: Math.floor(Date.now() / 1000),
  };

  const digest = digestOf(body);
  const account = signingAccount();

  if (!account) return { digest, signature: null, signer: null, body };

  const signature = await account.signMessage({ message: { raw: digest } });
  return { digest, signature, signer: account.address, body };
}
