import {
  AccountId,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  Status,
} from '@hashgraph/sdk';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Hedera Consensus Service anchoring for signed receipts.
 *
 * Chain-head anchoring (src/anchor.ts) checks freshness of subgraph claims.
 * HCS anchoring is different: after a receipt is signed, we publish its digest
 * to a public topic so a third party can later prove "this digest existed at
 * consensus time T" without trusting our database.
 *
 * Failure is non-fatal. A read that answered and settled still returns; the
 * receipt simply carries `hcs: null` and /health reports the problem.
 */

export interface HcsAnchor {
  network: string;
  topicId: string;
  sequenceNumber: number;
  transactionId: string;
  consensusTimestamp: string | null;
  explorer: string;
  mirror: string;
}

export interface HcsTopicInfo {
  configured: boolean;
  enabled: boolean;
  network: string;
  topicId: string | null;
  operatorId: string | null;
  explorer: string | null;
}

function strip0x(key: string): string {
  return key.startsWith('0x') || key.startsWith('0X') ? key.slice(2) : key;
}

function networkSlug(): string {
  return config.hcs.network === 'mainnet' ? 'mainnet' : 'testnet';
}

export function hcsExplorerTopicUrl(topicId: string): string {
  return `https://hashscan.io/${networkSlug()}/topic/${topicId}`;
}

export function hcsExplorerTxUrl(transactionId: string): string {
  return `https://hashscan.io/${networkSlug()}/transaction/${encodeURIComponent(transactionId)}`;
}

export function hcsMirrorMessageUrl(topicId: string, sequenceNumber: number): string {
  return `${config.hcs.mirror}/api/v1/topics/${encodeURIComponent(topicId)}/messages/${sequenceNumber}`;
}

export function hcsStatus(): HcsTopicInfo {
  const topicId = config.hcs.topicId || null;
  const operatorId = config.hcs.operatorId || null;
  const configured = Boolean(topicId && operatorId && config.hcs.operatorKey);
  return {
    configured,
    enabled: config.hcs.enabled && configured,
    network: config.hcs.network,
    topicId,
    operatorId,
    explorer: topicId ? hcsExplorerTopicUrl(topicId) : null,
  };
}

function buildClient(): Client | null {
  const { operatorId, operatorKey, network } = config.hcs;
  if (!operatorId || !operatorKey) return null;

  const client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  const key = PrivateKey.fromStringECDSA(strip0x(operatorKey));
  client.setOperator(AccountId.fromString(operatorId), key);
  return client;
}

export async function createHcsTopic(memo = 'SourceMark receipt digests'): Promise<{
  topicId: string;
  transactionId: string;
  explorer: string;
}> {
  const client = buildClient();
  if (!client) {
    throw new Error('HCS operator is not configured (HCS_OPERATOR_ID / HCS_OPERATOR_KEY or X402_PAY_TO / OPERATOR_PRIVATE_KEY)');
  }

  try {
    const tx = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
    const receipt = await tx.getReceipt(client);
    if (receipt.status !== Status.Success || !receipt.topicId) {
      throw new Error(`TopicCreate failed: ${receipt.status.toString()}`);
    }
    const topicId = receipt.topicId.toString();
    const transactionId = tx.transactionId.toString();
    return {
      topicId,
      transactionId,
      explorer: hcsExplorerTopicUrl(topicId),
    };
  } finally {
    client.close();
  }
}

export async function anchorReceiptOnHcs(input: {
  digest: string;
  family: string;
  issuedAt: number;
}): Promise<HcsAnchor | null> {
  const status = hcsStatus();
  if (!status.enabled || !status.topicId) return null;

  const client = buildClient();
  if (!client) return null;

  const payload = JSON.stringify({
    v: 1,
    kind: 'sourcemark.receipt',
    digest: input.digest.toLowerCase(),
    family: input.family,
    issuedAt: input.issuedAt,
  });

  try {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(status.topicId)
      .setMessage(payload)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    if (receipt.status !== Status.Success) {
      throw new Error(`TopicMessageSubmit failed: ${receipt.status.toString()}`);
    }

    const sequenceNumber = Number(receipt.topicSequenceNumber ?? 0);
    const transactionId = tx.transactionId.toString();
    let consensusTimestamp: string | null = null;
    try {
      const record = await tx.getRecord(client);
      consensusTimestamp = record.consensusTimestamp?.toString() ?? null;
    } catch {
      // Mirror will have the timestamp shortly; HashScan tx link is enough.
    }

    const anchor: HcsAnchor = {
      network: config.hcs.network,
      topicId: status.topicId,
      sequenceNumber,
      transactionId,
      consensusTimestamp,
      explorer: hcsExplorerTxUrl(transactionId),
      mirror: hcsMirrorMessageUrl(status.topicId, sequenceNumber),
    };
    log.info(`hcs anchored receipt ${input.digest.slice(0, 12)}… seq=${sequenceNumber}`);
    return anchor;
  } catch (err) {
    log.warn('hcs anchor failed', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    client.close();
  }
}

/**
 * Re-fetch a topic message from the mirror and check it carries our digest.
 * Used by GET /v1/receipts/:digest so verification is not "we said so".
 */
export async function verifyHcsAnchor(
  anchor: HcsAnchor,
  expectedDigest: string,
): Promise<{ ok: boolean; detail: string; message?: unknown }> {
  try {
    const res = await fetch(anchor.mirror, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) {
      return { ok: false, detail: 'Mirror has not indexed this sequence yet (retry in a few seconds).' };
    }
    if (!res.ok) return { ok: false, detail: `Mirror HTTP ${res.status}` };

    const body = (await res.json()) as { message?: string; sequence_number?: number; consensus_timestamp?: string };
    if (!body.message) return { ok: false, detail: 'Mirror response missing message body' };

    const decoded = Buffer.from(body.message, 'base64').toString('utf8');
    let parsed: { digest?: string; kind?: string } | null = null;
    try {
      parsed = JSON.parse(decoded) as { digest?: string; kind?: string };
    } catch {
      return { ok: false, detail: 'HCS message is not JSON', message: decoded };
    }

    if (parsed.kind !== 'sourcemark.receipt') {
      return { ok: false, detail: `Unexpected kind ${parsed.kind ?? 'missing'}`, message: parsed };
    }
    if ((parsed.digest || '').toLowerCase() !== expectedDigest.toLowerCase()) {
      return { ok: false, detail: 'Digest in HCS message does not match receipt', message: parsed };
    }
    return {
      ok: true,
      detail: `Mirror confirms digest at sequence ${body.sequence_number ?? anchor.sequenceNumber}`,
      message: parsed,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
