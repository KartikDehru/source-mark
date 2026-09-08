import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialMatches } from '../src/server.js';

/**
 * The resale channel hands out answers without an x402 settlement, so its
 * credential check is the only thing standing between a caller and free reads.
 * The cases that matter are the ones where a bug reads as "working": an
 * unconfigured secret must not become a bypass, and a prefix must not pass for
 * the whole.
 */

test('an unconfigured secret is never a bypass, even for a caller sending nothing', () => {
  assert.equal(credentialMatches(undefined, ''), false);
  assert.equal(credentialMatches('', ''), false);
  assert.equal(credentialMatches('anything', ''), false);
});

test('a configured secret rejects an absent or empty credential', () => {
  assert.equal(credentialMatches(undefined, 'secret'), false);
  assert.equal(credentialMatches('', 'secret'), false);
});

test('only the exact secret matches', () => {
  assert.equal(credentialMatches('secret', 'secret'), true);
  assert.equal(credentialMatches('Secret', 'secret'), false);
  assert.equal(credentialMatches('secret ', 'secret'), false);
});

test('a prefix or an extension of the secret does not match', () => {
  assert.equal(credentialMatches('sec', 'secret'), false);
  assert.equal(credentialMatches('secretsecret', 'secret'), false);
});

test('a multi-byte credential is compared by bytes, not by code points', () => {
  // 'é' is two bytes in UTF-8, so a byte-length check and a string-length check
  // disagree here. timingSafeEqual works on bytes; this pins that down.
  assert.equal(credentialMatches('é', 'é'), true);
  assert.equal(credentialMatches('ée', 'é'), false);
});
