#!/usr/bin/env node
/**
 * MCP server for SourceMark.
 *
 * Tool descriptions here are written for the agent, not for a human skimming
 * docs — for a model calling these tools, the description IS the specification.
 * In particular every tool that can refuse says so in its description, because
 * an agent that treats a refusal as a transient error will retry-loop or, far
 * worse, silently fall back to an unverified number.
 *
 *   node --import tsx mcp/server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { payAndRead } from '../src/buyer.js';
import { config } from '../src/config.js';

const BASE = process.env.PROVENANCE_METER_URL ?? `http://localhost:${config.port}`;

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

const server = new McpServer({ name: 'sourcemark', version: '0.1.0' });

server.registerTool(
  'list_schema_families',
  {
    title: 'List schema families',
    description:
      'List every standardized schema family this gateway can read, the metrics each exposes, the freshness policy each is held to, and how many sources are currently pinned. Call this before read_metric so you use a metric name that exists and know the freshness bound your answer will be held to.',
    inputSchema: {},
  },
  async () => text(await getJson('/v1/registry')),
);

server.registerTool(
  'read_metric',
  {
    title: 'Read a provenance-checked metric',
    description:
      'Read one metric from a schema family. The gateway queries several pinned deployments, verifies each is within the freshness policy, and returns the median with a per-source breakdown. ' +
      'IMPORTANT: this tool can return a REFUSAL instead of a value. A refusal means provenance could not be established — it is a valid, final result, not an error. When refused, do NOT substitute a cached value, a single-source query, or an estimate, and do NOT retry in a loop. Report the reason and stop whatever action depended on the number. Refused reads are not charged. ' +
      'When it does return a value, check "spread": sources can be fresh and still disagree, and a wide spread should be reported rather than hidden behind the median.',
    inputSchema: {
      family: z.string().describe('Schema family id, e.g. "aave-v3-ethereum". Get valid values from list_schema_families.'),
      metric: z.string().describe('Metric name, e.g. "supplyAPY". Must be one the family exposes.'),
      asset: z.string().optional().describe('Optional asset symbol filter, e.g. "USDC".'),
      strictLag: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Optional stricter block-lag bound. Can only tighten the policy, never loosen it. Use when the answer feeds a transaction and you want a harder freshness guarantee — accepting that it makes refusal more likely.'),
      strictAge: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Optional stricter wall-clock age bound, in seconds. Can only tighten the policy, never loosen it. A value of 1 will always refuse, because indexed data is never less than a second old — use it to verify that you handle a refusal correctly before you depend on this tool.'),
    },
  },
  async ({ family, metric, asset, strictLag, strictAge }) => {
    const url = new URL(`/v1/reads/${family}`, BASE);
    url.searchParams.set('metric', metric);
    if (asset) url.searchParams.set('asset', asset);
    if (strictLag !== undefined) url.searchParams.set('strictLag', String(strictLag));
    if (strictAge !== undefined) url.searchParams.set('strictAge', String(strictAge));

    const result = await payAndRead(url.toString());

    if (result.status === 409) {
      return text({
        outcome: 'REFUSED',
        guidance: 'Provenance could not be established. Do not substitute another source. Report this and halt the dependent action. You were not charged.',
        ...(result.body as object),
      });
    }
    if (!result.ok) {
      return text({ outcome: 'ERROR', status: result.status, trace: result.trace, body: result.body });
    }
    return text({ outcome: 'ANSWERED', ...(result.body as object) });
  },
);

server.registerTool(
  'get_receipt',
  {
    title: 'Fetch a signed receipt',
    description:
      'Fetch the signed receipt behind an earlier answer by its digest. The receipt names every pinned deployment that contributed and the exact block each claim rests on, so anyone can re-derive the answer and challenge it if it does not reproduce. Use this when you need to show your work or when a downstream system asks where a number came from.',
    inputSchema: { digest: z.string().describe('Receipt digest, the 0x-prefixed keccak hash returned with an answer.') },
  },
  async ({ digest }) => text(await getJson(`/v1/receipts/${digest}`)),
);

server.registerTool(
  'check_sources',
  {
    title: 'Check source health',
    description:
      'Report the gateway\'s current health: which families can reach quorum, whether the payment facilitator is reachable, and whether a Graph key is configured. Call this after an unexpected refusal to explain WHY reads are failing rather than just reporting that they did.',
    inputSchema: {},
  },
  async () => text(await getJson('/health')),
);

await server.connect(new StdioServerTransport());
