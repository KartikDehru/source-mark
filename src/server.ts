import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Hono, type Context } from 'hono';
import { config, configWarnings } from './config.js';
import { log } from './logger.js';
import { effectivePolicy, getFamily, loadRegistry, registrySummary } from './registry.js';
import { publicEndpointFor } from './graph.js';
import { resolve as resolveRead } from './resolver.js';
import { issueReceipt, receiptSignerAddress, type SignedReceipt } from './receipt.js';
import {
  computeSplit,
  contributorsFrom,
  payoutSummaries,
  recordSettlement,
  upholdDispute,
  type DisputeEntry,
} from './split.js';
import { operatorEvmAddress, recordReadOnchain } from './split-onchain.js';
import { openApiDocument } from './openapi.js';
import { appendTo, readCollection } from './store.js';
import {
  buildRequirements,
  decodePaymentHeader,
  explorerLink,
  facilitatorSupported,
  payloadMatchesRequirements,
  settlePayment,
  verifyPayment,
} from './x402.js';

export const app = new Hono();

/**
 * The URL the *caller* used, which is not always the one Hono sees.
 *
 * Behind a TLS-terminating proxy (a tunnel, or any normal load balancer) the
 * request arrives over plain HTTP, so `c.req.url` reports `http://` for a
 * request the client made to `https://`. That matters more here than it would
 * in most services: the x402 resource is part of what a payer signs over, so
 * advertising `http://…` in a challenge answered at `https://…` binds the
 * payment to a URL that nobody actually called, and a strict facilitator is
 * entitled to reject it.
 *
 * `x-forwarded-proto` is trusted only because nothing reaches this process
 * except through the proxy in front of it; exposed directly, that header is
 * caller-controlled and this would need to check the peer address first.
 */
function publicUrl(c: Context): URL {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (proto) url.protocol = `${proto}:`;
  if (host) url.host = host;
  return url;
}

app.get('/', (c) => c.redirect('/demo'));

/**
 * Machine-readable description of this instance. Bazantic fetches this
 * server-side to generate a listing and an MCP endpoint, so `servers` is
 * derived from the request origin rather than hardcoded — behind a tunnel or a
 * deploy the spec has to describe the URL it was actually reached on, not
 * localhost.
 */
app.get('/openapi.json', (c) => c.json(openApiDocument(publicUrl(c).origin) as object));

/**
 * What a proxy in front of us actually forwards.
 *
 * Off unless DEBUG_ECHO=1, because a public header dump is a credential leak
 * waiting to happen — anything that looks like a secret is redacted to its
 * length even so, since the point is to learn which headers arrive, not what
 * they contain.
 */
app.get('/debug/echo', (c) => {
  if (process.env.DEBUG_ECHO !== '1') return c.json({ error: 'NOT_ENABLED' }, 404);
  const sensitive = /^(authorization|cookie|x-api-key|proxy-authorization)$/i;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.header())) {
    headers[k] = sensitive.test(k) ? `<redacted, ${v?.length ?? 0} chars>` : (v ?? '');
  }
  return c.json({ method: c.req.method, path: c.req.path, headers });
});

app.get('/health', async (c) => {
  const supported = await facilitatorSupported();
  return c.json({
    status: 'ok',
    service: 'sourcemark',
    modes: {
      payment: config.x402.mode,
      split: config.split.mode,
      anchor: config.anchor.mode,
    },
    graph: { gateway: config.graph.gateway, apiKeyConfigured: Boolean(config.graph.apiKey) },
    split: {
      mode: config.split.mode,
      contract: config.split.contractAddress || null,
      explorer: config.split.contractAddress
        ? `https://hashscan.io/testnet/contract/${config.split.contractAddress}`
        : null,
      routingFeeBps: config.split.routingFeeBps,
      holdbackBps: config.split.holdbackBps,
      holdbackVestingSeconds: config.split.holdbackVestingSeconds,
    },
    // Whether the channel exists, never the secret that opens it.
    resale: { enabled: Boolean(config.resale.apiKey), label: config.resale.label },
    x402: {
      facilitator: config.x402.facilitator,
      network: config.x402.network,
      reachable: supported !== null,
      advertisedNetworks: supported?.kinds.map((k) => k.network) ?? [],
      payToConfigured: Boolean(config.x402.payTo),
      price: config.x402.price,
      asset: config.x402.asset,
    },
    receipts: { signer: receiptSignerAddress() },
    families: registrySummary().map((f) => ({ family: f.family, ready: f.ready })),
    warnings: configWarnings(),
  });
});

