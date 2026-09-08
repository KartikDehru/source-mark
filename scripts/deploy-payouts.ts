/**
 * Deploy SourcePayouts and register every source in the registry.
 *
 *   npx hardhat run scripts/deploy-payouts.ts --network hederaTestnet
 *
 * Registration is keyed by DEPLOYMENT, not by family. The same deployment id
 * in two families is one sourceId onchain, so it is registered once.
 *
 * Prints the address to put in SOURCE_PAYOUTS_ADDRESS. Nothing is written to
 * .env automatically — a deploy that silently rewrites config is a deploy you
 * cannot reason about later.
 */

import { network } from 'hardhat';
import { keccak256, toBytes, getAddress, formatEther } from 'viem';
import { readFileSync } from 'node:fs';
import type {} from '@nomicfoundation/hardhat-viem';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

interface Source {
  protocol: string;
  id: string;
  payoutAddress: string;
  consent: string;
}
interface Registry {
  families: Record<string, { sources: Source[] }>;
}

const ARBITER = process.env.ARBITER_ADDRESS;
const ROUTING_FEE_BPS = Number(process.env.ROUTING_FEE_BPS ?? 1000);
const HOLDBACK_BPS = Number(process.env.HOLDBACK_BPS ?? 2000);
const VESTING = BigInt(process.env.HOLDBACK_VESTING_SECONDS ?? 604800);
const BOND = BigInt(process.env.DISPUTE_BOND_TINYBAR ?? 100_000_000) * 10_000_000_000n; // tinybar → weibar

function hashscan(kind: 'contract' | 'transaction', ref: string): string {
  return `https://hashscan.io/testnet/${kind}/${ref}`;
}

async function main(): Promise<void> {
  const { viem } = await network.getOrCreate();
  const [deployer] = await viem.getWalletClients();
  if (!deployer) throw new Error('no wallet client — is OPERATOR_PRIVATE_KEY set?');

  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const operator = deployer.account.address;
  const balance = await publicClient.getBalance({ address: operator });

  console.log(`\n${BOLD}Deploying SourcePayouts${RESET}`);
  console.log(`${DIM}chain ${chainId} · operator ${operator} · balance ${formatEther(balance)} HBAR${RESET}`);

  // The arbiter decides disputes, so it should not be the operator in a real
  // deployment. Default to the operator for a solo testnet run, but say so.
  const arbiter = ARBITER ? getAddress(ARBITER) : operator;
  if (!ARBITER) {
    console.log(
      `${YELLOW}arbiter defaults to the operator address.${RESET} ${DIM}One party both takes the fee and rules on disputes; set ARBITER_ADDRESS to separate them.${RESET}`,
    );
  }

  console.log(
    `${DIM}fee ${ROUTING_FEE_BPS}bps · holdback ${HOLDBACK_BPS}bps · vesting ${VESTING}s · bond ${formatEther(BOND)} HBAR${RESET}\n`,
  );

  const contract = await viem.deployContract('SourcePayouts', [
    arbiter,
    ROUTING_FEE_BPS,
    HOLDBACK_BPS,
    VESTING,
    BOND,
  ]);

  console.log(`${GREEN}${BOLD}deployed${RESET} ${contract.address}`);
  console.log(`${DIM}${hashscan('contract', contract.address)}${RESET}\n`);

  // Register each distinct deployment once.
  const registry = JSON.parse(readFileSync('registry/families.json', 'utf8')) as Registry;
  const byDeployment = new Map<string, Source>();
  for (const spec of Object.values(registry.families)) {
    for (const s of spec.sources) if (!byDeployment.has(s.id)) byDeployment.set(s.id, s);
  }

  console.log(`${BOLD}Registering ${byDeployment.size} sources${RESET}`);
  for (const [id, s] of byDeployment) {
    const sourceId = keccak256(toBytes(id));
    const registerSource = contract.write.registerSource;
    if (!registerSource) throw new Error('registerSource missing from the compiled ABI');
    const hash = await registerSource([sourceId, getAddress(s.payoutAddress)]);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${GREEN}✓${RESET} ${s.protocol.padEnd(22)} ${DIM}${sourceId.slice(0, 14)}… → ${s.payoutAddress}${RESET}`);
  }

  const consented = [...byDeployment.values()].filter((s) => s.consent === 'consented').length;
  console.log(
    `\n${YELLOW}${byDeployment.size - consented} of ${byDeployment.size} sources have consent: pending.${RESET}` +
      ` ${DIM}Payout addresses are stand-ins from the public test mnemonic; see registry/families.json.${RESET}`,
  );

  console.log(`\n${BOLD}Next${RESET}`);
  console.log(`  Add to .env:  ${GREEN}SOURCE_PAYOUTS_ADDRESS=${contract.address}${RESET}`);
  console.log(`  Then switch:  ${GREEN}SPLIT_MODE=onchain${RESET}`);
  console.log(`${DIM}  The gateway records each settled read with recordRead(), so the split is onchain per read.${RESET}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
