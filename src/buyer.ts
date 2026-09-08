import { config } from './config.js';
import type { PaymentRequirements } from './x402.js';

/**
 * The buying half of the protocol.
 *
 * Shipping the client alongside the server matters here: an x402 endpoint that
 * only its author can pay is a paywall, not a payment rail. This same function
 * backs the in-page demo agent, the one-shot CLI, and the autonomous loop.
 *
 * Note what the buyer does NOT do: it signs a payment and attaches it. It never
 * calls /verify or /settle itself. Settlement is the resource server's decision
 * and it makes that decision only after the read passes the freshness policy.
 */

export interface TraceStep {
  step: string;
  ok: boolean;
  detail: string;
  data?: unknown;
}

export interface PayAndReadResult {
  ok: boolean;
  status: number;
  trace: TraceStep[];
  challenge?: unknown;
  body?: unknown;
  receiptHeader?: string | null;
}

// Loaded through variable specifiers so the server still boots (and can still
// serve its 402 challenge) on a machine where the Hedera SDK is not installed.
async function loadHederaScheme(): Promise<{
  createSigner: (accountId: string, key: unknown, opts: { network: string }) => unknown;
  parseKey: (key: string) => unknown;
  Scheme: new (signer: unknown) => { createPaymentPayload: (v: number, req: PaymentRequirements) => Promise<{ payload: Record<string, unknown> }> };
}> {
  const base = '@x402/hedera';
  const clientPath = '@x402/hedera/exact/client';
  const core = (await import(base)) as {
    createClientHederaSigner: (accountId: string, key: unknown, opts: { network: string }) => unknown;
    PrivateKey: { fromStringECDSA: (k: string) => unknown };
  };
  const client = (await import(clientPath)) as {
    ExactHederaScheme: new (signer: unknown) => { createPaymentPayload: (v: number, req: PaymentRequirements) => Promise<{ payload: Record<string, unknown> }> };
  };
  return {
    createSigner: core.createClientHederaSigner,
    parseKey: (k: string) => core.PrivateKey.fromStringECDSA(k),
    Scheme: client.ExactHederaScheme,
  };
}

export async function payAndRead(url: string): Promise<PayAndReadResult> {
  const trace: TraceStep[] = [];

  // ── 1. Ask without paying. A real 402 is the whole point. ─────────────────
  const unpaid = await fetch(url);
  const challenge = (await unpaid.json().catch(() => null)) as
    | { accepts?: PaymentRequirements[]; policy?: unknown }
    | null;

  if (unpaid.status !== 402) {
    trace.push({
      step: 'challenge',
      ok: false,
      detail: `expected HTTP 402, got ${unpaid.status}`,
      data: challenge,
    });
    return { ok: unpaid.ok, status: unpaid.status, trace, challenge, body: challenge };
  }

  const requirements = challenge?.accepts?.[0];
  if (!requirements) {
    trace.push({ step: 'challenge', ok: false, detail: '402 carried no payment requirements' });
    return { ok: false, status: 402, trace, challenge };
  }

  trace.push({
    step: 'challenge',
    ok: true,
    detail: `402 Payment Required — ${requirements.amount} on ${requirements.network} to ${requirements.payTo}`,
    data: { requirements, policy: challenge?.policy },
  });

  // ── 2. Sign a payment for exactly those requirements. ─────────────────────
  if (!config.buyer.accountId || !config.buyer.privateKey) {
    trace.push({
      step: 'sign',
      ok: false,
      detail: 'BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY are unset. Fund a Hedera testnet account at https://portal.hedera.com and set them in .env',
    });
    return { ok: false, status: 402, trace, challenge };
  }

  let header: string;
  try {
    const { createSigner, parseKey, Scheme } = await loadHederaScheme();
    const signer = createSigner(config.buyer.accountId, parseKey(config.buyer.privateKey), {
      network: requirements.network,
    });
    const signed = await new Scheme(signer).createPaymentPayload(2, requirements);

    const paymentPayload = {
      x402Version: 2,
      scheme: 'exact',
      network: requirements.network,
      accepted: requirements,
      payload: signed.payload,
    };

    header = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
    trace.push({
      step: 'sign',
      ok: true,
      detail: `partially-signed TransferTransaction built by ${config.buyer.accountId}; the facilitator co-signs as fee payer`,
    });
  } catch (err) {
    trace.push({ step: 'sign', ok: false, detail: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 402, trace, challenge };
  }

  // ── 3. Retry with proof of payment. ───────────────────────────────────────
  const paid = await fetch(url, { headers: { 'X-PAYMENT': header } });
  const body = (await paid.json().catch(() => null)) as unknown;

  if (paid.status === 409) {
    trace.push({
      step: 'settle',
      ok: true,
      detail: 'read REFUSED — provenance policy not satisfied, so the gateway did not settle. Nothing was charged.',
      data: body,
    });
  } else if (paid.ok) {
    trace.push({ step: 'settle', ok: true, detail: 'settled on-chain and answer returned', data: body });
  } else {
    trace.push({ step: 'settle', ok: false, detail: `HTTP ${paid.status}`, data: body });
  }

  return {
    ok: paid.ok,
    status: paid.status,
    trace,
    challenge,
    body,
    receiptHeader: paid.headers.get('X-Payment-Receipt'),
  };
}
