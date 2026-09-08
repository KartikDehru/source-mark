import assert from 'node:assert/strict';
import { test } from 'node:test';
import { median, tvlWeightedMean } from '../src/resolver.js';

test('median of an even-length set averages the middle two', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('median of an odd-length set is the middle element', () => {
  assert.equal(median([5, 1, 3]), 3);
});

/**
 * The case that motivated TVL weighting. These are the real numbers observed on
 * Ethereum mainnet: a wound-down Aave ARC pool holding $57k at 0% sat alongside
 * Aave V3 holding $2.3B at 3.6%. A plain median put the "USDC supply rate" at
 * 2.02%, which is a rate no lender on this list actually receives.
 */
test('TVL weighting stops a dead market from moving the headline', () => {
  const rows = [
    { value: 3.6003, weightUSD: 2_305_575_784 },
    { value: 0.5011, weightUSD: 20_497_658 },
    { value: 3.5419, weightUSD: 25_642_930 },
    { value: 0, weightUSD: 56_844 },
  ];

  const weighted = tvlWeightedMean(rows);
  const plain = median(rows.map((r) => r.value));

  assert.ok(weighted > 3.5 && weighted < 3.61, `expected ~3.57, got ${weighted}`);
  assert.ok(plain < 2.1, `plain median should be the misleading one, got ${plain}`);
  assert.ok(weighted - plain > 1.4, 'weighting should materially correct the headline');
});

test('a zero-TVL market cannot influence a weighted answer at all', () => {
  const withDead = tvlWeightedMean([
    { value: 4, weightUSD: 1_000_000 },
    { value: 0, weightUSD: 0 },
  ]);
  assert.equal(withDead, 4);
});

test('weighting falls back to median when every weight is zero, rather than dividing by zero', () => {
  const out = tvlWeightedMean([
    { value: 2, weightUSD: 0 },
    { value: 6, weightUSD: 0 },
  ]);
  assert.equal(out, 4);
  assert.ok(Number.isFinite(out));
});

test('equal weights reduce to a plain mean', () => {
  assert.equal(tvlWeightedMean([{ value: 1, weightUSD: 5 }, { value: 3, weightUSD: 5 }]), 2);
});
