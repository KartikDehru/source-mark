/**
 * Rotate the SourcePayouts arbiter away from the operator.
 *
 *   npx tsx scripts/set-arbiter.ts
 *
 * Requires OPERATOR_PRIVATE_KEY (signs setArbiter) and ARBITER_ADDRESS (the
 * new arbiter). Optionally ARBITER_PRIVATE_KEY so the script can prove the
 * address is one you control before submitting.
 */

import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.HEDERA_JSON_RPC ?? 'https://testnet.hashio.io/api';
const ADDRESS = process.env.SOURCE_PAYOUTS_ADDRESS;
const OPERATOR_KEY = process.env.OPERATOR_PRIVATE_KEY;
const ARBITER = process.env.ARBITER_ADDRESS;
const ARBITER_KEY = process.env.ARBITER_PRIVATE_KEY;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const ABI = [
  { type: 'function', name: 'operator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'arbiter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'setArbiter',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'next', type: 'address' }],
    outputs: [],
  },
] as const;

const hederaTestnet = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

function asKey(raw: string): `0x${string}` {
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
}

async function main(): Promise<void> {
  if (!ADDRESS || !OPERATOR_KEY || !ARBITER) {
    console.error(
      `${RED}Need SOURCE_PAYOUTS_ADDRESS, OPERATOR_PRIVATE_KEY, and ARBITER_ADDRESS in .env${RESET}`,
    );
    process.exitCode = 1;
    return;
  }

  const operatorAccount = privateKeyToAccount(asKey(OPERATOR_KEY));
  const nextArbiter = getAddress(ARBITER);

  if (ARBITER_KEY) {
    const derived = privateKeyToAccount(asKey(ARBITER_KEY)).address;
    if (derived.toLowerCase() !== nextArbiter.toLowerCase()) {
      console.error(
        `${RED}ARBITER_PRIVATE_KEY derives ${derived}, which does not match ARBITER_ADDRESS ${nextArbiter}${RESET}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (nextArbiter.toLowerCase() === operatorAccount.address.toLowerCase()) {
    console.error(`${RED}ARBITER_ADDRESS is the operator — that is the situation we are trying to leave.${RESET}`);
    process.exitCode = 1;
    return;
  }

  const publicClient = createPublicClient({ chain: hederaTestnet, transport: http(RPC) });
  const wallet = createWalletClient({
    account: operatorAccount,
    chain: hederaTestnet,
    transport: http(RPC),
  });
  const address = getAddress(ADDRESS);

  const [operator, current] = await Promise.all([
    publicClient.readContract({ address, abi: ABI, functionName: 'operator' }),
    publicClient.readContract({ address, abi: ABI, functionName: 'arbiter' }),
  ]);

  console.log(`\n${BOLD}SourcePayouts arbiter rotation${RESET}`);
  console.log(`${DIM}${address}${RESET}`);
  console.log(`${DIM}operator ${operator}${RESET}`);
  console.log(`${DIM}current  ${current}${RESET}`);
  console.log(`${DIM}next     ${nextArbiter}${RESET}`);

  if (current.toLowerCase() === nextArbiter.toLowerCase()) {
    console.log(`\n${GREEN}already set — nothing to do${RESET}\n`);
    return;
  }

  if (operator.toLowerCase() !== operatorAccount.address.toLowerCase()) {
    console.error(
      `${RED}OPERATOR_PRIVATE_KEY is ${operatorAccount.address}, but the contract operator is ${operator}${RESET}`,
    );
    process.exitCode = 1;
    return;
  }

  const hash = await wallet.writeContract({
    address,
    abi: ABI,
    functionName: 'setArbiter',
    args: [nextArbiter],
    chain: hederaTestnet,
    account: operatorAccount,
  });

  console.log(`\n${YELLOW}submitted${RESET} ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error(`${RED}transaction reverted${RESET}`);
    process.exitCode = 1;
    return;
  }

  const after = await publicClient.readContract({ address, abi: ABI, functionName: 'arbiter' });
  console.log(`${GREEN}arbiter is now ${after}${RESET}`);
  console.log(`${DIM}https://hashscan.io/testnet/transaction/${hash}${RESET}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
