import { keccak256, recoverMessageAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import type { Answer, SourceReport } from './resolver.js';
import type { FreshnessPolicy } from './registry.js';

import type { HcsAnchor } from './hcs.js';

/**
 * A receipt is the evidence a third party needs to check our work later: the
 * exact question, the answer's hash, and every pinned deployment plus the block
 * each one's claim rests on. Anyone holding a receipt and a gateway key can
 * re-derive the claim and, if it does not reproduce, open a dispute.
 *
 * The chain is the authority; the receipt is a pointer to where to look.
 * When HCS anchoring is configured, the digest is also published to a Hedera
 * consensus topic so existence-at-time does not depend on our store alone.
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
  /** Hedera Consensus Service publication of this digest, when configured. */
  hcs?: HcsAnchor | null;
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

export interface ReceiptVerification {
  digestMatches: boolean;
  recomputedDigest: `0x${string}`;
  /** null when the receipt was never signed */
  signatureValid: boolean | null;
  recoveredSigner: `0x${string}` | null;
  claimedSigner: `0x${string}` | null;
}

/**
 * Recompute the body digest and recover the EIP-191 signer from the signature.
 * Anyone with the receipt JSON can run the same checks offline.
 */
export async function verifySignedReceipt(receipt: SignedReceipt): Promise<ReceiptVerification> {
  const recomputedDigest = digestOf(receipt.body);
  const digestMatches = recomputedDigest.toLowerCase() === receipt.digest.toLowerCase();

  if (!receipt.signature) {
    return {
      digestMatches,
      recomputedDigest,
      signatureValid: null,
      recoveredSigner: null,
      claimedSigner: receipt.signer,
    };
  }

  try {
    const recoveredSigner = await recoverMessageAddress({
      message: { raw: receipt.digest },
      signature: receipt.signature,
    });
    const signerMatches =
      !receipt.signer || recoveredSigner.toLowerCase() === receipt.signer.toLowerCase();
    return {
      digestMatches,
      recomputedDigest,
      signatureValid: digestMatches && signerMatches,
      recoveredSigner,
      claimedSigner: receipt.signer,
    };
  } catch {
    return {
      digestMatches,
      recomputedDigest,
      signatureValid: false,
      recoveredSigner: null,
      claimedSigner: receipt.signer,
    };
  }
}
