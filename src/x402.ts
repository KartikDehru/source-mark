import { config } from './config.js';
import { log } from './logger.js';

/**
 * x402 v2 over the Blocky402 facilitator.
 *
 * The one thing worth reading carefully: verify() and settle() are deliberately
 * separate calls made at different points in the request. We verify before
 * doing any work, and only settle once the read has actually satisfied the
 * freshness policy. A refused read is therefore never charged — the service is
 * structurally unable to profit from an answer it cannot stand behind.
 */

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  resource?: string;
  description?: string;
  extra?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: 2;
  scheme: string;
  network: string;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
}

export interface VerifyResult {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
  invalidMessage?: string;
}

export interface SettleResult {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
}

interface SupportedKind {
  scheme: string;
  network: string;
  x402Version: number;
  extra?: { feePayer?: string };
}

interface SupportedResponse {
  kinds: SupportedKind[];
  signers?: Record<string, string[]>;
}

let supportedCache: { value: SupportedResponse; fetchedAt: number } | null = null;
const SUPPORTED_TTL_MS = 300_000;

export async function facilitatorSupported(force = false): Promise<SupportedResponse | null> {
  if (!force && supportedCache && Date.now() - supportedCache.fetchedAt < SUPPORTED_TTL_MS) {
    return supportedCache.value;
  }
  try {
    const res = await fetch(`${config.x402.facilitator}/supported`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      log.warn(`facilitator /supported returned HTTP ${res.status}`);
      return supportedCache?.value ?? null;
    }
    const value = (await res.json()) as SupportedResponse;
    supportedCache = { value, fetchedAt: Date.now() };
    return value;
  } catch (err) {
    log.warn('facilitator /supported unreachable', err instanceof Error ? err.message : String(err));
    return supportedCache?.value ?? null;
  }
}

/**
 * Hedera's scheme has the facilitator co-sign as fee payer, so the client must
 * embed the exact fee-payer account the facilitator advertises. We read it live
 * rather than hardcoding it — if they rotate the account mid-hackathon, nothing
 * here breaks.
 */
export async function feePayerFor(network: string): Promise<string | null> {
  const supported = await facilitatorSupported();
  if (!supported) return null;
  const kind = supported.kinds.find((k) => k.network === network);
  if (kind?.extra?.feePayer) return kind.extra.feePayer;
  const family = `${network.split(':')[0]}:*`;
  return supported.signers?.[family]?.[0] ?? null;
}

export async function buildRequirements(resource: string, description: string): Promise<PaymentRequirements> {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: config.x402.network,
    amount: config.x402.price,
    payTo: config.x402.payTo,
    asset: config.x402.asset,
    maxTimeoutSeconds: config.x402.timeoutSeconds,
    resource,
    description,
  };

  const feePayer = await feePayerFor(config.x402.network);
  if (feePayer) requirements.extra = { feePayer };

  return requirements;
}

export function decodePaymentHeader(header: string): PaymentPayload | null {
  try {
    const json = Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as PaymentPayload;
    if (parsed.x402Version !== 2 || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The payload must be paying *us*, on the right network, the right amount. */
export function payloadMatchesRequirements(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): string | null {
  const a = payload.accepted;
  if (!a) return 'payload has no accepted requirements';
  if (payload.network !== requirements.network) return `network mismatch: ${payload.network}`;
  if (a.payTo !== requirements.payTo) return `payTo mismatch: ${a.payTo}`;
  if (a.asset !== requirements.asset) return `asset mismatch: ${a.asset}`;
  if (BigInt(a.amount) < BigInt(requirements.amount)) return `underpaid: ${a.amount} < ${requirements.amount}`;
  return null;
}

async function facilitatorPost<T>(path: string, body: unknown): Promise<T | { __error: string }> {
  try {
    const res = await fetch(`${config.x402.facilitator}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) return { __error: `HTTP_${res.status}: ${text.slice(0, 300)}` };
    return JSON.parse(text) as T;
  } catch (err) {
    return { __error: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifyPayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResult> {
  const out = await facilitatorPost<VerifyResult>('/verify', {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });
  if ('__error' in out) return { isValid: false, invalidReason: 'FACILITATOR_UNREACHABLE', invalidMessage: out.__error };
  return out;
}

export async function settlePayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResult> {
  const out = await facilitatorPost<SettleResult>('/settle', {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });
  if ('__error' in out) return { success: false, errorReason: 'FACILITATOR_UNREACHABLE', errorMessage: out.__error };
  return out;
}

export function explorerLink(network: string, transaction: string | undefined): string | null {
  if (!transaction) return null;
  if (network.startsWith('hedera:')) {
    const net = network.split(':')[1] ?? 'testnet';
    return `https://hashscan.io/${net}/transaction/${encodeURIComponent(transaction)}`;
  }
  return null;
}
