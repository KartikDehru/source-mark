/**
 * hedera:doctor — preflight for the payment rail.
 *
 * Every one of these checks exists because the failure it catches is otherwise
 * silent or misleading. The big one is key type: Hedera accounts can be
 * ED25519 or ECDSA, the portal hands out ED25519 by default, and the x402
 * `exact` scheme for Hedera needs ECDSA. Get that wrong and you see a signing
 * or verification error that says nothing about key types.
 *
 * This verifies against the public mirror node, which needs no credentials, so
 * it works before anything else is configured.
 *
 *   npm run hedera:doctor
 */

import { config } from '../src/config.js';

const MIRROR = process.env.HEDERA_MIRROR_NODE ?? 'https://testnet.mirrornode.hedera.com';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let failures = 0;
let warnings = 0;

function ok(label: string, detail = ''): void {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}
function bad(label: string, detail = ''): void {
  failures += 1;
  console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${RED}${detail}${RESET}` : ''}`);
}
function warn(label: string, detail = ''): void {
  warnings += 1;
  console.log(`  ${YELLOW}!${RESET} ${label}${detail ? ` ${YELLOW}${detail}${RESET}` : ''}`);
}
function hint(text: string): void {
  console.log(`    ${DIM}→ ${text}${RESET}`);
}

interface MirrorAccount {
  account: string;
  deleted: boolean;
  balance: { balance: number; tokens: Array<{ token_id: string; balance: number }> } | null;
  key: { _type: string; key: string } | null;
}

