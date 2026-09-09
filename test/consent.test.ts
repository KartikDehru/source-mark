import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToAccount } from 'viem/accounts';
import { consentMessage, recordConsent, listConsents } from '../src/consent.js';
import { writeCollection } from '../src/store.js';

const MNEMONIC = 'test test test test test test test test test test test junk';

describe('consent', () => {
  it('accepts an EIP-191 signature from the registered payout address', async () => {
    writeCollection('consents', []);
    const account = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
    const deploymentId = 'QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd';
    const issuedAt = Math.floor(Date.now() / 1000);
    const message = consentMessage(deploymentId, account.address, issuedAt);
    const signature = await account.signMessage({ message });

    const result = await recordConsent({
      deploymentId,
      payoutAddress: account.address,
      expectedPayoutAddress: account.address,
      issuedAt,
      signature,
      protocol: 'aave-v3-ethereum-a',
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.deploymentId, deploymentId);
    assert.equal(listConsents().length, 1);
  });

  it('rejects a signature from the wrong key', async () => {
    writeCollection('consents', []);
    const wrong = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
    const payout = mnemonicToAccount(MNEMONIC, { addressIndex: 0 }).address;
    const deploymentId = 'QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd';
    const issuedAt = Math.floor(Date.now() / 1000);
    const message = consentMessage(deploymentId, payout, issuedAt);
    const signature = await wrong.signMessage({ message });

    const result = await recordConsent({
      deploymentId,
      payoutAddress: payout,
      expectedPayoutAddress: payout,
      issuedAt,
      signature,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'SIGNER_MISMATCH');
  });
});
