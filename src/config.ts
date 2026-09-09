import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';

export type AnchorMode = 'rpc' | 'relative';
export type PaymentMode = 'x402' | 'free';
export type SplitMode = 'ledger' | 'onchain';

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`env ${key} must be an integer, got "${v}"`);
  return n;
}

function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = str(key, fallback) as T;
  if (!allowed.includes(v)) {
    throw new Error(`env ${key} must be one of ${allowed.join(' | ')}, got "${v}"`);
  }
  return v;
}

export const config = {
  port: int('PORT', 8787),
  logLevel: str('LOG_LEVEL', 'info'),

  graph: {
    apiKey: str('GRAPH_API_KEY'),
    gateway: str('GRAPH_GATEWAY', 'https://gateway.thegraph.com').replace(/\/+$/, ''),
  },

  policy: {
    maxBlockLag: int('MAX_BLOCK_LAG', 50),
    maxAgeSeconds: int('MAX_AGE_SECONDS', 600),
    minSources: int('MIN_SOURCES', 2),
  },

  anchor: {
    mode: oneOf('ANCHOR_MODE', ['rpc', 'relative'] as const, 'rpc'),
    rpcByChainId: {
      1: str('ETHEREUM_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
      8453: str('BASE_RPC_URL', 'https://base-rpc.publicnode.com'),
      42161: str('ARBITRUM_RPC_URL', 'https://arbitrum-one-rpc.publicnode.com'),
    } as Record<number, string>,
  },

  x402: {
    mode: oneOf('PAYMENT_MODE', ['x402', 'free'] as const, 'x402'),
    facilitator: str('X402_FACILITATOR', 'https://api.testnet.blocky402.com').replace(/\/+$/, ''),
    network: str('X402_NETWORK', 'hedera:testnet'),
    payTo: str('X402_PAY_TO'),
    asset: str('X402_ASSET', '0.0.0'),
    price: str('X402_PRICE', '100000'),
    timeoutSeconds: int('X402_TIMEOUT_SECONDS', 300),
  },

  /**
   * The resale channel.
   *
   * Bazantic settles in USDC on Base or Tempo; this service prices reads in
   * HBAR on Hedera. Those rails do not meet, so a Bazantic-fronted gateway
   * cannot answer our x402 challenge no matter how it is configured. Rather
   * than register an integration whose payment leg can never execute, the
   * gateway is registered as `api-key`: Bazantic bills its own callers, and
   * forwards this shared secret to prove the request came through it.
   *
   * What does NOT change on this path: the read is resolved identically, a
   * refusal is still free and still refuses, and sources are still paid onchain
   * in HBAR. Only the *inbound* leg differs — it is covered by the operator
   * float instead of a per-read x402 settlement, which is what a reseller
   * arrangement actually looks like. Reads arriving this way are marked
   * `channel: "resale"` in the response and the receipt so the distinction
   * survives into the evidence rather than living in a README.
   *
   * Unset disables the channel entirely, so a missing secret fails closed.
   */
  resale: {
    apiKey: str('RESALE_API_KEY'),
    label: str('RESALE_LABEL', 'bazantic'),
  },

  receipts: {
    signingKey: str('RECEIPT_SIGNING_KEY'),
  },

  /**
   * HCS receipt anchoring. Separate from ANCHOR_MODE (which is chain-head
   * freshness for subgraph claims). When enabled, every signed receipt digest
   * is submitted to a public consensus topic so the evidence trail is not only
   * in our store.
   *
   * Defaults the operator to the payout receiver + OPERATOR_PRIVATE_KEY, since
   * that account already pays gas for onchain splits on this deployment.
   */
  hcs: {
    enabled: str('HCS_ENABLED', 'true') !== 'false',
    network: oneOf('HCS_NETWORK', ['testnet', 'mainnet'] as const, 'testnet'),
    topicId: str('HCS_TOPIC_ID'),
    operatorId: str('HCS_OPERATOR_ID', str('X402_PAY_TO')),
    operatorKey: str('HCS_OPERATOR_KEY', str('OPERATOR_PRIVATE_KEY')),
    mirror: str('HEDERA_MIRROR_NODE', 'https://testnet.mirrornode.hedera.com').replace(/\/+$/, ''),
  },

  split: {
    mode: oneOf('SPLIT_MODE', ['ledger', 'onchain'] as const, 'ledger'),
    routingFeeBps: int('ROUTING_FEE_BPS', 1000),
    holdbackBps: int('HOLDBACK_BPS', 2000),
    holdbackVestingSeconds: int('HOLDBACK_VESTING_SECONDS', 604800),
    // SPLIT_MODE=onchain only. The gateway signs recordRead() with this key,
    // which the contract limits to crediting sources — it cannot withdraw the
    // fee or rule on disputes.
    contractAddress: str('SOURCE_PAYOUTS_ADDRESS'),
    recorderKey: str('OPERATOR_PRIVATE_KEY'),
    arbiterAddress: str('ARBITER_ADDRESS'),
    /** Signs resolveDispute after a reproduce MISMATCH. Must control arbiterAddress. */
    arbiterKey: str('ARBITER_PRIVATE_KEY'),
    disputeBondTinybar: str('DISPUTE_BOND_TINYBAR', '100000000'),
    /** Onchain silence window before anyone may resolveAfterDeadline. Deploy-time immutable. */
    disputeResolveSeconds: int('DISPUTE_RESOLVE_SECONDS', 120),
    jsonRpc: str('HEDERA_JSON_RPC', 'https://testnet.hashio.io/api'),
  },

  buyer: {
    accountId: str('BUYER_ACCOUNT_ID'),
    privateKey: str('BUYER_PRIVATE_KEY'),
  },
} as const;

/**
 * Config problems we can detect at boot. These are surfaced on /health rather
 * than thrown, because a partially-configured service should still be able to
 * serve its 402 challenge and explain honestly what it cannot do.
 */
export function configWarnings(): string[] {
  const w: string[] = [];
  if (!config.graph.apiKey) {
    w.push('GRAPH_API_KEY is unset: every read will REFUSE. Live Graph data is required; fixtures are never substituted.');
  }
  if (config.x402.mode === 'x402' && !config.x402.payTo) {
    w.push('X402_PAY_TO is unset: cannot build payment requirements. Set it or run PAYMENT_MODE=free.');
  }
  if (!config.receipts.signingKey) {
    w.push('RECEIPT_SIGNING_KEY is unset: answers will be returned unsigned.');
  }
  if (config.hcs.enabled) {
    if (!config.hcs.topicId) {
      w.push('HCS_ENABLED but HCS_TOPIC_ID is unset: run `npm run hcs:setup` to create the receipt topic.');
    } else if (!config.hcs.operatorId || !config.hcs.operatorKey) {
      w.push('HCS_TOPIC_ID is set but the HCS operator id/key is missing: set HCS_OPERATOR_ID/HCS_OPERATOR_KEY or X402_PAY_TO/OPERATOR_PRIVATE_KEY.');
    }
  }
  if (config.split.routingFeeBps + config.split.holdbackBps > 10_000) {
    w.push('ROUTING_FEE_BPS + HOLDBACK_BPS exceeds 100%.');
  }
  if (config.split.mode === 'onchain' && !config.split.arbiterAddress) {
    w.push(
      'SPLIT_MODE=onchain but ARBITER_ADDRESS is unset: run `npm run payouts:set-arbiter` after setting a distinct ARBITER_ADDRESS.',
    );
  }
  if (config.split.mode === 'onchain' && config.split.arbiterAddress && !config.split.arbiterKey) {
    w.push(
      'ARBITER_PRIVATE_KEY is unset: MATCH→reject and fast MISMATCH resolve need the arbiter; MISMATCH can still open and later resolveAfterDeadline.',
    );
  }
  if (config.split.mode === 'onchain' && config.split.recorderKey && config.split.arbiterAddress) {
    try {
      const key = config.split.recorderKey.startsWith('0x')
        ? (config.split.recorderKey as `0x${string}`)
        : (`0x${config.split.recorderKey}` as `0x${string}`);
      const operator = privateKeyToAccount(key).address.toLowerCase();
      const arbiter = config.split.arbiterAddress.toLowerCase();
      if (operator === arbiter) {
        w.push(
          'ARBITER_ADDRESS equals OPERATOR_PRIVATE_KEY: one party both records reads and rules on disputes. Generate a separate arbiter and run `npm run payouts:set-arbiter`.',
        );
      }
    } catch {
      w.push('OPERATOR_PRIVATE_KEY is invalid: cannot verify operator/arbiter separation.');
    }
  }
  return w;
}
