import { createWalletClient, createPublicClient, http, keccak256, toBytes, defineChain, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import { log } from './logger.js';
import type { Share } from './split.js';

/**
 * The onchain half of revenue routing.
 *
 * SPLIT_MODE=ledger keeps the split in a local append-only file, which is
 * auditable but only as trustworthy as whoever holds the file. SPLIT_MODE=onchain
 * records each settled read against SourcePayouts, so the split, the holdback,
 * and the liability it funds are all enforced by the contract instead of by us.
 *
 * Two deliberate choices:
 *
 *   - We send the transaction but do not wait for it to be mined. Hedera
 *     confirmation takes several seconds, and making a buyer wait for our
 *     bookkeeping after they already have their answer is the wrong trade. The
 *     hash is returned immediately and confirmation is logged when it lands.
 *
 *   - Sends are serialized. Concurrent reads would otherwise submit several
 *     transactions from one account at the same nonce, and all but one would be
 *     dropped — losing the record of a read that was genuinely paid for.
 */

const hederaTestnet = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: [config.split.jsonRpc] } },
  blockExplorers: { default: { name: 'HashScan', url: 'https://hashscan.io/testnet' } },
});

const RECORD_READ_ABI = [
  {
    type: 'function',
    name: 'recordRead',
    stateMutability: 'payable',
    inputs: [
      { name: 'receiptDigest', type: 'bytes32' },
      { name: 'sourceIds', type: 'bytes32[]' },
      { name: 'buyer', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'payoutAddressOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'operator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'arbiter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'disputeBond',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'disputeResolveSeconds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'disputeOf',
    stateMutability: 'view',
    inputs: [{ name: 'receiptDigest', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'claimant', type: 'address' },
          { name: 'bond', type: 'uint128' },
          { name: 'openedAt', type: 'uint64' },
          { name: 'resolved', type: 'bool' },
          { name: 'upheld', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'receiptOf',
    stateMutability: 'view',
    inputs: [{ name: 'receiptDigest', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'buyer', type: 'address' },
          { name: 'gross', type: 'uint128' },
          { name: 'recordedAt', type: 'uint64' },
          { name: 'disputed', type: 'bool' },
          { name: 'sources', type: 'bytes32[]' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'openDispute',
    stateMutability: 'payable',
    inputs: [
      { name: 'receiptDigest', type: 'bytes32' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'resolveDispute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiptDigest', type: 'bytes32' },
      { name: 'upheld', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'resolveAfterDeadline',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'receiptDigest', type: 'bytes32' }],
    outputs: [],
  },
] as const;

/** Native HBAR has 8 decimals; the EVM sees 18. */
const TINYBAR_TO_WEIBAR = 10_000_000_000n;

export interface OnchainSplit {
  contract: string;
  transaction: string;
  explorer: string;
  sourceIds: string[];
}

export function onchainSplitEnabled(): boolean {
  return config.split.mode === 'onchain' && Boolean(config.split.contractAddress && config.split.recorderKey);
}

/** keccak256 of the pinned deployment id string, matching sourceIdFor(). */
export function sourceIdFor(deploymentId: string): `0x${string}` {
  return keccak256(toBytes(deploymentId));
}

let clients: {
  wallet: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  address: `0x${string}`;
} | null = null;

function getClients() {
  if (clients) return clients;

  const key = config.split.recorderKey.startsWith('0x')
    ? (config.split.recorderKey as `0x${string}`)
    : (`0x${config.split.recorderKey}` as `0x${string}`);

  const account = privateKeyToAccount(key);
  clients = {
    wallet: createWalletClient({ account, chain: hederaTestnet, transport: http(config.split.jsonRpc) }),
    publicClient: createPublicClient({ chain: hederaTestnet, transport: http(config.split.jsonRpc) }),
    address: getAddress(config.split.contractAddress),
  };
  return clients;
}

/**
 * The address that fronted a read nobody paid us in HBAR for.
 *
 * On the resale channel the caller was billed by the reseller in another
 * currency on another chain, so there is no payer account to name — but the
 * contract still needs a buyer, because that is who an upheld dispute refunds.
 * The operator genuinely is that party here: it covered the read out of its own
 * float, so it is the one owed the money back if the data turns out to be wrong.
 */
export function operatorEvmAddress(): `0x${string}` | null {
  if (!onchainSplitEnabled()) return null;
  return getClients().wallet.account?.address ?? null;
}

const MIRROR = 'https://testnet.mirrornode.hedera.com';
const evmCache = new Map<string, string | null>();

/**
 * x402 identifies the payer by Hedera account id (0.0.x), but the contract
 * stores an EVM address so an upheld dispute has somewhere to refund to. The
 * mirror node is the authority on that mapping.
 *
 * Returns null when it cannot be resolved. Callers must not substitute the
 * zero address: a receipt whose buyer is 0x0 would burn the refund it is
 * supposed to pay out.
 */
export async function evmAddressForPayer(payer: string | undefined): Promise<string | null> {
  if (!payer) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(payer)) return getAddress(payer);

  const cached = evmCache.get(payer);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  try {
    const res = await fetch(`${MIRROR}/api/v1/accounts/${encodeURIComponent(payer)}`);
    if (res.ok) {
      const body = (await res.json()) as { evm_address?: string | null };
      if (body.evm_address && /^0x[0-9a-fA-F]{40}$/.test(body.evm_address)) {
        resolved = getAddress(body.evm_address);
      }
    }
  } catch {
    resolved = null;
  }

  evmCache.set(payer, resolved);
  return resolved;
}

// Serializes sends so two concurrent reads cannot collide on one nonce.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Record a settled read onchain. Never throws: the buyer already has a paid,
 * provenance-checked answer, and losing our bookkeeping is not a reason to
 * fail their request. Failures are logged loudly and reported as null.
 */
export async function recordReadOnchain(args: {
  digest: string;
  grossTinybar: string;
  payer: string | undefined;
  shares: Share[];
}): Promise<OnchainSplit | null> {
  if (!onchainSplitEnabled()) return null;

  const sourceIds = args.shares.map((s) => sourceIdFor(s.deploymentId));
  if (sourceIds.length === 0) return null;

  const buyer = await evmAddressForPayer(args.payer);
  if (!buyer) {
    log.error(
      'could not resolve the payer to an EVM address; skipping onchain split rather than recording a receipt that cannot be refunded',
      { payer: args.payer, digest: args.digest },
    );
    return null;
  }

  const run = async (): Promise<OnchainSplit | null> => {
    try {
      const { wallet, publicClient, address } = getClients();
      const value = BigInt(args.grossTinybar) * TINYBAR_TO_WEIBAR;

      // The contract reverts on an unregistered source, which would lose the
      // whole record. Check first and say which one is missing.
      for (const [i, id] of sourceIds.entries()) {
        const payee = await publicClient.readContract({
          address,
          abi: RECORD_READ_ABI,
          functionName: 'payoutAddressOf',
          args: [id],
        });
        if (payee === '0x0000000000000000000000000000000000000000') {
          log.error(
            'source not registered in SourcePayouts; run scripts/deploy-payouts.ts to register it. Skipping onchain split for this read.',
            { deploymentId: args.shares[i]?.deploymentId, sourceId: id },
          );
          return null;
        }
      }

      const hash = await wallet.writeContract({
        address,
        abi: RECORD_READ_ABI,
        functionName: 'recordRead',
        args: [args.digest as `0x${string}`, sourceIds, getAddress(buyer)],
        value,
        chain: hederaTestnet,
        account: wallet.account!,
      });

      // Confirm in the background so the read can return now.
      void publicClient
        .waitForTransactionReceipt({ hash })
        .then((rcpt) => {
          if (rcpt.status === 'success') {
            log.info('onchain split confirmed', { hash, digest: args.digest, sources: sourceIds.length });
          } else {
            log.error('onchain split REVERTED; this read is not recorded onchain', { hash, digest: args.digest });
          }
        })
        .catch((err) => {
          log.error('could not confirm onchain split', { hash, err: String(err) });
        });

      return {
        contract: address,
        transaction: hash,
        explorer: `https://hashscan.io/testnet/transaction/${hash}`,
        sourceIds,
      };
    } catch (err) {
      log.error('onchain split failed; read still answered and paid', { err: String(err), digest: args.digest });
      return null;
    }
  };

  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export interface OnchainDisputeResult {
  ok: boolean;
  detail: string;
  openTx?: string;
  resolveTx?: string;
  openExplorer?: string;
  resolveExplorer?: string;
  upheld: boolean;
  /** Unix seconds when resolveAfterDeadline becomes callable (if still open). */
  deadlineAt?: number;
  resolveMode?: 'arbiter' | 'deadline' | 'open-only';
}

function arbiterWallet() {
  if (!config.split.arbiterKey) return null;
  const key = config.split.arbiterKey.startsWith('0x')
    ? (config.split.arbiterKey as `0x${string}`)
    : (`0x${config.split.arbiterKey}` as `0x${string}`);
  const account = privateKeyToAccount(key);
  return createWalletClient({ account, chain: hederaTestnet, transport: http(config.split.jsonRpc) });
}

/**
 * After a Graph re-derive MISMATCH (or MATCH→reject), drive the onchain dispute
 * path: anyone opens with the dispute bond; the arbiter may resolve early from
 * evidence. If the arbiter is silent past disputeResolveSeconds, anyone may
 * call resolveAfterDeadline (permissionless uphold).
 *
 * Non-fatal: ledger dispute already recorded; missing keys or an unrecorded
 * digest just skips the chain leg and reports why.
 *
 * Pass `preferDeadline: true` to open without an arbiter resolve — useful for
 * demonstrating the silence→uphold path (default resolve window is short on
 * testnet).
 */
export async function executeOnchainDispute(args: {
  digest: string;
  reason: string;
  upheld: boolean;
  preferDeadline?: boolean;
}): Promise<OnchainDisputeResult | null> {
  if (!onchainSplitEnabled()) return null;

  const run = async (): Promise<OnchainDisputeResult> => {
    try {
      const { wallet, publicClient, address } = getClients();
      const digest = args.digest as `0x${string}`;
      const recorded = await publicClient.readContract({
        address,
        abi: RECORD_READ_ABI,
        functionName: 'receiptOf',
        args: [digest],
      });
      if (!recorded.recordedAt) {
        return {
          ok: false,
          upheld: args.upheld,
          detail: 'Digest is not onchain (no recordRead). Ledger dispute only.',
        };
      }
      if (recorded.disputed) {
        return {
          ok: false,
          upheld: args.upheld,
          detail: 'Receipt already disputed onchain',
        };
      }

      const [bond, resolveSeconds] = await Promise.all([
        publicClient.readContract({
          address,
          abi: RECORD_READ_ABI,
          functionName: 'disputeBond',
        }),
        publicClient.readContract({
          address,
          abi: RECORD_READ_ABI,
          functionName: 'disputeResolveSeconds',
        }),
      ]);

      const openHash = await wallet.writeContract({
        address,
        abi: RECORD_READ_ABI,
        functionName: 'openDispute',
        args: [digest, args.reason.slice(0, 200)],
        value: bond,
        chain: hederaTestnet,
        account: wallet.account!,
      });
      const openRcpt = await publicClient.waitForTransactionReceipt({ hash: openHash });
      if (openRcpt.status !== 'success') {
        return {
          ok: false,
          upheld: args.upheld,
          openTx: openHash,
          openExplorer: `https://hashscan.io/testnet/transaction/${openHash}`,
          detail: 'openDispute reverted',
        };
      }

      const dispute = await publicClient.readContract({
        address,
        abi: RECORD_READ_ABI,
        functionName: 'disputeOf',
        args: [digest],
      });
      const deadlineAt = Number(dispute.openedAt) + Number(resolveSeconds);

      // Silence path: leave open so anyone can resolveAfterDeadline later.
      // Also used when rejecting MATCH would need arbiter — MATCH path still
      // needs arbiter to reject (deadline only upholds).
      if (args.preferDeadline && args.upheld) {
        return {
          ok: true,
          upheld: true,
          openTx: openHash,
          openExplorer: `https://hashscan.io/testnet/transaction/${openHash}`,
          deadlineAt,
          resolveMode: 'open-only',
          detail:
            `Opened onchain; arbiter silent by design. After ${new Date(deadlineAt * 1000).toISOString()} ` +
            'anyone may call resolveAfterDeadline to uphold and refund the buyer.',
        };
      }

      const arbiter = arbiterWallet();
      if (!arbiter) {
        return {
          ok: Boolean(args.upheld),
          upheld: args.upheld,
          openTx: openHash,
          openExplorer: `https://hashscan.io/testnet/transaction/${openHash}`,
          deadlineAt,
          resolveMode: 'open-only',
          detail: args.upheld
            ? `Opened onchain; no ARBITER_PRIVATE_KEY. After deadline (${deadlineAt}) anyone may resolveAfterDeadline.`
            : 'Opened onchain but MATCH→reject needs an arbiter before the deadline (silence would wrongly uphold).',
        };
      }

      const resolveHash = await arbiter.writeContract({
        address,
        abi: RECORD_READ_ABI,
        functionName: 'resolveDispute',
        args: [digest, args.upheld],
        chain: hederaTestnet,
        account: arbiter.account!,
      });
      const resolveRcpt = await publicClient.waitForTransactionReceipt({ hash: resolveHash });
      if (resolveRcpt.status !== 'success') {
        return {
          ok: false,
          upheld: args.upheld,
          openTx: openHash,
          resolveTx: resolveHash,
          openExplorer: `https://hashscan.io/testnet/transaction/${openHash}`,
          resolveExplorer: `https://hashscan.io/testnet/transaction/${resolveHash}`,
          deadlineAt,
          detail: 'resolveDispute reverted',
        };
      }

      log.info('onchain dispute resolved from reproduce', {
        digest: args.digest,
        upheld: args.upheld,
        openHash,
        resolveHash,
      });

      return {
        ok: true,
        upheld: args.upheld,
        openTx: openHash,
        resolveTx: resolveHash,
        openExplorer: `https://hashscan.io/testnet/transaction/${openHash}`,
        resolveExplorer: `https://hashscan.io/testnet/transaction/${resolveHash}`,
        deadlineAt,
        resolveMode: 'arbiter',
        detail: args.upheld
          ? 'Opened + arbiter upheld onchain after Graph re-derive MISMATCH (deadline backstop unused)'
          : 'Opened + arbiter rejected onchain after Graph re-derive MATCH',
      };
    } catch (err) {
      log.error('onchain dispute failed', { err: String(err), digest: args.digest });
      return {
        ok: false,
        upheld: args.upheld,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Permissionless uphold after disputeResolveSeconds of arbiter silence.
 */
export async function resolveOnchainAfterDeadline(digest: string): Promise<OnchainDisputeResult | null> {
  if (!onchainSplitEnabled()) return null;

  const run = async (): Promise<OnchainDisputeResult> => {
    try {
      const { wallet, publicClient, address } = getClients();
      const dig = digest as `0x${string}`;
      const [dispute, resolveSeconds] = await Promise.all([
        publicClient.readContract({
          address,
          abi: RECORD_READ_ABI,
          functionName: 'disputeOf',
          args: [dig],
        }),
        publicClient.readContract({
          address,
          abi: RECORD_READ_ABI,
          functionName: 'disputeResolveSeconds',
        }),
      ]);
      if (!dispute.openedAt) {
        return { ok: false, upheld: true, detail: 'No open dispute for this digest' };
      }
      if (dispute.resolved) {
        return {
          ok: false,
          upheld: dispute.upheld,
          detail: 'Dispute already resolved',
          resolveMode: 'deadline',
        };
      }
      const deadlineAt = Number(dispute.openedAt) + Number(resolveSeconds);
      const now = Math.floor(Date.now() / 1000);
      if (now < deadlineAt) {
        return {
          ok: false,
          upheld: true,
          deadlineAt,
          resolveMode: 'open-only',
          detail: `Too early: resolveAfterDeadline opens at ${new Date(deadlineAt * 1000).toISOString()} (${deadlineAt - now}s left)`,
        };
      }

      const hash = await wallet.writeContract({
        address,
        abi: RECORD_READ_ABI,
        functionName: 'resolveAfterDeadline',
        args: [dig],
        chain: hederaTestnet,
        account: wallet.account!,
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== 'success') {
        return {
          ok: false,
          upheld: true,
          resolveTx: hash,
          resolveExplorer: `https://hashscan.io/testnet/transaction/${hash}`,
          deadlineAt,
          resolveMode: 'deadline',
          detail: 'resolveAfterDeadline reverted',
        };
      }
      return {
        ok: true,
        upheld: true,
        resolveTx: hash,
        resolveExplorer: `https://hashscan.io/testnet/transaction/${hash}`,
        deadlineAt,
        resolveMode: 'deadline',
        detail: 'Permissionless resolveAfterDeadline upheld — buyer refunded from unvested holdback',
      };
    } catch (err) {
      log.error('resolveAfterDeadline failed', { err: String(err), digest });
      return {
        ok: false,
        upheld: true,
        detail: err instanceof Error ? err.message : String(err),
        resolveMode: 'deadline',
      };
    }
  };

  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Ensure a digest exists onchain so openDispute can run (used by the falsified
 * twin demo). Pays grossTinybar from the operator and waits for confirmation.
 */
export async function ensureReceiptOnchain(args: {
  digest: string;
  grossTinybar: string;
  deploymentIds: string[];
  buyer?: string;
}): Promise<OnchainSplit | null> {
  if (!onchainSplitEnabled()) return null;
  if (args.deploymentIds.length === 0) return null;

  const run = async (): Promise<OnchainSplit | null> => {
    try {
      const { wallet, publicClient, address } = getClients();
      const digest = args.digest as `0x${string}`;
      const existing = await publicClient.readContract({
        address,
        abi: RECORD_READ_ABI,
        functionName: 'receiptOf',
        args: [digest],
      });
      if (existing.recordedAt) {
        return {
          contract: address,
          transaction: 'already-recorded',
          explorer: `https://hashscan.io/testnet/contract/${address}`,
          sourceIds: args.deploymentIds.map(sourceIdFor),
        };
      }

      const buyer =
        (args.buyer && /^0x[0-9a-fA-F]{40}$/.test(args.buyer) ? getAddress(args.buyer) : null) ??
        operatorEvmAddress();
      if (!buyer) return null;

      const sourceIds = args.deploymentIds.map(sourceIdFor);
      const value = BigInt(args.grossTinybar) * TINYBAR_TO_WEIBAR;
      const hash = await wallet.writeContract({
        address,
        abi: RECORD_READ_ABI,
        functionName: 'recordRead',
        args: [digest, sourceIds, buyer],
        value,
        chain: hederaTestnet,
        account: wallet.account!,
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== 'success') {
        log.error('ensureReceiptOnchain reverted', { hash, digest: args.digest });
        return null;
      }
      return {
        contract: address,
        transaction: hash,
        explorer: `https://hashscan.io/testnet/transaction/${hash}`,
        sourceIds,
      };
    } catch (err) {
      log.error('ensureReceiptOnchain failed', { err: String(err), digest: args.digest });
      return null;
    }
  };

  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Startup validation, so a misconfigured onchain mode is visible immediately. */
export async function checkOnchainSplit(): Promise<string[]> {
  if (config.split.mode !== 'onchain') return [];

  const problems: string[] = [];
  if (!config.split.contractAddress) {
    problems.push('SPLIT_MODE=onchain but SOURCE_PAYOUTS_ADDRESS is unset. Deploy with scripts/deploy-payouts.ts.');
  }
  if (!config.split.recorderKey) {
    problems.push('SPLIT_MODE=onchain but OPERATOR_PRIVATE_KEY is unset; the gateway cannot sign recordRead().');
  }
  if (problems.length > 0) return problems;

  try {
    const { publicClient, address } = getClients();
    const code = await publicClient.getCode({ address });
    if (!code || code === '0x') {
      problems.push(`No contract at SOURCE_PAYOUTS_ADDRESS ${address} on chain 296.`);
      return problems;
    }
    const [operator, arbiter] = await Promise.all([
      publicClient.readContract({ address, abi: RECORD_READ_ABI, functionName: 'operator' }),
      publicClient.readContract({ address, abi: RECORD_READ_ABI, functionName: 'arbiter' }),
    ]);
    if (operator.toLowerCase() === arbiter.toLowerCase()) {
      problems.push(
        `Onchain arbiter (${arbiter}) is still the operator. Set ARBITER_ADDRESS to a distinct key and run npm run payouts:set-arbiter.`,
      );
    } else if (
      config.split.arbiterAddress &&
      getAddress(config.split.arbiterAddress).toLowerCase() !== arbiter.toLowerCase()
    ) {
      problems.push(
        `ARBITER_ADDRESS (${config.split.arbiterAddress}) does not match onchain arbiter (${arbiter}). Run npm run payouts:set-arbiter.`,
      );
    }
  } catch (err) {
    problems.push(`Could not reach ${config.split.jsonRpc}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return problems;
}