/**
 * The registry as data. This is the reusable artefact: conformance to a schema
 * family is a list anyone can read, extend, or disagree with.
 */
app.get('/v1/registry', (c) => {
  const reg = loadRegistry(true);
  return c.json({
    version: reg.version,
    note: reg.note,
    howToExtend: 'Add an entry to registry/families.json and run `npm run registry:doctor`. No code changes.',
    families: registrySummary(),
    endpoints: Object.fromEntries(
      Object.entries(reg.families).map(([name, f]) => [
        name,
        f.sources.map((s) => ({ protocol: s.protocol, endpoint: publicEndpointFor(s) })),
      ]),
    ),
  });
});

app.get('/v1/policy/:family', (c) => {
  const name = c.req.param('family');
  const family = getFamily(name);
  if (!family) return c.json({ error: 'UNKNOWN_FAMILY', family: name }, 404);
  return c.json({
    family: name,
    label: family.label,
    schema: family.schema,
    schemaUrl: family.schemaUrl,
    policy: effectivePolicy(family),
    metrics: family.metrics,
    sources: family.sources.length,
  });
});

/** The gate. */
app.get('/v1/reads/:family', async (c) => {
  const familyName = c.req.param('family');
  const metric = c.req.query('metric');
  const asset = c.req.query('asset');

  if (!metric) {
    return c.json({ error: 'MISSING_METRIC', hint: 'pass ?metric=<name>; see /v1/policy/:family' }, 400);
  }

  const family = getFamily(familyName);
  if (!family) {
    return c.json({ error: 'UNKNOWN_FAMILY', family: familyName, known: Object.keys(loadRegistry().families) }, 404);
  }

  // A metric this family does not expose is a caller mistake, not a provenance
  // refusal. Keeping the two apart matters: agents are told to treat REFUSED as
  // final and stop, and a typo should not look like a data-quality event.
  if (!family.metrics[metric]) {
    return c.json(
      { error: 'UNKNOWN_METRIC', family: familyName, metric, available: Object.keys(family.metrics) },
      400,
    );
  }

  const policy = effectivePolicy(family);

  // Callers may only ever tighten a freshness bound, never loosen it. This is
  // also the deterministic failure demo: ?strictAge=1 reliably forces a
  // refusal, since healthy sources sit at lag 0 but are always a few seconds
  // old, so an age bound can be made to fail on demand and a lag bound cannot.
  const tighten = (raw: string | undefined, ceiling: number): number | undefined =>
    raw === undefined ? undefined : Math.min(ceiling, Math.max(0, Number.parseInt(raw, 10) || 0));

  const readRequest = {
    family: familyName,
    metric,
    asset,
    forceMaxBlockLag: tighten(c.req.query('strictLag'), policy.maxBlockLag),
    forceMaxAgeSeconds: tighten(c.req.query('strictAge'), policy.maxAgeSeconds),
  };

  // ── PAYMENT_MODE=free: the honest read layer without the paywall ──────────
  if (config.x402.mode === 'free') {
    const outcome = await resolveRead(readRequest);
    if (!outcome.resolved) return refusal(c, outcome, 'free');
    return c.json({
      family: familyName,
      metric,
      asset: asset ?? null,
      answer: outcome.answer,
      sources: outcome.sources,
      policy: outcome.policy,
      payment: { mode: 'free' },
    });
  }

  // ── 1. Challenge ──────────────────────────────────────────────────────────
  const requirements = await buildRequirements(
    publicUrl(c).toString(),
    `${family.label}: ${metric}${asset ? ` for ${asset}` : ''}, ${policy.minSources}+ pinned sources within ${policy.maxBlockLag} blocks`,
  );

  if (!requirements.payTo) {
    return c.json({ error: 'SERVICE_MISCONFIGURED', detail: 'X402_PAY_TO is unset' }, 503);
  }

  // ── 1b. The resale channel ────────────────────────────────────────────────
  // A caller arriving through the Bazantic gateway has already been billed by
  // Bazantic, in USDC on a chain this service does not price in. It presents a
  // shared secret instead of an x402 payload. Everything downstream is the
  // same read — including a free refusal — so this is a different way of
  // paying, not a way of skipping the policy.
  if (isResaleRequest(c)) {
    return completeRead(c, {
      channel: 'resale',
      readRequest,
      family,
      familyName,
      metric,
      asset,
      requirements,
      payer: config.resale.label,
    });
  }

  const header = c.req.header('X-PAYMENT');
  if (!header) {
    return c.json(
      {
        error: 'PAYMENT_REQUIRED',
        x402Version: 2,
        accepts: [requirements],
        policy,
        note: 'Settlement occurs only if the read satisfies the policy. A refused read is never charged.',
      },
      402,
    );
  }

  const payload = decodePaymentHeader(header);
  if (!payload) {
    return c.json({ error: 'MALFORMED_PAYMENT', detail: 'X-PAYMENT must be base64 JSON of an x402 v2 PaymentPayload' }, 400);
  }

  const mismatch = payloadMatchesRequirements(payload, requirements);
  if (mismatch) {
    return c.json({ error: 'PAYMENT_REQUIRED', detail: mismatch, x402Version: 2, accepts: [requirements] }, 402);
  }

  // ── 2. Verify, but do not settle ──────────────────────────────────────────
  const verification = await verifyPayment(payload, requirements);
  if (!verification.isValid) {
    return c.json(
      {
        error: 'PAYMENT_INVALID',
        reason: verification.invalidReason,
        detail: verification.invalidMessage,
        x402Version: 2,
        accepts: [requirements],
      },
      402,
    );
  }

  return completeRead(c, {
    channel: 'x402',
    readRequest,
    family,
    familyName,
    metric,
    asset,
    requirements,
    settle: () => settlePayment(payload, requirements),
    payer: verification.payer ?? null,
  });
});

