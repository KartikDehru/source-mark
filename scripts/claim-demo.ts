/**
 * Prove a source can actually withdraw what it earned.
 *
 *   npx tsx scripts/claim-demo.ts
 *
 * Recording a split is only half the claim. This runs the other half against
 * Hedera testnet: fund a payee so it can pay gas, call claim() as that payee,
 * and check the HBAR that lands matches what the contract said was owed.
 *
 * It also pins down a Hedera unit question that is easy to get wrong. Inside
 * the contract msg.value arrives in TINYBAR (the JSON-RPC relay divides the
 * transaction's weibar value by 1e10), while eth_getBalance reports WEIBAR.
 * If an outgoing call{value:} were interpreted as weibar, every payout would
 * be 1e10 times too small. Comparing owed-vs-received here is what makes that
 * answer observable instead of assumed.
 *
 * The payee keys come from DEMO_SOURCE_MNEMONIC (dedicated demo source
 * operators — not the public Hardhat mnemonic, and not the gateway operator).
 * See registry/families.json. Anyone with that mnemonic can run this.
 */

import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  defineChain,
  getAddress,
  formatEther,
  parseEther,
} from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';

const RPC = process.env.HEDERA_JSON_RPC ?? 'https://testnet.hashio.io/api';
const ADDRESS = process.env.SOURCE_PAYOUTS_ADDRESS;
const OPERATOR_KEY = process.env.OPERATOR_PRIVATE_KEY;
const MNEMONIC = process.env.DEMO_SOURCE_MNEMONIC;

