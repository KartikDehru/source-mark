import 'dotenv/config';
import { ensureReceiptOnchain, executeOnchainDispute } from '../src/split-onchain.js';
import { keccak256, toBytes } from 'viem';

const digest = keccak256(toBytes(`arbiter-dispute-check-${Date.now()}`));
const deploymentIds = [
  'QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd',
  'QmRjc5Dawv9vbxUZsNKakHcYV728P2NLFSBpk4MDHZpPCm',
];

console.log('digest', digest);
const recorded = await ensureReceiptOnchain({
  digest,
  grossTinybar: process.env.X402_PRICE || '100000',
  deploymentIds,
});
console.log('record', recorded?.transaction);

const result = await executeOnchainDispute({
  digest,
  reason: 'bond unit check — arbiter uphold',
  upheld: true,
  preferDeadline: false,
});
console.log(JSON.stringify(result, null, 2));
process.exit(result?.ok ? 0 : 1);