/**
 * Constant-time credential check that fails closed.
 *
 * An empty `expected` means the resale channel is not configured, and must
 * never match — including against a caller who also sends nothing, which a
 * naive equality check would happily wave through and thereby turn a *missing*
 * secret into a public bypass of the paywall.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so
 * the lengths are compared first. That leaks the secret's length, which is not
 * worth defending against here.
 */
export function credentialMatches(presented: string | undefined, expected: string): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Does this request arrive through the resale gateway? */
function isResaleRequest(c: Context): boolean {
  const presented = c.req.header('x-api-key') ?? bearer(c.req.header('authorization'));
  return credentialMatches(presented, config.resale.apiKey);
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}

/**
 * Resolve the read and, if it holds up, pay for it — the half of the request
 * that is identical whichever way the caller arrived.
 *
 * Both channels share this deliberately. The refusal rule is the product, so
 * it cannot be something the x402 path enforces and the resale path quietly
 * skips; routing them through one function is what makes that true by
 * construction rather than by review. The only difference is `settle`: the
 * x402 path moves HBAR per read, the resale path was billed upstream and
 * passes nothing.
 */
async function completeRead(
  c: Context,
  opts: {
    channel: 'x402' | 'resale';
    readRequest: Parameters<typeof resolveRead>[0];
    family: NonNullable<ReturnType<typeof getFamily>>;
    familyName: string;
    metric: string;
    asset: string | undefined;
    requirements: Awaited<ReturnType<typeof buildRequirements>>;
    settle?: () => Promise<Awaited<ReturnType<typeof settlePayment>>>;
    payer: string | null;
  },
): Promise<Response> {
  const { channel, familyName, metric, asset, requirements, family } = opts;

  // ── Do the work ───────────────────────────────────────────────────────────
  const outcome = await resolveRead(opts.readRequest);
  if (!outcome.resolved) {
    log.info(
      `refused ${familyName}/${metric}: ${outcome.reason} — ` +
        (channel === 'x402' ? 'payment verified but not settled' : 'resale read, nothing billed'),
    );
    return refusal(c, outcome, channel);
  }

  // ── Only now does money move ──────────────────────────────────────────────
  let payer = opts.payer;
  let transaction: string | null = null;
  if (opts.settle) {
    const settlement = await opts.settle();
    if (!settlement.success) {
      return c.json(
        {
          error: 'SETTLEMENT_FAILED',
          reason: settlement.errorReason,
          detail: settlement.errorMessage,
          note: 'The read succeeded but settlement did not, so the answer is withheld. You have not been charged.',
        },
        502,
      );
    }
    payer = payer ?? settlement.payer ?? null;
    transaction = settlement.transaction ?? null;
  }

  // ── Receipt, split, ledger ────────────────────────────────────────────────
  const receipt = await issueReceipt({
    family: familyName,
    metric,
    asset,
    answer: outcome.answer,
    sources: outcome.sources,
    policy: outcome.policy,
    chainHead: outcome.chainHead,
    payment: {
      network: channel === 'resale' ? `resale:${config.resale.label}` : requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
      payer: payer ?? undefined,
      transaction: transaction ?? undefined,
    },
  });

  const payoutByDeployment = new Map(family.sources.map((s) => [s.id, s.payoutAddress]));
  const split = computeSplit(requirements.amount, contributorsFrom(outcome.sources, payoutByDeployment));

  recordSettlement({
    ts: Math.floor(Date.now() / 1000),
    digest: receipt.digest,
    family: familyName,
    metric,
    gross: split.gross,
    routingFee: split.routingFee,
    shares: split.shares,
    transaction,
  });

  // Sources are paid the same way on both channels — a resale read is funded
  // from the operator float rather than the caller's HBAR, but the split, the
  // holdback and the liability are identical. The local ledger is written
  // either way, so there is always a record even if the chain write fails.
  const onchain = await recordReadOnchain({
    digest: receipt.digest,
    grossTinybar: split.gross,
    // A resale payer is a label, not a Hedera account, so it cannot be resolved
    // to an address a refund could reach. Name the operator instead — it fronted
    // this read, so it is who an upheld dispute should pay back.
    payer: channel === 'resale' ? (operatorEvmAddress() ?? undefined) : (payer ?? undefined),
    shares: split.shares,
  });

  appendTo<SignedReceipt>('receipts', receipt);

  c.header('X-Payment-Receipt', Buffer.from(JSON.stringify(receipt)).toString('base64'));

  return c.json({
    family: familyName,
    metric,
    asset: asset ?? null,
    answer: outcome.answer,
    sources: outcome.sources,
    policy: outcome.policy,
    payment:
      channel === 'resale'
        ? {
            channel: 'resale',
            via: config.resale.label,
            amount: requirements.amount,
            asset: requirements.asset,
            settled: false,
            note:
              `Billed by ${config.resale.label} in its own currency on its own chain. No HBAR moved on this ` +
              'request; the sources below were still paid onchain from the operator float.',
          }
        : {
            channel: 'x402',
            network: requirements.network,
            amount: requirements.amount,
            asset: requirements.asset,
            payer: payer ?? null,
            transaction,
            explorer: explorerLink(requirements.network, transaction ?? undefined),
          },
    payout: { ...split, onchain },
    receipt: { digest: receipt.digest, signature: receipt.signature, signer: receipt.signer },
  });
}

