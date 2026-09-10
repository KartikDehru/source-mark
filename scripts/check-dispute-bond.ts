/**
 * Prove openDispute works against the configured SourcePayouts (tinybar bond).
 * Uses ensureReceiptOnchain + executeOnchainDispute from the live client.
 */
import 'dotenv/config';
import { ensureReceiptOnchain, executeOnchainDispute, resolveOnchainAfterDeadline } from '../src/split-onchain.js';
import { keccak256, toBytes } from 'viem';

const digest = keccak256(toBytes(`dispute-bond-check-${Date.now()}`));
const deploymentIds = [
  'QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd',
  'QmRjc5Dawv9vbxUZsNKakHcYV728P2NLFSBpk4MDHZpPCm',
];

console.log('digest', digest);
console.log('contract', process.env.SOURCE_PAYOUTS_ADDRESS);

const recorded = await ensureReceiptOnchain({
  digest,
  grossTinybar: process.env.X402_PRICE || '100000',
  deploymentIds,
});
console.log('record', recorded);

const opened = await executeOnchainDispute({
  digest,
  reason: 'bond unit check — prefer deadline',
  upheld: true,
  preferDeadline: true,
});
console.log('openDispute', JSON.stringify(opened, null, 2));

if (!opened?.ok) {
  process.exit(1);
}

if (opened.deadlineAt) {
  const waitSec = Math.max(0, opened.deadlineAt - Math.floor(Date.now() / 1000)) + 3;
  console.log(`waiting ${waitSec}s for resolveAfterDeadline…`);
  await new Promise((r) => setTimeout(r, waitSec * 1000));
  const resolved = await resolveOnchainAfterDeadline(digest);
  console.log('resolveAfterDeadline', JSON.stringify(resolved, null, 2));
  if (!resolved?.ok) process.exit(1);
}

console.log('OK — open + deadline uphold both succeeded');
