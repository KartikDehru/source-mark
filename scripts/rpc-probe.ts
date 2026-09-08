/**
 * Diagnose what the Hedera JSON-RPC relay is actually saying.
 *
 * viem collapses a non-200 relay response into "an unknown RPC error", which
 * hides whether the problem is rate limiting, a gas cap, or a rejected
 * payload. This prints raw status codes and bodies.
 *
 *   npx tsx scripts/rpc-probe.ts
 */

import 'dotenv/config';

const URLS = [
  process.env.HEDERA_JSON_RPC ?? 'https://testnet.hashio.io/api',
  'https://testnet.hedera.validationcloud.io/v1/0000000000000000000000000000000000000000',
];

async function rpc(url: string, method: string, params: unknown[] = []): Promise<void> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await res.text();
    const short = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    console.log(`  ${method.padEnd(22)} HTTP ${res.status} ${short}`);
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      console.log(`    rate limited${retry ? `, retry-after ${retry}s` : ''}`);
    }
  } catch (err) {
    console.log(`  ${method.padEnd(22)} threw ${err instanceof Error ? err.message : String(err)}`);
  }
}

const target = URLS[0] as string;
console.log(`\nprobing ${target}\n`);

await rpc(target, 'eth_chainId');
await rpc(target, 'eth_gasPrice');
await rpc(target, 'eth_blockNumber');
await rpc(target, 'net_version');

// A trivial deploy payload, to see whether contract creation specifically is
// what the relay objects to.
await rpc(target, 'eth_estimateGas', [
  {
    from: '0x67f23a0e3d14ee62d15633fb8903e13f217c06f9',
    data: '0x6080604052348015600e575f5ffd5b50603e80601a5f395ff3fe60806040525f5ffd',
  },
]);

console.log();
