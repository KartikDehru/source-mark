import { config } from './config.js';
import type { SourceSpec } from './registry.js';

/**
 * The Graph gateway client. Live queries only — there is no fixture path in
 * this file by design, because "mocked, local-only, or static datasets do not
 * qualify" for the tracks this project targets.
 */

export interface GraphMeta {
  deployment: string;
  hasIndexingErrors: boolean;
  block: { number: number; hash: string | null; timestamp: number | null };
}

export interface GraphResult {
  ok: true;
  meta: GraphMeta;
  rows: Array<Record<string, unknown>>;
  latencyMs: number;
}

export interface GraphFailure {
  ok: false;
  error: string;
  detail?: string;
  latencyMs: number;
}

export function endpointFor(source: SourceSpec): string {
  const segment = source.idKind === 'deployment' ? 'deployments/id' : 'subgraphs/id';
  return `${config.graph.gateway}/api/${config.graph.apiKey}/${segment}/${source.id}`;
}

/** Same URL, with the API key redacted. Safe to log or return to a caller. */
export function publicEndpointFor(source: SourceSpec): string {
  const segment = source.idKind === 'deployment' ? 'deployments/id' : 'subgraphs/id';
  return `${config.graph.gateway}/api/<key>/${segment}/${source.id}`;
}

function pluck(data: Record<string, unknown>, path: string): Array<Record<string, unknown>> {
  const value = data[path];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

export async function queryGraph(
  source: SourceSpec,
  query: string,
  variables: Record<string, unknown>,
  rowsPath: string,
  timeoutMs = 12_000,
  atBlock?: number,
): Promise<GraphResult | GraphFailure> {
  const started = Date.now();

  if (!config.graph.apiKey) {
    return { ok: false, error: 'NO_GRAPH_API_KEY', latencyMs: 0 };
  }

  const finalQuery = atBlock === undefined ? query : withBlockConstraint(query, rowsPath);
  const finalVars =
    atBlock === undefined ? variables : { ...variables, smBlock: atBlock };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpointFor(source), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: finalQuery, variables: finalVars }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP_${res.status}`, detail: body.slice(0, 300), latencyMs };
    }

    const json = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      return {
        ok: false,
        error: 'GRAPHQL_ERROR',
        detail: json.errors.map((e) => e.message).join('; ').slice(0, 300),
        latencyMs,
      };
    }

    const data = json.data;
    if (!data) return { ok: false, error: 'EMPTY_RESPONSE', latencyMs };

    const rawMeta = data['_meta'] as
      | { deployment?: string; hasIndexingErrors?: boolean; block?: { number?: number; hash?: string; timestamp?: number } }
      | undefined;

    if (!rawMeta?.block?.number) {
      return { ok: false, error: 'NO_META_BLOCK', latencyMs };
    }

    const meta: GraphMeta = {
      deployment: rawMeta.deployment ?? '',
      hasIndexingErrors: Boolean(rawMeta.hasIndexingErrors),
      block: {
        number: rawMeta.block.number,
        hash: rawMeta.block.hash ?? null,
        timestamp: rawMeta.block.timestamp ?? null,
      },
    };

    return { ok: true, meta, rows: pluck(data, rowsPath), latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message.includes('abort') ? 'TIMEOUT' : 'NETWORK_ERROR',
      detail: message.slice(0, 200),
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pin a family query to a historical block so a receipt can be re-derived.
 * Injects `$__smBlock` and `block: { number: $__smBlock }` on `_meta` and the
 * family's row collection.
 */
export function withBlockConstraint(query: string, rowsPath: string): string {
  let q = query;
  if (!q.includes('$smBlock')) {
    if (/query\s+\w+\s*\([^)]*\)/.test(q)) {
      q = q.replace(/query\s+(\w+)\s*\(([^)]*)\)/, (_m, name: string, args: string) => {
        const trimmed = args.trim();
        const next = trimmed.length ? `${trimmed}, $smBlock: Int!` : `$smBlock: Int!`;
        return `query ${name}(${next})`;
      });
    } else {
      q = q.replace(/query\s+(\w+)\s*\{/, 'query $1($smBlock: Int!) {');
    }
  }
  if (!/_meta\s*\(/.test(q)) {
    q = q.replace(/_meta\s*\{/, '_meta(block: { number: $smBlock }) {');
  }
  const field = rowsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${field}\\s*\\(`);
  if (!new RegExp(`\\b${field}\\s*\\([^)]*block\\s*:`).test(q)) {
    q = q.replace(re, `${rowsPath}(block: { number: $smBlock }, `);
  }
  return q;
}
