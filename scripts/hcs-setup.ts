/**
 * hcs:setup — create the SourceMark receipt-digest topic on Hedera testnet.
 *
 *   npm run hcs:setup
 *
 * Prints HCS_TOPIC_ID for .env / Railway. Idempotent only in the sense that
 * you can create multiple topics; pick one and keep it.
 */

import { config } from '../src/config.js';
import { createHcsTopic, hcsStatus } from '../src/hcs.js';

async function main(): Promise<void> {
  const status = hcsStatus();
  if (!config.hcs.operatorId || !config.hcs.operatorKey) {
    console.error('Missing HCS operator. Set HCS_OPERATOR_ID + HCS_OPERATOR_KEY');
    console.error('(or X402_PAY_TO + OPERATOR_PRIVATE_KEY).');
    process.exit(1);
  }

  if (status.topicId) {
    console.log(`HCS_TOPIC_ID is already set to ${status.topicId}`);
    console.log(`Explorer: ${status.explorer}`);
    console.log('Creating an additional topic anyway — paste the new id if you want to switch.');
  }

  console.log(`Creating HCS topic as ${config.hcs.operatorId} on ${config.hcs.network}…`);
  const created = await createHcsTopic('SourceMark receipt digests');
  console.log('');
  console.log(`topic          ${created.topicId}`);
  console.log(`create tx      ${created.transactionId}`);
  console.log(`explorer       ${created.explorer}`);
  console.log('');
  console.log('Add to .env and Railway:');
  console.log(`HCS_TOPIC_ID=${created.topicId}`);
  console.log('HCS_ENABLED=true');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