/**
 * A refusal, and why it cost nothing.
 *
 * The reason differs per channel and a caller reconciling their bill needs the
 * right one — a resale refusal reported as "PAYMENT_MODE=free" tells a Bazantic
 * buyer their read was never priced, which is untrue: it was priced, billed
 * upstream, and then declined here.
 */
function refusal(
  c: Context,
  outcome: Extract<Awaited<ReturnType<typeof resolveRead>>, { resolved: false }>,
  channel: 'free' | 'x402' | 'resale',
): Response {
  const notes = {
    free: 'PAYMENT_MODE=free — no charge applies.',
    x402: 'Payment was verified but deliberately not settled. You have not been charged.',
    resale: `Refused before any HBAR moved. Whatever ${config.resale.label} charged you for this request is between you and them; nothing settled on our side and no source was paid.`,
  };
  return c.json(
    {
      error: 'REFUSED',
      reason: outcome.reason,
      detail: outcome.detail,
      survived: outcome.survived,
      required: outcome.required,
      sources: outcome.sources,
      policy: outcome.policy,
      settled: false,
      channel,
      note: notes[channel],
    },
    409,
  );
}

app.get('/v1/receipts/:digest', (c) => {
  const digest = c.req.param('digest').toLowerCase();
  const found = readCollection<SignedReceipt>('receipts').find((r) => r.digest.toLowerCase() === digest);
  if (!found) return c.json({ error: 'RECEIPT_NOT_FOUND', digest }, 404);
  return c.json({
    receipt: found,
    howToVerify: [
      'Re-run the family query against each pinned deploymentId at the recorded block.',
      'Recompute the answer and compare with answerHash.',
      'If it does not reproduce, POST /v1/disputes with this digest.',
    ],
  });
});

