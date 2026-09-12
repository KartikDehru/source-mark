import { recoverMessageAddress, getAddress, isAddress } from 'viem';
import { readCollection, writeCollection } from './store.js';

/**
 * Opt-in for a source payout address.
 *
 * The registry ships stand-in payees so the split path is demonstrable without
 * pretending real indexer teams have joined. Consent turns that into something
 * a third party can check: control of the payout address, proven by an EIP-191
 * signature over a fixed message. Until a real team signs, the address remains
 * a stand-in — but the *mechanism* for joining is real and permissionless.
 *
 * Deliberately does not import the registry module: registry overlays consent
 * status at read time, and a cycle between the two would break boot.
 */

export const CONSENT_MESSAGE_PREFIX = 'SourceMark consent v1';

/** What EIP-191 consent proves vs does not — for API/docs honesty. */
export const CONSENT_PROVES =
  'Control of the registered payout address for a pinned deployment ID, via EIP-191.';

export const CONSENT_DOES_NOT_PROVE =
  'Official indexer identity, protocol-team affiliation, or off-registry reputation.';

export interface ConsentRecord {
  deploymentId: string;
  payoutAddress: string;
  protocol?: string;
  signature: string;
  signedAt: number;
  message: string;
}

export function consentMessage(deploymentId: string, payoutAddress: string, issuedAt: number): string {
  return [
    CONSENT_MESSAGE_PREFIX,
    `deployment:${deploymentId}`,
    `payout:${getAddress(payoutAddress)}`,
    `issued:${issuedAt}`,
  ].join('\n');
}

export function listConsents(): ConsentRecord[] {
  return readCollection<ConsentRecord>('consents');
}

export function consentFor(deploymentId: string): ConsentRecord | undefined {
  return listConsents().find((c) => c.deploymentId === deploymentId);
}

export async function recordConsent(input: {
  deploymentId: string;
  payoutAddress: string;
  signature: `0x${string}`;
  issuedAt: number;
  /** Must match the registry entry for this deployment — checked by the caller. */
  expectedPayoutAddress: string;
  protocol?: string;
}): Promise<{ ok: true; record: ConsentRecord } | { ok: false; error: string; detail?: string }> {
  if (!input.deploymentId) return { ok: false, error: 'MISSING_DEPLOYMENT' };
  if (!isAddress(input.payoutAddress) || !isAddress(input.expectedPayoutAddress)) {
    return { ok: false, error: 'BAD_PAYOUT_ADDRESS' };
  }
  if (!Number.isFinite(input.issuedAt) || input.issuedAt <= 0) {
    return { ok: false, error: 'BAD_ISSUED_AT' };
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - input.issuedAt);
  if (age > 24 * 60 * 60) {
    return { ok: false, error: 'STALE_ISSUED_AT', detail: 'consent message must be signed within 24h of issuedAt' };
  }

  const payout = getAddress(input.payoutAddress);
  if (payout.toLowerCase() !== getAddress(input.expectedPayoutAddress).toLowerCase()) {
    return {
      ok: false,
      error: 'PAYOUT_MISMATCH',
      detail: 'signature must come from the payoutAddress registered for this deployment',
    };
  }

  const message = consentMessage(input.deploymentId, payout, input.issuedAt);
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature: input.signature });
  } catch {
    return { ok: false, error: 'BAD_SIGNATURE' };
  }

  if (recovered.toLowerCase() !== payout.toLowerCase()) {
    return { ok: false, error: 'SIGNER_MISMATCH', detail: `recovered ${recovered}, expected ${payout}` };
  }

  const record: ConsentRecord = {
    deploymentId: input.deploymentId,
    payoutAddress: payout,
    protocol: input.protocol,
    signature: input.signature,
    signedAt: Math.floor(Date.now() / 1000),
    message,
  };

  const next = listConsents().filter((c) => c.deploymentId !== input.deploymentId);
  next.push(record);
  writeCollection('consents', next);
  return { ok: true, record };
}
