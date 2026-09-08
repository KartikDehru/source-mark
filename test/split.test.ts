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