async function fetchAccount(id: string): Promise<MirrorAccount | { error: string }> {
  try {
    const res = await fetch(`${MIRROR}/api/v1/accounts/${encodeURIComponent(id)}?limit=1`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return { error: 'not found on testnet' };
    if (!res.ok) return { error: `mirror node HTTP ${res.status}` };
    return (await res.json()) as MirrorAccount;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const hbar = (tinybar: number): string => `${(tinybar / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 })} HBAR`;

const ACCOUNT_RE = /^\d+\.\d+\.\d+$/;

async function checkReceiver(): Promise<void> {
  console.log(`\n${BOLD}1. Receiving account${RESET} ${DIM}X402_PAY_TO — where read revenue lands${RESET}`);

  if (!config.x402.payTo) {
    bad('X402_PAY_TO is not set');
    hint('Create a testnet account at https://portal.hedera.com and paste its account id');
    return;
  }
  if (!ACCOUNT_RE.test(config.x402.payTo)) {
    bad(`X402_PAY_TO "${config.x402.payTo}" is not a Hedera account id`);
    hint('Expected the form 0.0.1234567 — not an EVM 0x address');
    return;
  }

  const acct = await fetchAccount(config.x402.payTo);
  if ('error' in acct) {
    bad(`${config.x402.payTo} — ${acct.error}`);
    return;
  }
  if (acct.deleted) {
    bad(`${config.x402.payTo} is deleted`);
    return;
  }

  ok(`${config.x402.payTo} exists`, `balance ${hbar(acct.balance?.balance ?? 0)} · key ${acct.key?._type ?? 'unknown'}`);
  console.log(`    ${DIM}This account only receives. It needs no balance and no particular key type,`);
  console.log(`    ${DIM}because the facilitator co-signs and pays gas.${RESET}`);
}

async function checkBuyer(): Promise<void> {
  console.log(`\n${BOLD}2. Paying account${RESET} ${DIM}BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY — the agent's wallet${RESET}`);

  if (!config.buyer.accountId || !config.buyer.privateKey) {
    bad('BUYER_ACCOUNT_ID and/or BUYER_PRIVATE_KEY are not set');
    hint('This must be a SECOND account, and its key must be ECDSA (secp256k1)');
    return;
  }
  if (!ACCOUNT_RE.test(config.buyer.accountId)) {
    bad(`BUYER_ACCOUNT_ID "${config.buyer.accountId}" is not a Hedera account id`);
    return;
  }

  const acct = await fetchAccount(config.buyer.accountId);
  if ('error' in acct) {
    bad(`${config.buyer.accountId} — ${acct.error}`);
    return;
  }
  if (acct.deleted) {
    bad(`${config.buyer.accountId} is deleted`);
    return;
  }

  const balance = acct.balance?.balance ?? 0;
  const price = Number(config.x402.price);
  ok(`${config.buyer.accountId} exists`, `balance ${hbar(balance)}`);

  if (balance < price) {
    bad(`balance ${hbar(balance)} is below the ${hbar(price)} price of a single read`);
    hint('Top up at https://portal.hedera.com');
  } else {
    ok(`funded for ~${Math.floor(balance / price).toLocaleString()} reads`, `at ${config.x402.price} tinybar each`);
  }

  // Key type. This is the check worth running before anything else.
  const keyType = acct.key?._type ?? 'unknown';
  if (keyType !== 'ECDSA_SECP256K1') {
    bad(`key type is ${keyType}, but the Hedera x402 exact scheme needs ECDSA_SECP256K1`);
    hint('Hedera Portal defaults to ED25519. Create an ECDSA account instead and use that one.');
    return;
  }
  ok('key type is ECDSA_SECP256K1');

  // Does the private key actually control this account?
  try {
    const mod = (await import('@x402/hedera')) as { PrivateKey: { fromStringECDSA: (k: string) => { publicKey: { toStringRaw: () => string } } } };
    const derived = mod.PrivateKey.fromStringECDSA(config.buyer.privateKey).publicKey.toStringRaw().toLowerCase();
    const onChain = (acct.key?.key ?? '').toLowerCase();

    if (!onChain) {
      warn('mirror node did not return a public key; cannot confirm the key matches the account');
    } else if (derived === onChain) {
      ok('BUYER_PRIVATE_KEY controls this account', `pubkey ${derived.slice(0, 20)}…`);
    } else {
      bad('BUYER_PRIVATE_KEY does not match this account');
      hint(`account expects ${onChain.slice(0, 24)}…`);
      hint(`your key derives  ${derived.slice(0, 24)}…`);
      hint('These are almost certainly a key and account id copied from different accounts.');
    }
  } catch (err) {
    bad('BUYER_PRIVATE_KEY could not be parsed as an ECDSA key', err instanceof Error ? err.message : String(err));
    hint('Use the HEX Encoded Private Key from the portal, for an ECDSA account');
  }

  if (config.buyer.accountId === config.x402.payTo) {
    warn('BUYER_ACCOUNT_ID and X402_PAY_TO are the same account');
    hint('A self-transfer is not a meaningful payment demo. Use two distinct accounts.');
  }
}

async function checkAsset(): Promise<void> {
  console.log(`\n${BOLD}3. Payment asset${RESET} ${DIM}X402_ASSET${RESET}`);

  if (config.x402.asset === '0.0.0') {
    ok('native HBAR', 'no token association needed');
    return;
  }

  ok(`HTS token ${config.x402.asset}`);
  for (const [role, id] of [['payer', config.buyer.accountId], ['receiver', config.x402.payTo]] as const) {
    if (!id) continue;
    const acct = await fetchAccount(id);
    if ('error' in acct) continue;
    const holds = acct.balance?.tokens?.some((t) => t.token_id === config.x402.asset);
    if (holds) ok(`${role} ${id} is associated with the token`);
    else bad(`${role} ${id} is not associated with ${config.x402.asset}`);
  }
}

async function checkFacilitator(): Promise<void> {
  console.log(`\n${BOLD}4. Facilitator${RESET} ${DIM}${config.x402.facilitator}${RESET}`);
  try {
    const res = await fetch(`${config.x402.facilitator}/supported`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      bad(`/supported returned HTTP ${res.status}`);
      return;
    }
    const body = (await res.json()) as {
      kinds: Array<{ scheme: string; network: string; extra?: { feePayer?: string } }>;
      signers?: Record<string, string[]>;
    };
    const kind = body.kinds.find((k) => k.network === config.x402.network);
    if (!kind) {
      bad(`does not advertise ${config.x402.network}`, `advertises: ${body.kinds.map((k) => k.network).join(', ')}`);
      return;
    }
    ok(`advertises ${config.x402.network}`, `scheme ${kind.scheme}`);

    const feePayer = kind.extra?.feePayer ?? body.signers?.[`${config.x402.network.split(':')[0]}:*`]?.[0];
    if (feePayer) ok('fee payer advertised', feePayer);
    else bad('no fee payer advertised for this network');
  } catch (err) {
    bad('unreachable', err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}Hedera payment preflight${RESET}`);
  console.log(`${DIM}network ${config.x402.network} · mirror ${MIRROR}${RESET}`);

  await checkReceiver();
  await checkBuyer();
  await checkAsset();
  await checkFacilitator();

  console.log();
  if (failures === 0 && warnings === 0) {
    console.log(`${GREEN}${BOLD}Ready.${RESET} Start the gateway and run a paid read:`);
    console.log(`${DIM}  npm run dev`);
    console.log(`  npm run pay${RESET}\n`);
  } else if (failures === 0) {
    console.log(`${YELLOW}Ready, with ${warnings} warning(s).${RESET}\n`);
  } else {
    console.log(`${RED}${failures} blocking problem(s)${warnings ? `, ${warnings} warning(s)` : ''}.${RESET} Fix these before a paid read can settle.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