app.get('/v1/payouts', (c) =>
  c.json({
    mode: config.split.mode,
    routingFeeBps: config.split.routingFeeBps,
    holdbackBps: config.split.holdbackBps,
    holdbackVestingSeconds: config.split.holdbackVestingSeconds,
    note: 'Held-back balances are unvested and are the liability pool for disputes. No source posts collateral; penalties come out of earned-but-uncleared revenue.',
    sources: payoutSummaries(),
  }),
);

app.post('/v1/disputes', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { digest?: string; claimant?: string; reason?: string };
  if (!body.digest || !body.reason) {
    return c.json({ error: 'BAD_REQUEST', detail: 'digest and reason are required' }, 400);
  }

  const receipt = readCollection<SignedReceipt>('receipts').find(
    (r) => r.digest.toLowerCase() === (body.digest as string).toLowerCase(),
  );
  if (!receipt) return c.json({ error: 'RECEIPT_NOT_FOUND', digest: body.digest }, 404);

  const chargedTo = receipt.body.sources.map((s) => s.deploymentId);
  const entry = upholdDispute(receipt.digest, body.claimant ?? 'anonymous', body.reason, chargedTo);

  return c.json({
    dispute: entry,
    note: 'Refunded from the unvested holdback of every source that contributed the disputed claim, capped at what is actually unvested.',
  });
});

app.get('/v1/disputes', (c) => c.json({ disputes: readCollection<DisputeEntry>('disputes') }));

/**
 * Brand assets for the demo page.
 *
 * Deliberately not a general static file server. The filename is matched
 * against a strict pattern and only SVG is served, so there is no path to
 * traverse out of `public/assets` and no way to have the process hand out a
 * `.env` or a private key because someone found a clever encoding of `..`.
 */
app.get('/assets/:file', (c) => {
  const name = c.req.param('file');
  if (!/^[a-z0-9][a-z0-9._-]*\.svg$/i.test(name) || name.includes('..')) {
    return c.json({ error: 'NOT_FOUND' }, 404);
  }
  try {
    const svg = readFileSync(resolvePath(process.cwd(), 'public', 'assets', name), 'utf8');
    c.header('content-type', 'image/svg+xml; charset=utf-8');
    // Revalidate rather than cache for an hour. These are a couple of KB each,
    // and the failure mode of a long TTL here is a demo showing a stale or
    // broken logo minutes after it was fixed.
    c.header('cache-control', 'no-cache');
    return c.body(svg);
  } catch {
    return c.json({ error: 'NOT_FOUND', file: name }, 404);
  }
});

app.get('/demo', (c) => {
  try {
    const html = readFileSync(resolvePath(process.cwd(), 'public', 'demo.html'), 'utf8');
    return c.html(html);
  } catch {
    return c.text('demo page not found', 404);
  }
});

/**
 * A cooldown on the two demo routes, because both of them spend money.
 *
 * `/demo/run` moves HBAR and burns gas; `/demo/resale` pays sources onchain out
 * of the operator float with no inbound payment at all. Neither is
 * authenticated — that is the point, a judge should be able to click the
 * buttons — but exposed on a public tunnel they are also an unmetered way to
 * drain the accounts that make the rest of the demo work.
 *
 * A per-caller cooldown plus a global hourly cap keeps a human clicking buttons
 * unaffected while bounding what a script can cost us. The real paid endpoint
 * needs none of this: it charges per request, which is its own rate limit.
 */
const DEMO_COOLDOWN_MS = 6_000;
const DEMO_HOURLY_CAP = 120;
const demoLastSeen = new Map<string, number>();
let demoHour = { start: Date.now(), count: 0 };

