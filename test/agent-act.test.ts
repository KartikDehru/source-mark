import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideThreshold } from '../src/agent-act.js';

describe('acting agent threshold', () => {
  it('ENTER when value clears the threshold', () => {
    assert.equal(decideThreshold(3.6, 3.5), 'ENTER');
    assert.equal(decideThreshold(3.5, 3.5), 'ENTER');
  });

  it('HOLD when value is below the threshold', () => {
    assert.equal(decideThreshold(3.4, 3.5), 'HOLD');
  });

  it('NONE when there is no numeric answer', () => {
    assert.equal(decideThreshold(null, 3.5), 'NONE');
    assert.equal(decideThreshold(undefined, 3.5), 'NONE');
    assert.equal(decideThreshold(Number.NaN, 3.5), 'NONE');
  });
});
