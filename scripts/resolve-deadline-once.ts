import 'dotenv/config';
import { resolveOnchainAfterDeadline } from '../src/split-onchain.js';

const digest =
  process.argv[2] || '0x308f8f342ce115a94666bcc0c635cd8657cefa7faa3e3bed8aab1ec9d5e42d94';
const resolved = await resolveOnchainAfterDeadline(digest);
console.log(JSON.stringify(resolved, null, 2));
process.exit(resolved?.ok ? 0 : 1);
