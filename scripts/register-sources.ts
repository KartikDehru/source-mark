/**
 * Re-register every registry source's payout address on SourcePayouts.
 *
 *   npm run payouts:register
 *
 * Use after rotating DEMO_SOURCE_MNEMONIC / families.json payout addresses.
 * Does not redeploy the contract — only calls registerSource for each
 * distinct deployment id.
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
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const RPC = process.env.HEDERA_JSON_RPC ?? 'https://testnet.hashio.io/api';
const ADDRESS = process.env.SOURCE_PAYOUTS_ADDRESS;
const OPERATOR_KEY = process.env.OPERATOR_PRIVATE_KEY;

const ABI = [
  {
    type: 'function',
    name: 'registerSource',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sourceId', type: 'bytes32' },
      { name: 'payoutAddress', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const hederaTestnet = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

interface Source {
  protocol: string;
  id: string;
  payoutAddress: string;
}

async function main(): Promise<void> {
  if (!ADDRESS || !OPERATOR_KEY) {
    console.error('Need SOURCE_PAYOUTS_ADDRESS and OPERATOR_PRIVATE_KEY');
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync('registry/families.json', 'utf8')) as {
    families: Record<string, { sources: Source[] }>;
  };
  const byDeployment = new Map<string, Source>();
  for (const spec of Object.values(registry.families)) {
    for (const s of spec.sources) if (!byDeployment.has(s.id)) byDeployment.set(s.id, s);
  }

  const account = privateKeyToAccount(
    (OPERATOR_KEY.startsWith('0x') ? OPERATOR_KEY : `0x${OPERATOR_KEY}`) as `0x${string}`,
  );
  const publicClient = createPublicClient({ chain: hederaTestnet, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: hederaTestnet, transport: http(RPC) });
  const address = getAddress(ADDRESS);

  console.log(`Registering ${byDeployment.size} sources on ${address}`);
  for (const [id, s] of byDeployment) {
    const sourceId = keccak256(toBytes(id));
    const hash = await wallet.writeContract({
      address,
      abi: ABI,
      functionName: 'registerSource',
      args: [sourceId, getAddress(s.payoutAddress)],
      chain: hederaTestnet,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✓ ${s.protocol.padEnd(22)} → ${s.payoutAddress}  ${hash}`);
  }
  console.log('Done. Run: npm run consent:demo -- --url=<service>');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