// The deployment whose payee is addressIndex 0.
const DEPLOYMENT = 'QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd';
const PAYEE_INDEX = 0;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const ABI = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }], outputs: [] },
  {
    type: 'function',
    name: 'claimable',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawable',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'payoutAddressOf',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const;

const hederaTestnet = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const TINYBAR_TO_WEIBAR = 10_000_000_000n;

async function main(): Promise<void> {
  if (!ADDRESS || !OPERATOR_KEY) {
    console.error('Need SOURCE_PAYOUTS_ADDRESS and OPERATOR_PRIVATE_KEY in .env');
    process.exitCode = 1;
    return;
  }
  if (!MNEMONIC) {
    console.error('Need DEMO_SOURCE_MNEMONIC in .env (dedicated demo source keys)');
    process.exitCode = 1;
    return;
  }

  const address = getAddress(ADDRESS);
  const publicClient = createPublicClient({ chain: hederaTestnet, transport: http(RPC) });
  const sourceId = keccak256(toBytes(DEPLOYMENT));

  const payee = mnemonicToAccount(MNEMONIC, { addressIndex: PAYEE_INDEX });
  const operatorAccount = privateKeyToAccount(
    (OPERATOR_KEY.startsWith('0x') ? OPERATOR_KEY : `0x${OPERATOR_KEY}`) as `0x${string}`,
  );

  if (payee.address.toLowerCase() === operatorAccount.address.toLowerCase()) {
    console.error('Demo payee must not be the operator — rotate DEMO_SOURCE_MNEMONIC.');
    process.exitCode = 1;
    return;
  }
  const registered = (await publicClient.readContract({
    address,
    abi: ABI,
    functionName: 'payoutAddressOf',
    args: [sourceId],
  })) as string;

  console.log(`\n${BOLD}Claim as a source${RESET}`);
  console.log(`${DIM}contract ${address}${RESET}`);
  console.log(`${DIM}source   ${DEPLOYMENT.slice(0, 18)}… (${sourceId.slice(0, 14)}…)${RESET}`);
  console.log(`${DIM}payee    ${payee.address}${RESET}`);

  if (getAddress(registered) !== getAddress(payee.address)) {
    console.error(`\n${RED}Registered payee is ${registered}, not ${payee.address}.${RESET}`);
    process.exitCode = 1;
    return;
  }

  const owedTinybar = (await publicClient.readContract({
    address,
    abi: ABI,
    functionName: 'claimable',
    args: [sourceId],
  })) as bigint;

  console.log(`\n${BOLD}owed${RESET} ${owedTinybar} tinybar ${DIM}(contract storage is tinybar-denominated)${RESET}`);
  if (owedTinybar === 0n) {
    console.log(`${YELLOW}Nothing to claim. Run a paid read first: npm run pay${RESET}\n`);
    return;
  }

  // The payee is a bare EVM address with no HBAR, so it cannot pay gas yet.
  // Funding it also lazily creates the Hedera account.
  const operator = createWalletClient({
    account: privateKeyToAccount(
      (OPERATOR_KEY.startsWith('0x') ? OPERATOR_KEY : `0x${OPERATOR_KEY}`) as `0x${string}`,
    ),
    chain: hederaTestnet,
    transport: http(RPC),
  });

  const payeeBefore = await publicClient.getBalance({ address: payee.address });
  console.log(`${DIM}payee balance before funding ${formatEther(payeeBefore)} HBAR${RESET}`);

  const GAS_FUND = parseEther('2');
  if (payeeBefore < GAS_FUND) {
    console.log(`${DIM}funding payee with ${formatEther(GAS_FUND)} HBAR for gas…${RESET}`);
    const fundHash = await operator.sendTransaction({
      to: payee.address,
      value: GAS_FUND,
      chain: hederaTestnet,
      account: operator.account!,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    console.log(`  ${GREEN}✓${RESET} funded ${DIM}${fundHash}${RESET}`);
  }

  const beforeClaim = await publicClient.getBalance({ address: payee.address });

  const payeeWallet = createWalletClient({ account: payee, chain: hederaTestnet, transport: http(RPC) });
  console.log(`\n${DIM}claiming…${RESET}`);
  const hash = await payeeWallet.writeContract({
    address,
    abi: ABI,
    functionName: 'claim',
    args: [sourceId],
    chain: hederaTestnet,
    account: payee,
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });

  if (rcpt.status !== 'success') {
    console.error(`\n${RED}claim reverted${RESET} ${DIM}${hash}${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  const afterClaim = await publicClient.getBalance({ address: payee.address });
  const gasSpent = rcpt.gasUsed * rcpt.effectiveGasPrice;
  const receivedWeibar = afterClaim - beforeClaim + gasSpent;

  console.log(`  ${GREEN}✓${RESET} claimed ${DIM}${hash}${RESET}`);
  console.log(`${DIM}  https://hashscan.io/testnet/transaction/${hash}${RESET}`);

  console.log(`\n${BOLD}did the payee receive what it was owed?${RESET}`);
  console.log(`  owed                ${owedTinybar} tinybar ${DIM}= ${formatEther(owedTinybar * TINYBAR_TO_WEIBAR)} HBAR${RESET}`);
  console.log(`  received (net gas)  ${receivedWeibar} weibar ${DIM}= ${formatEther(receivedWeibar)} HBAR${RESET}`);

  const expectedWeibar = owedTinybar * TINYBAR_TO_WEIBAR;
  if (receivedWeibar === expectedWeibar) {
    console.log(
      `\n${GREEN}${BOLD}exact match.${RESET} A tinybar-denominated storage value paid out as the same amount of` +
        ` real HBAR, so call{value:} and msg.value use the same unit.\n`,
    );
  } else {
    const ratio = expectedWeibar === 0n ? 0n : receivedWeibar / expectedWeibar;
    console.log(
      `\n${RED}${BOLD}MISMATCH${RESET} — received/expected ratio ${ratio}. ` +
        `A unit mismatch between msg.value and call{value:} would underpay every source.\n`,
    );
    process.exitCode = 1;
  }

  const remaining = (await publicClient.readContract({
    address,
    abi: ABI,
    functionName: 'withdrawable',
    args: [sourceId],
  })) as bigint;
  console.log(`${DIM}withdrawable now ${remaining} tinybar (holdback stays until it vests)${RESET}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
