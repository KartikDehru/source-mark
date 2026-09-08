/**
 * mcp:smoke — prove the MCP server actually works.
 *
 * An MCP server that has never been spoken to over stdio is an untested
 * server. This drives it as a real client would: initialize, list tools, then
 * call the two that matter, including the refusal path — because the whole
 * point of the SKILL.md contract is that an agent handles a refusal correctly,
 * and that is only meaningful if a refusal actually reaches the agent.
 *
 *   npm run mcp:smoke
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let failures = 0;

function ok(msg: string, detail = ''): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}
function bad(msg: string, detail = ''): void {
  failures += 1;
  console.log(`  ${RED}✗${RESET} ${msg}${detail ? ` ${RED}${detail}${RESET}` : ''}`);
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}MCP server smoke test${RESET}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'mcp/server.ts'],
    cwd: process.cwd(),
  });

  const client = new Client({ name: 'sourcemark-smoke', version: '0.1.0' });

  try {
    await client.connect(transport);
    ok('connected over stdio');
  } catch (err) {
    bad('could not connect', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ['check_sources', 'get_receipt', 'list_schema_families', 'read_metric'];
    if (expected.every((n) => names.includes(n))) {
      ok(`exposes ${tools.length} tools`, names.join(', '));
    } else {
      bad('missing tools', `got ${names.join(', ')}`);
    }

    // The description is the only spec a model gets. If the refusal contract is
    // not in there, an agent has no way to know a refusal is final.
    const readMetric = tools.find((t) => t.name === 'read_metric');
    const desc = readMetric?.description ?? '';
    if (/REFUS/i.test(desc) && /not.{0,20}retry/i.test(desc)) {
      ok('read_metric description states the refusal contract');
    } else {
      bad('read_metric description does not tell an agent how to handle a refusal');
    }

    console.log(`\n${BOLD}list_schema_families${RESET}`);
    const families = await client.callTool({ name: 'list_schema_families', arguments: {} });
    const famText = firstText(families);
    const famJson = JSON.parse(famText) as { families: Array<{ family: string; ready: boolean; comparability: string }> };
    for (const f of famJson.families) {
      ok(f.family, `${f.comparability} · ${f.ready ? 'ready' : 'NOT ready'}`);
    }

    console.log(`\n${BOLD}read_metric — answered path${RESET} ${DIM}(this spends testnet HBAR)${RESET}`);
    const answered = await client.callTool({
      name: 'read_metric',
      arguments: { family: 'aave-v3-ethereum', metric: 'supplyAPY', asset: 'USDC' },
    });
    const aJson = JSON.parse(firstText(answered)) as {
      outcome: string;
      answer?: { value: number; unit: string; contributors: number };
      payment?: { transaction?: string };
    };
    if (aJson.outcome === 'ANSWERED' && aJson.answer) {
      ok(`ANSWERED ${aJson.answer.value.toFixed(6)} ${aJson.answer.unit}`, `${aJson.answer.contributors} sources · tx ${aJson.payment?.transaction ?? '-'}`);
    } else {
      bad(`expected ANSWERED, got ${aJson.outcome}`, firstText(answered).slice(0, 200));
    }

    console.log(`\n${BOLD}read_metric — refusal path${RESET}`);
    const refused = await client.callTool({
      name: 'read_metric',
      arguments: { family: 'aave-v3-ethereum', metric: 'supplyAPY', asset: 'USDC', strictLag: 0 },
    });
    const rJson = JSON.parse(firstText(refused)) as { outcome: string; reason?: string; guidance?: string };
    if (rJson.outcome === 'REFUSED') {
      ok(`REFUSED ${rJson.reason ?? ''}`);
      if (rJson.guidance) ok('carries explicit guidance for the agent', rJson.guidance.slice(0, 72) + '…');
      else bad('refusal carries no guidance; an agent may treat it as a retryable error');
    } else {
      // strictLag can legitimately pass when sources sit at lag 0.
      console.log(`  ${DIM}outcome was ${rJson.outcome} — sources were fresh enough to satisfy even strictLag=0${RESET}`);
      const harder = await client.callTool({
        name: 'read_metric',
        arguments: { family: 'aave-v3-ethereum', metric: 'supplyAPY', asset: 'USDC', strictLag: 0, strictAge: 1 },
      });
      const hJson = JSON.parse(firstText(harder)) as { outcome: string; reason?: string; guidance?: string };
      if (hJson.outcome === 'REFUSED') ok(`REFUSED ${hJson.reason ?? ''}`, 'via strictAge');
      else bad(`could not produce a refusal; got ${hJson.outcome}`);
    }
  } catch (err) {
    bad('tool call failed', err instanceof Error ? err.message : String(err));
  } finally {
    await client.close().catch(() => {});
  }

  console.log();
  if (failures === 0) console.log(`${GREEN}${BOLD}MCP server is working.${RESET}\n`);
  else {
    console.log(`${RED}${failures} problem(s).${RESET}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
