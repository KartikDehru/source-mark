/**
 * consent-demo — opt in every registry source with DEMO_SOURCE_MNEMONIC keys.
 *
 *   npm run consent:demo -- --url=https://source-mark-production.up.railway.app
 *
 * Requires DEMO_SOURCE_MNEMONIC in .env (dedicated hackathon mnemonic — not
 * the public Hardhat phrase). Addresses in registry/families.json must match.
 */

import 'dotenv/config';
import { mnemonicToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { consentMessage } from '../src/consent.js';

const MNEMONIC = process.env.DEMO_SOURCE_MNEMONIC;
const BASE = (process.argv.find((a) => a.startsWith('--url='))?.slice(6) ??
  process.env.PUBLIC_URL ??
  'http://localhost:8787').replace(/\/+$/, '');

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

interface Source {
  protocol: string;
  id: string;
  payoutAddress: string;
}

async function main(): Promise<void> {
  if (!MNEMONIC) {
    console.error('DEMO_SOURCE_MNEMONIC is unset. Generate one and update registry/families.json.');
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync('registry/families.json', 'utf8')) as {
    families: Record<string, { sources: Source[] }>;
  };

  const byDeployment = new Map<string, Source>();
  for (const spec of Object.values(registry.families)) {
    for (const s of spec.sources) if (!byDeployment.has(s.id)) byDeployment.set(s.id, s);
  }

  const accounts = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const byAddress = new Map(accounts.map((a) => [a.address.toLowerCase(), a]));

  console.log(`\n${BOLD}Source consent demo${RESET} → ${BASE}`);
  console.log(`${DIM}${byDeployment.size} distinct deployments · DEMO_SOURCE_MNEMONIC keys${RESET}\n`);

  let ok = 0;
  let fail = 0;

  for (const [id, s] of byDeployment) {
    const account = byAddress.get(s.payoutAddress.toLowerCase());
    if (!account) {
      console.log(`${RED}✗${RESET} ${s.protocol} — payout ${s.payoutAddress} is not from DEMO_SOURCE_MNEMONIC`);
      fail += 1;
      continue;
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const message = consentMessage(id, s.payoutAddress, issuedAt);
    const signature = await account.signMessage({ message });

    const res = await fetch(`${BASE}/v1/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deploymentId: id,
        payoutAddress: s.payoutAddress,
        issuedAt,
        signature,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };

    if (res.ok) {
      console.log(`${GREEN}✓${RESET} ${s.protocol.padEnd(22)} consented as ${s.payoutAddress.slice(0, 10)}…`);
      ok += 1;
    } else {
      console.log(`${RED}✗${RESET} ${s.protocol.padEnd(22)} HTTP ${res.status} ${body.error ?? ''}`);
      fail += 1;
    }
  }

  const summary = (await fetch(`${BASE}/v1/consent`).then((r) => r.json())) as {
    consented: number;
    totalSources: number;
  };
  console.log(
    `\n${BOLD}${summary.consented}/${summary.totalSources}${RESET} sources consented on this instance` +
      (fail ? ` ${DIM}(${fail} failed this run)${RESET}` : ''),
  );
  console.log(`${DIM}Same path a real indexer would use with their own key.${RESET}\n`);

  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
