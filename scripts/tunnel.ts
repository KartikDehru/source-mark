/**
 * Put the gateway on a public HTTPS URL, and write that URL down.
 *
 *   npm run tunnel
 *
 * A quick tunnel gets a new hostname every time it starts, which is the part
 * that bites: the URL ends up pasted into a Bazantic gateway, a demo page and a
 * terminal or two, and the next restart silently invalidates all of them. The
 * fix here is not a stable hostname — that needs an account somewhere — but a
 * single place the current one is recorded, so recovering from a restart is
 * reading one file instead of hunting through scrollback.
 *
 * Writes PUBLIC_URL into .env and mirrors it to .tunnel-url.txt, then tells you
 * exactly what still points at the old address.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

const PORT = process.env.PORT ?? '8787';

const CANDIDATES = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  '/usr/local/bin/cloudflared',
  '/opt/homebrew/bin/cloudflared',
  'cloudflared',
];

function cloudflaredPath(): string {
  for (const p of CANDIDATES) {
    if (p === 'cloudflared' || existsSync(p)) return p;
  }
  return 'cloudflared';
}

/**
 * Upsert a key in .env, preserving everything else. Rewriting the file wholesale
 * would drop the comments that explain which Hedera key is which, so this only
 * ever touches the one line.
 */
function writeEnv(key: string, value: string): void {
  const path = '.env';
  const line = `${key}=${value}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`);
    return;
  }
  const body = readFileSync(path, 'utf8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(path, pattern.test(body) ? body.replace(pattern, line) : `${body.replace(/\n*$/, '\n')}${line}\n`);
}

/**
 * Announcing a hostname is not the same as serving on it. cloudflared prints the
 * URL as soon as the edge assigns it, before DNS has propagated and sometimes
 * before it holds a connection at all — so a tunnel that will never work looks
 * identical to one that is fine. Poll until it answers, and say so plainly if it
 * does not.
 */
async function confirmReachable(url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      const res = await fetch(`${url}/health`);
      console.log(`${GREEN}reachable${RESET} ${DIM}/health answered ${res.status}${RESET}\n`);
      return;
    } catch {
      // Still propagating, or the edge connection is flapping. Keep waiting.
    }
  }
  console.log(
    `\n${YELLOW}${BOLD}not reachable after 90s.${RESET} The hostname was assigned but never answered —\n` +
      `${DIM}usually the connection to the Cloudflare edge is dropping. Ctrl-c and rerun.${RESET}\n`,
  );
}

function main(): void {
  const bin = cloudflaredPath();
  console.log(`${DIM}starting a quick tunnel to localhost:${PORT}…${RESET}`);

  const child = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let announced = false;

  const scan = (chunk: Buffer): void => {
    const text = chunk.toString();

    // Keep surfacing trouble after the URL is announced. A quick tunnel can
    // print a hostname and then fail to hold a connection to the edge, which
    // leaves the URL unresolvable while the process still looks healthy —
    // swallowing this output turns a visible network fault into a mystery.
    if (announced) {
      for (const line of text.split('\n')) {
        if (/\b(ERR|WRN)\b/.test(line)) console.log(`${DIM}${line.trim()}${RESET}`);
      }
      return;
    }

    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
    if (!match) return;
    announced = true;

    const url = match[0];
    writeEnv('PUBLIC_URL', url);
    writeFileSync('.tunnel-url.txt', url);

    console.log(`\n${GREEN}${BOLD}public${RESET} ${BOLD}${url}${RESET}`);
    console.log(`${DIM}written to .env as PUBLIC_URL, and to .tunnel-url.txt${RESET}\n`);
    console.log(`  spec     ${url}/openapi.json`);
    console.log(`  demo     ${url}/demo`);
    console.log(`  read     ${url}/v1/reads/aave-v3-ethereum?metric=supplyAPY&asset=USDC\n`);
    console.log(
      `${YELLOW}This hostname is new.${RESET} Anything registered against the previous one is now stale —\n` +
        `${DIM}re-register the Bazantic gateway against the URL above if you are demoing that path.${RESET}\n`,
    );
    console.log(`${DIM}leave this running; ctrl-c takes the tunnel down${RESET}`);
    void confirmReachable(url);
  };

  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  child.on('exit', (code) => {
    console.log(`\n${DIM}tunnel closed (exit ${code ?? 0})${RESET}`);
    process.exit(code ?? 0);
  });

  const stop = (): void => {
    child.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
