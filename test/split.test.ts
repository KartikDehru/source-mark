import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSplit } from '../src/split.js';
import { canonicalize, digestOf } from '../src/receipt.js';
import { measureFreshness } from '../src/anchor.js';

const contributors = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    deploymentId: `Qm${i}`,
    protocol: `p${i}`,
    payoutAddress: `0x${i}`,
  }));

test('split conserves value: fee + shares + dust always equals gross', () => {
  for (const gross of ['100000', '1', '7', '999999999', '3']) {
    for (const n of [1, 2, 3, 7]) {
      const s = computeSplit(gross, contributors(n));
      const paid = s.shares.reduce((sum, x) => sum + BigInt(x.amount), 0n);
      assert.equal(
        BigInt(s.routingFee) + paid + BigInt(s.dust),
        BigInt(gross),
        `value leaked for gross=${gross} n=${n}`,
      );
    }
  }
});

test('split never over-distributes, even when gross is smaller than the source count', () => {
  const s = computeSplit('3', contributors(7));
  const paid = s.shares.reduce((sum, x) => sum + BigInt(x.amount), 0n);
  assert.ok(paid <= 3n);
  assert.ok(BigInt(s.dust) >= 0n);
});

test('each share is exactly vested plus heldBack', () => {
  const s = computeSplit('100000', contributors(3));
  for (const share of s.shares) {
    assert.equal(BigInt(share.vested) + BigInt(share.heldBack), BigInt(share.amount));
  }
});

test('canonical JSON is key-order independent, so the digest is stable', () => {
  const a = { b: 1, a: [3, { z: 1, y: 2 }] };
  const b = { a: [3, { y: 2, z: 1 }], b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(digestOf(a), digestOf(b));
});

test('canonical JSON distinguishes materially different answers', () => {
  assert.notEqual(digestOf({ value: 4.31 }), digestOf({ value: 4.32 }));
});

test('verifySignedReceipt recovers the EIP-191 signer over the raw digest', async () => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { verifySignedReceipt } = await import('../src/receipt.js');
  const account = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const body = {
    v: 1 as const,
    family: 'demo',
    request: { metric: 'supplyAPY', asset: 'USDC' },
    answerHash: digestOf({ value: 1 }) as `0x${string}`,
    policy: { maxBlockLag: 50, maxAgeSeconds: 900, minSources: 2 },
    sources: [],
    chainHead: { chainId: 1, block: 1 },
    payment: { network: 'hedera-testnet', amount: '1', asset: 'HBAR', payer: null, transaction: null },
    issuedAt: 1,
  };
  const digest = digestOf(body);
  const signature = await account.signMessage({ message: { raw: digest } });
  const v = await verifySignedReceipt({
    digest,
    signature,
    signer: account.address,
    body,
  });
  assert.equal(v.digestMatches, true);
  assert.equal(v.signatureValid, true);
  assert.equal(v.recoveredSigner?.toLowerCase(), account.address.toLowerCase());
});

test('withBlockConstraint injects historical block variables', async () => {
  const { withBlockConstraint } = await import('../src/graph.js');
  const q =
    'query PMMarkets($first: Int!) { _meta { deployment } markets(first: $first, orderBy: totalValueLockedUSD) { id } }';
  const out = withBlockConstraint(q, 'markets');
  assert.match(out, /\$smBlock: Int!/);
  assert.match(out, /_meta\(block: \{ number: \$smBlock \}\)/);
  assert.match(out, /markets\(block: \{ number: \$smBlock \},/);
});

test('freshness prefers true chain head over the best-indexed peer', () => {
  const f = measureFreshness(100, 1000, 110, 105, 1000);
  assert.equal(f.reference, 'chain-head');
  assert.equal(f.blockLag, 10);
});

test('freshness falls back to best peer and labels itself as weaker', () => {
  const f = measureFreshness(100, 1000, null, 105, 1000);
  assert.equal(f.reference, 'best-peer');
  assert.equal(f.blockLag, 5);
});

test('freshness reports no reference rather than inventing a lag of zero', () => {
  const f = measureFreshness(100, 1000, null, null, 1000);
  assert.equal(f.reference, 'none');
  assert.equal(f.blockLag, null);
});

test('a source ahead of the reference reports zero lag, never negative', () => {
  assert.equal(measureFreshness(120, 1000, 110, null, 1000).blockLag, 0);
});
