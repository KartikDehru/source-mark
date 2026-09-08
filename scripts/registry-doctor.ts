/**
 * registry:doctor — live health check for every pinned source.
 *
 * This exists to make one failure mode impossible: quietly serving stale or
 * substituted data because a deployment id drifted. It queries every source for
 * real, compares the served deployment id against the pinned one, and measures
 * lag against actual chain head. Placeholders are reported as UNPINNED rather
 * than skipped, because a half-filled registry that silently "works" is worse
 * than one that refuses.
 *
 *   npm run registry:doctor
 */

import { chainHead } from '../src/anchor.js';
import { config } from '../src/config.js';
import { queryGraph } from '../src/graph.js';
import { effectivePolicy, isPlaceholder, loadRegistry, type FamilySpec } from '../src/registry.js';

const PROBE = `query PMDoctor { _meta { deployment hasIndexingErrors block { number timestamp } } }`;

const NETWORK_SUBGRAPH = process.env.GRAPH_NETWORK_SUBGRAPH ?? 'DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp';

/**
 * Ask The Graph's own network subgraph what schema each pinned deployment
 * actually uses. This is what makes "conforms to a standardized schema" a
 * checkable claim rather than a label we wrote in a config file: if a
 * deployment's schemaIpfsHash is not byte-identical to the family's, it does
 * not belong in the family, whatever its name says.
 */
async function declaredSchemas(ipfsHashes: string[]): Promise<Map<string, string>> {
  if (ipfsHashes.length === 0) return new Map();
  const url = `${config.graph.gateway}/api/${config.graph.apiKey}/subgraphs/id/${NETWORK_SUBGRAPH}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // Keyed on ipfsHash: SubgraphDeployment.id is a hex id, and only
        // ipfsHash is the Qm… string we actually pin in the registry.
        query: `query PMSchemas($ids: [String!]) {
          subgraphDeployments(where: { ipfsHash_in: $ids }, first: 100) {
            ipfsHash
            manifest { schemaIpfsHash }
          }
        }`,
        variables: { ids: ipfsHashes },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return new Map();
    const json = (await res.json()) as {
      data?: { subgraphDeployments?: Array<{ ipfsHash: string; manifest: { schemaIpfsHash: string | null } | null }> };
    };
    const out = new Map<string, string>();
    for (const d of json.data?.subgraphDeployments ?? []) {
      if (d.manifest?.schemaIpfsHash) out.set(d.ipfsHash, d.manifest.schemaIpfsHash);
    }
    return out;
  } catch {
    return new Map();
  }
}

function schemaVerdict(family: FamilySpec, sourceId: string, schemas: Map<string, string>): string {
  if (!family.schemaIpfsHash) return '';
  const actual = schemas.get(sourceId);
  if (!actual) return ` ${YELLOW}schema unverified${RESET}`;
  if (actual === family.schemaIpfsHash) return ` ${GREEN}schema ✓${RESET}`;
  return ` ${RED}SCHEMA MISMATCH (${actual.slice(0, 12)}…)${RESET}`;
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  const registry = loadRegistry();
  let hardFailures = 0;

  console.log(`\n${DIM}gateway   ${config.graph.gateway}${RESET}`);
  console.log(`${DIM}api key   ${config.graph.apiKey ? 'configured' : 'MISSING'}${RESET}`);
  console.log(`${DIM}anchor    ${config.anchor.mode}${RESET}\n`);

  if (!config.graph.apiKey) {
    console.log(`${RED}GRAPH_API_KEY is not set.${RESET} Every source will fail. Get a key at https://thegraph.com/studio\n`);
  }

  for (const [name, family] of Object.entries(registry.families)) {
    const policy = effectivePolicy(family);
    console.log(`${pad(name, 24)} ${DIM}${family.schema} · ${family.comparability} · quorum ${policy.minSources} · maxLag ${policy.maxBlockLag} · maxAge ${policy.maxAgeSeconds}s${RESET}`);
    if (family.schemaIpfsHash) {
      console.log(`  ${DIM}schema ${family.schemaIpfsHash}${RESET}`);
    }

    const schemas = await declaredSchemas(family.sources.filter((s) => !isPlaceholder(s.id)).map((s) => s.id));
    let healthy = 0;

    for (const source of family.sources) {
      const label = pad(source.protocol, 24);

      if (isPlaceholder(source.id)) {
        console.log(`  ${YELLOW}○${RESET} ${label} ${YELLOW}UNPINNED${RESET} ${DIM}fill "id" in registry/families.json${RESET}`);
        continue;
      }

      const [result, head] = await Promise.all([
        queryGraph(source, PROBE, {}, '_none'),
        chainHead(source.chainId),
      ]);

      if (!result.ok) {
        console.log(`  ${RED}✗${RESET} ${label} ${RED}${result.error}${RESET} ${DIM}${result.detail ?? ''}${RESET}`);
        continue;
      }

      const served = result.meta.deployment;
      if (source.idKind === 'deployment' && served && served !== source.id) {
        console.log(`  ${RED}✗${RESET} ${label} ${RED}PINNED_ID_MISMATCH${RESET} ${DIM}served ${served}${RESET}`);
        continue;
      }

      const block = result.meta.block.number;
      const lag = head === null ? null : Math.max(0, head - block);
      const age = result.meta.block.timestamp === null ? null : Math.floor(Date.now() / 1000) - result.meta.block.timestamp;

      const problems: string[] = [];
      if (result.meta.hasIndexingErrors) problems.push('INDEXING_ERRORS');
      if (lag !== null && lag > policy.maxBlockLag) problems.push(`LAG ${lag}>${policy.maxBlockLag}`);
      if (age !== null && age > policy.maxAgeSeconds) problems.push(`AGE ${age}s>${policy.maxAgeSeconds}s`);

      const schemaOk = !family.schemaIpfsHash || schemas.get(source.id) === family.schemaIpfsHash;
      if (family.schemaIpfsHash && schemas.has(source.id) && !schemaOk) problems.push('SCHEMA_MISMATCH');

      const stats =
        `${DIM}block ${block}${lag === null ? '' : ` · lag ${lag}`}${age === null ? '' : ` · ${age}s old`} · ${result.latencyMs}ms${RESET}` +
        schemaVerdict(family, source.id, schemas);

      if (problems.length === 0) {
        healthy += 1;
        console.log(`  ${GREEN}✓${RESET} ${label} ${GREEN}OK${RESET}       ${stats}`);
      } else {
        console.log(`  ${RED}✗${RESET} ${label} ${RED}${problems.join(' ')}${RESET} ${stats}`);
      }
    }

    const ready = healthy >= policy.minSources;
    if (!ready) hardFailures += 1;
    console.log(
      `  ${ready ? GREEN : RED}→ ${healthy}/${family.sources.length} healthy, ${policy.minSources} required — ${ready ? 'READY' : 'READS WILL REFUSE'}${RESET}\n`,
    );
  }

  if (hardFailures > 0) {
    console.log(`${RED}${hardFailures} family/families cannot reach quorum.${RESET} The gateway will return 409 REFUSED for them, which is correct behaviour — it will not substitute fixtures.\n`);
    process.exitCode = 1;
  } else {
    console.log(`${GREEN}All families can reach quorum.${RESET}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
