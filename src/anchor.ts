import { config } from './config.js';
import { log } from './logger.js';

/**
 * Chain head anchoring. A subgraph's self-reported block is a claim, not a
 * fact — it is only meaningful next to where the chain actually is. In `rpc`
 * mode we go and look. In `relative` mode we fall back to comparing sources
 * against their best-indexed peer, which is strictly weaker and is labelled as
 * such everywhere it surfaces.
 */

interface HeadCacheEntry {
  block: number;
  fetchedAt: number;
}

const HEAD_TTL_MS = 6_000;
const cache = new Map<number, HeadCacheEntry>();

async function rpcBlockNumber(url: string, timeoutMs = 6_000): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    if (!json.result) return null;
    return Number.parseInt(json.result, 16);
  } catch (err) {
    log.debug(`rpc head fetch failed for ${url}`, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function chainHead(chainId: number): Promise<number | null> {
  if (config.anchor.mode !== 'rpc') return null;

  const hit = cache.get(chainId);
  if (hit && Date.now() - hit.fetchedAt < HEAD_TTL_MS) return hit.block;

  const url = config.anchor.rpcByChainId[chainId];
  if (!url) {
    log.warn(`no RPC configured for chainId ${chainId}; falling back to relative anchoring`);
    return null;
  }

  const block = await rpcBlockNumber(url);
  if (block === null) return null;

  cache.set(chainId, { block, fetchedAt: Date.now() });
  return block;
}

/** Resolve heads for every chain a read touches, in parallel. */
export async function chainHeads(chainIds: number[]): Promise<Map<number, number | null>> {
  const unique = [...new Set(chainIds)];
  const entries = await Promise.all(unique.map(async (id) => [id, await chainHead(id)] as const));
  return new Map(entries);
}

export interface Freshness {
  blockLag: number | null;
  ageSeconds: number | null;
  reference: 'chain-head' | 'best-peer' | 'none';
  referenceBlock: number | null;
}

export function measureFreshness(
  indexedBlock: number,
  indexedTimestamp: number | null,
  head: number | null,
  bestPeerBlock: number | null,
  now = Math.floor(Date.now() / 1000),
): Freshness {
  const ageSeconds = indexedTimestamp === null ? null : Math.max(0, now - indexedTimestamp);

  if (head !== null) {
    return {
      blockLag: Math.max(0, head - indexedBlock),
      ageSeconds,
      reference: 'chain-head',
      referenceBlock: head,
    };
  }
  if (bestPeerBlock !== null) {
    return {
      blockLag: Math.max(0, bestPeerBlock - indexedBlock),
      ageSeconds,
      reference: 'best-peer',
      referenceBlock: bestPeerBlock,
    };
  }
  return { blockLag: null, ageSeconds, reference: 'none', referenceBlock: null };
}
