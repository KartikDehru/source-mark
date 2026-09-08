/**
 * Read SourcePayouts state straight off Hedera and check it adds up.
 *
 *   npm run payouts:status
 *
 * The important line is the solvency check at the bottom. Every tinybar the
 * contract holds should be claimed by exactly one of: the operator's routing
 * fee, a source's cleared balance, or a source's uncleared holdback. If those
 * do not sum to the on-chain balance, the accounting is wrong and nothing else
 * printed here can be trusted.
 */

import 'dotenv/config';
import { createPublicClient, http, keccak256, toBytes, defineChain, getAddress, formatUnits } from 'viem';
import { readFileSync } from 'node:fs';

const RPC = process.env.HEDERA_JSON_RPC ?? 'https://testnet.hashio.io/api';
const ADDRESS = process.env.SOURCE_PAYOUTS_ADDRESS;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const ABI = [
  { type: 'function', name: 'operatorBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'operator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'arbiter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'recorder', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'routingFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'holdbackBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  {
    type: 'function',
    name: 'withdrawable',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'unclearedHoldback',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'unvestedHoldback',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claimable',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'openDisputeCount',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint32' }],
  },
] as const;

const hederaTestnet = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/**
 * Hedera reports two different units and mixing them up makes the accounting
 * look broken when it is fine. Inside the contract every stored amount is in
 * TINYBAR, because the JSON-RPC relay divides a transaction's weibar value by
 * 1e10 before the EVM sees it as msg.value. eth_getBalance, meanwhile, answers
 * in WEIBAR. Verified by scripts/claim-demo.ts: a source owed 72000 tinybar
 * received exactly 0.00072 HBAR.
 */
const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/** Contract-stored amounts, which are tinybar. */
function hbar(tinybar: bigint): string {
  return `${formatUnits(tinybar, 8)} ℏ`;
}

interface Source {
  protocol: string;
  id: string;
  payoutAddress: string;
  consent: string;
}

async function main(): Promise<void> {
  if (!ADDRESS) {
    console.error('SOURCE_PAYOUTS_ADDRESS is unset. Deploy first: npm run payouts:deploy');
    process.exitCode = 1;
    return;
  }

  const client = createPublicClient({ chain: hederaTestnet, transport: http(RPC) });
  const address = getAddress(ADDRESS);
  const read = <N extends (typeof ABI)[number]['name']>(functionName: N, args?: readonly unknown[]) =>
    client.readContract({ address, abi: ABI, functionName, ...(args ? { args } : {}) } as never);

  const code = await client.getCode({ address });
  if (!code || code === '0x') {
    console.error(`No contract at ${address} on chain 296.`);
    process.exitCode = 1;
    return;
  }

  const [balanceWeibar, operatorBalance, operator, arbiter, recorder, feeBps, holdBps] = await Promise.all([
    client.getBalance({ address }),
    read('operatorBalance') as Promise<bigint>,
    read('operator') as Promise<string>,
    read('arbiter') as Promise<string>,
    read('recorder') as Promise<string>,
    read('routingFeeBps') as Promise<number>,
    read('holdbackBps') as Promise<number>,
  ]);

  console.log(`\n${BOLD}SourcePayouts${RESET} ${address}`);
  console.log(`${DIM}https://hashscan.io/testnet/contract/${address}${RESET}`);
  console.log(`${DIM}fee ${feeBps}bps · holdback ${holdBps}bps${RESET}`);
  console.log(`${DIM}operator ${operator}${RESET}`);
  console.log(`${DIM}recorder ${recorder}${recorder === operator ? ' (same as operator)' : ''}${RESET}`);
  console.log(
    `${DIM}arbiter  ${arbiter}${RESET}` +
      (arbiter.toLowerCase() === operator.toLowerCase()
        ? ` ${YELLOW}← same as operator; one party takes the fee and rules on disputes${RESET}`
        : ''),
  );
  // Normalise to tinybar so the comparison below is apples to apples.
  const balance = balanceWeibar / WEIBAR_PER_TINYBAR;

  console.log(`\n${BOLD}balance${RESET} ${hbar(balance)}`);
  console.log(`  operator fee        ${hbar(operatorBalance)}`);

  const registry = JSON.parse(readFileSync('registry/families.json', 'utf8')) as {
    families: Record<string, { sources: Source[] }>;
  };
  const byDeployment = new Map<string, Source>();
  for (const spec of Object.values(registry.families)) {
    for (const s of spec.sources) if (!byDeployment.has(s.id)) byDeployment.set(s.id, s);
  }

  let clearedTotal = 0n;
  let heldTotal = 0n;

  console.log(`\n${BOLD}sources${RESET}`);
  for (const [id, s] of byDeployment) {
    const sourceId = keccak256(toBytes(id));
    const [cleared, uncleared, unvested, claimable, disputes] = await Promise.all([
      read('withdrawable', [sourceId]) as Promise<bigint>,
      read('unclearedHoldback', [sourceId]) as Promise<bigint>,
      read('unvestedHoldback', [sourceId]) as Promise<bigint>,
      read('claimable', [sourceId]) as Promise<bigint>,
      read('openDisputeCount', [sourceId]) as Promise<number>,
    ]);

    clearedTotal += cleared;
    heldTotal += uncleared;

    const idle = cleared === 0n && uncleared === 0n;
    const frozen = disputes > 0;
    console.log(
      `  ${idle ? DIM : ''}${s.protocol.padEnd(22)}${RESET} ` +
        `cleared ${hbar(cleared).padStart(16)}  holdback ${hbar(uncleared).padStart(16)}` +
        (frozen ? `  ${RED}FROZEN (${disputes} open dispute${disputes > 1 ? 's' : ''})${RESET}` : '') +
        (!frozen && uncleared > unvested ? `  ${DIM}matured, unclaimed${RESET}` : ''),
    );
    if (claimable > 0n && !frozen) {
      console.log(`    ${GREEN}claimable now ${hbar(claimable)}${RESET} ${DIM}by ${s.payoutAddress}${RESET}`);
    }
  }

  const accounted = operatorBalance + clearedTotal + heldTotal;
  console.log(`\n${BOLD}solvency${RESET} ${DIM}(both sides in tinybar)${RESET}`);
  console.log(`  on-chain balance    ${hbar(balance)}`);
  console.log(`  accounted for       ${hbar(accounted)}`);

  if (accounted === balance) {
    console.log(`  ${GREEN}${BOLD}balanced${RESET} — every tinybar is attributed to the fee, a source, or a holdback\n`);
  } else {
    const delta = balance - accounted;
    console.log(
      `  ${RED}${BOLD}UNBALANCED by ${hbar(delta > 0n ? delta : -delta)}${RESET} ` +
        `${DIM}(${delta > 0n ? 'unattributed funds in the contract' : 'contract owes more than it holds'})${RESET}\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
