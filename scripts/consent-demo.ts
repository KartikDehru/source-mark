/**
 * Demonstrate source consent with the stand-in Hardhat mnemonic keys.
 *
 *   npx tsx scripts/consent-demo.ts [--url http://localhost:8787]
 *
 * The registry payout addresses are derived from the public Anvil mnemonic.
 * Signing with those keys does not make the recipients "real teams" — it proves
 * that anyone who controls a payout address can opt in, which is the join path
 * a real indexer would use with their own key.
 */

import 'dotenv/config';
import { mnemonicToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { consentMessage } from '../src/consent.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
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
  const registry = JSON.parse(readFileSync('registry/families.json', 'utf8')) as {
    families: Record<string, { sources: Source[] }>;
  };

  const byDeployment = new Map<string, Source>();
  for (const spec of Object.values(registry.families)) {
    for (const s of spec.sources) if (!byDeployment.has(s.id)) byDeployment.set(s.id, s);
  }

  // Map Hardhat indices 0..5 to the stand-in addresses used in the registry.
  const accounts = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
  const byAddress = new Map(accounts.map((a) => [a.address.toLowerCase(), a]));

  console.log(`\n${BOLD}Source consent demo${RESET} → ${BASE}`);
  console.log(`${DIM}${byDeployment.size} distinct deployments${RESET}\n`);

  let ok = 0;
  let fail = 0;

  for (const [id, s] of byDeployment) {
    const account = byAddress.get(s.payoutAddress.toLowerCase());
    if (!account) {
      console.log(`${RED}✗${RESET} ${s.protocol} — payout ${s.payoutAddress} is not from the test mnemonic`);
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; consent?: { deploymentId: string } };

    if (res.ok) {
      console.log(`${GREEN}✓${RESET} ${s.protocol.padEnd(22)} consented as ${s.payoutAddress.slice(0, 10)}…`);
      ok += 1;
    } else {
      console.log(`${RED}✗${RESET} ${s.protocol.padEnd(22)} HTTP ${res.status} ${body.error ?? ''}`);
      fail += 1;
    }
  }

  const summary = await fetch(`${BASE}/v1/consent`).then((r) => r.json()) as {
    consented: number;
    totalSources: number;
  };
  console.log(
    `\n${BOLD}${summary.consented}/${summary.totalSources}${RESET} sources consented on this instance` +
      (fail ? ` ${DIM}(${fail} failed this run)${RESET}` : ''),
  );
  console.log(`${DIM}POST /v1/consent is the same path a real indexer would use with their own key.${RESET}\n`);

  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