function demoThrottled(c: Context): Response | null {
  const now = Date.now();

  if (now - demoHour.start > 3_600_000) demoHour = { start: now, count: 0 };
  if (demoHour.count >= DEMO_HOURLY_CAP) {
    return c.json(
      {
        error: 'DEMO_RATE_LIMITED',
        detail: `The demo endpoints are capped at ${DEMO_HOURLY_CAP} runs an hour because each one spends real testnet funds.`,
        hint: 'The paid endpoint itself is not rate limited: GET /v1/reads/:family with an x402 payment.',
        retryAfterMs: demoHour.start + 3_600_000 - now,
      },
      429,
    );
  }

  // Trusted only because nothing reaches this process except through the proxy
  // in front of it; the worst case if it is spoofed is that the hourly cap,
  // which no header can move, becomes the only limit.
  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'local';

  const previous = demoLastSeen.get(ip) ?? 0;
  if (now - previous < DEMO_COOLDOWN_MS) {
    return c.json(
      {
        error: 'DEMO_COOLDOWN',
        detail: 'One demo run at a time, please — each one signs a real transaction.',
        retryAfterMs: DEMO_COOLDOWN_MS - (now - previous),
      },
      429,
    );
  }

  if (demoLastSeen.size > 1_000) {
    for (const [key, seen] of demoLastSeen) {
      if (now - seen > DEMO_COOLDOWN_MS) demoLastSeen.delete(key);
    }
  }

  demoLastSeen.set(ip, now);
  demoHour.count += 1;
  return null;
}

/**
 * Runs the full buyer loop against this same service and returns the trace.
 * The agent on the demo page is a real x402 client, not a scripted animation:
 * it gets a 402, signs a Hedera payment, and retries.
 */
app.post('/demo/run', async (c) => {
  const limited = demoThrottled(c);
  if (limited) return limited;

  const body = (await c.req.json().catch(() => ({}))) as {
    family?: string;
    metric?: string;
    asset?: string;
    strictLag?: number;
    strictAge?: number;
  };

  const url = new URL(`/v1/reads/${body.family ?? 'aave-v3-ethereum'}`, publicUrl(c).origin);
  url.searchParams.set('metric', body.metric ?? 'supplyAPY');
  if (body.asset) url.searchParams.set('asset', body.asset);
  if (body.strictLag !== undefined) url.searchParams.set('strictLag', String(body.strictLag));
  if (body.strictAge !== undefined) url.searchParams.set('strictAge', String(body.strictAge));

  const { payAndRead } = await import('./buyer.js');
  return c.json({ url: url.toString(), ...(await payAndRead(url.toString())) });
});

/**
 * The resale channel, driven from the demo page.
 *
 * The browser cannot exercise this path itself: the shared secret is what
 * proves a request came through the reseller, so shipping it to a page would
 * publish the bypass. This calls our own gate with the secret server-side
 * instead.
 *
 * What that does and does not demonstrate is worth being exact about. It is
 * the same code path Bazantic's gateway hits — same credential check, same
 * provenance gate, same onchain split, same free refusal. It does not
 * demonstrate Bazantic billing anyone, because the request does not traverse
 * their gateway; that leg is theirs and is exercised against the public URL.
 */
app.post('/demo/resale', async (c) => {
  if (!config.resale.apiKey) {
    return c.json(
      {
        error: 'RESALE_NOT_CONFIGURED',
        detail: 'RESALE_API_KEY is unset, so the resale channel is disabled and fails closed.',
      },
      503,
    );
  }

  const limited = demoThrottled(c);
  if (limited) return limited;

  const body = (await c.req.json().catch(() => ({}))) as {
    family?: string;
    metric?: string;
    asset?: string;
    strictAge?: number;
  };

  const url = new URL(`/v1/reads/${body.family ?? 'aave-v3-ethereum'}`, publicUrl(c).origin);
  url.searchParams.set('metric', body.metric ?? 'supplyAPY');
  if (body.asset) url.searchParams.set('asset', body.asset);
  if (body.strictAge !== undefined) url.searchParams.set('strictAge', String(body.strictAge));

  const started = Date.now();
  const res = await fetch(url.toString(), { headers: { 'x-api-key': config.resale.apiKey } });
  const payload = await res.json().catch(() => null);

  return c.json({
    url: url.toString(),
    via: config.resale.label,
    status: res.status,
    elapsedMs: Date.now() - started,
    body: payload,
  });
});
