/**
 * One-shot CLI buyer.
 *
 *   npm run pay -- --metric supplyAPY --asset USDC
 *   npm run pay -- --strict-age 1            # force the refusal path
 *   npm run pay -- --url http://localhost:8787/v1/reads/aave-v3-ethereum?metric=tvlUSD
 */

import { payAndRead } from '../src/buyer.js';
import { config } from '../src/config.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
}

const base = arg('base', `http://localhost:${config.port}`) as string;
const family = arg('family', 'aave-v3-ethereum') as string;

let url = arg('url');
if (!url) {
  const u = new URL(`/v1/reads/${family}`, base);
  u.searchParams.set('metric', arg('metric', 'supplyAPY') as string);
  const asset = arg('asset', 'USDC');
  if (asset) u.searchParams.set('asset', asset);
  const strictLag = arg('strict-lag');
  if (strictLag !== undefined) u.searchParams.set('strictLag', strictLag);
  const strictAge = arg('strict-age');
  if (strictAge !== undefined) u.searchParams.set('strictAge', strictAge);
  url = u.toString();
}

console.log(`\n→ ${url}\n`);

const result = await payAndRead(url);

for (const step of result.trace) {
  console.log(`${step.ok ? '✓' : '✗'} ${step.step.padEnd(10)} ${step.detail}`);
}

console.log(`\nHTTP ${result.status}`);
console.log(JSON.stringify(result.body ?? result.challenge, null, 2));

if (result.receiptHeader) {
  console.log('\nreceipt (X-Payment-Receipt, decoded):');
  console.log(Buffer.from(result.receiptHeader, 'base64').toString('utf8'));
}

process.exitCode = result.ok || result.status === 409 ? 0 : 1;
