/**
 * SourceMark SDK — thin HTTP client for the provenance-gated read layer.
 *
 * Payment (X-PAYMENT) is built by the Hedera buyer in the main repo
 * (`src/buyer.ts`, `npm run pay`). This package stays dependency-light so
 * agents can challenge, read with a prepared header, and inspect receipts.
 */

export interface SourceMarkOptions {
  /** Gateway origin, e.g. https://source-mark-production.up.railway.app */
  baseUrl: string;
  /** Optional fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface ReadQuery {
  metric: string;
  asset?: string;
  minSources?: number;
  strictLag?: number;
  strictAge?: number;
  /** Base64 x402 payment payload for the paid path. */
  paymentHeader?: string;
  /** Resale channel shared secret (Bazantic). */
  apiKey?: string;
}

export interface SourceMarkResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
  headers: Headers;
}

function joinUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const u = new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === '') continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

export class SourceMark {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SourceMarkOptions) {
    if (!opts.baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  private async request<T = unknown>(
    path: string,
    init?: RequestInit & { query?: Record<string, string | number | undefined> },
  ): Promise<SourceMarkResponse<T>> {
    const url = joinUrl(this.baseUrl, path, init?.query);
    const { query: _q, ...rest } = init ?? {};
    const res = await this.fetchImpl(url, rest);
    const body = (await res.json().catch(() => null)) as T;
    return { ok: res.ok, status: res.status, body, headers: res.headers };
  }

  /** Unpaid challenge — expect HTTP 402 with paymentRequirements. */
  challenge(family: string, q: Omit<ReadQuery, 'paymentHeader' | 'apiKey'>) {
    return this.request(`/v1/reads/${encodeURIComponent(family)}`, {
      query: {
        metric: q.metric,
        asset: q.asset,
        minSources: q.minSources,
        strictLag: q.strictLag,
        strictAge: q.strictAge,
      },
    });
  }

  /**
   * Paid or resale read. Pass `paymentHeader` for x402, or `apiKey` for the
   * Bazantic-style resale channel. Without either, this is the same as challenge.
   */
  read(family: string, q: ReadQuery) {
    const headers: Record<string, string> = {};
    if (q.paymentHeader) headers['X-PAYMENT'] = q.paymentHeader;
    if (q.apiKey) headers['x-api-key'] = q.apiKey;
    return this.request(`/v1/reads/${encodeURIComponent(family)}`, {
      headers,
      query: {
        metric: q.metric,
        asset: q.asset,
        minSources: q.minSources,
        strictLag: q.strictLag,
        strictAge: q.strictAge,
      },
    });
  }

  health() {
    return this.request('/health');
  }

  registry() {
    return this.request('/v1/registry');
  }

  policy(family: string) {
    return this.request(`/v1/policy/${encodeURIComponent(family)}`);
  }

  receipt(digest: string) {
    return this.request(`/v1/receipts/${encodeURIComponent(digest)}`);
  }

  payouts() {
    return this.request('/v1/payouts');
  }

  intents() {
    return this.request('/v1/agent-intents');
  }

  openDispute(body: { digest: string; reason: string; claimant?: string; preferDeadline?: boolean }) {
    return this.request('/v1/disputes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

export default SourceMark;
