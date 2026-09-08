/**
 * Autonomous buyer.
 *
 * An agent that wakes on an interval, pays for a read, and acts on the answer
 * only if the gateway was willing to stand behind it. The interesting column in
 * the output is REFUSED: those are the ticks where the agent correctly did
 * nothing, and paid nothing, because provenance could not be established.
 *
 *   npm run agent -- --interval 30 --ticks 10 --metric supplyAPY --asset USDC
 *
 * Bounded to 10 ticks by default because each one settles real testnet HBAR.
 * Pass --ticks 0 to run until interrupted.
 */

import { payAndRead } from '../src/buyer.js';
import { config } from '../src/config.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
}

const base = arg('base', `http://localhost:${config.port}`) as string;
const family = arg('family', 'aave-v3-ethereum') as string;
const metric = arg('metric', 'supplyAPY') as string;
const asset = arg('asset', 'USDC') as string;
const intervalSeconds = Number.parseInt(arg('interval', '30') as string, 10);

// Every tick spends real testnet HBAR, so an unbounded default is a footgun
// during a demo. --ticks 0 opts back into running until interrupted.
const ticksArg = Number.parseInt(arg('ticks', '10') as string, 10);
const maxTicks = ticksArg === 0 ? Infinity : ticksArg;

const url = (() => {
  const u = new URL(`/v1/reads/${family}`, base);
  u.searchParams.set('metric', metric);
  if (asset) u.searchParams.set('asset', asset);
  return u.toString();
})();

const tally = { answered: 0, refused: 0, failed: 0, spent: 0n };

async function tick(n: number): Promise<void> {
  const stamp = new Date().toISOString().slice(11, 19);
  const result = await payAndRead(url);

  if (result.ok) {
    const body = result.body as {
      answer?: { value: number; unit: string; contributors: number };
      payment?: { amount?: string; transaction?: string };
      receipt?: { digest?: string };
    };
    tally.answered += 1;
    tally.spent += BigInt(body.payment?.amount ?? '0');
    const shown = body.answer ? body.answer.value.toFixed(4) : '-';
    console.log(
      `${stamp}  #${n}  ANSWERED  ${shown} ${body.answer?.unit} ` +
        `from ${body.answer?.contributors} sources  tx=${body.payment?.transaction ?? '-'}  ` +
        `receipt=${body.receipt?.digest?.slice(0, 12) ?? '-'}`,
    );
  } else if (result.status === 409) {
    const body = result.body as { reason?: string; survived?: number; required?: number };
    tally.refused += 1;
    console.log(
      `${stamp}  #${n}  REFUSED   ${body.reason} (${body.survived}/${body.required} sources) — not charged, agent takes no action`,
    );
  } else {
    tally.failed += 1;
    const last = result.trace[result.trace.length - 1];
    console.log(`${stamp}  #${n}  ERROR     HTTP ${result.status} ${last?.detail ?? ''}`);
  }
}

function summarise(): void {
  console.log(
    `\nanswered ${tally.answered} · refused ${tally.refused} · errors ${tally.failed} · ` +
      `spent ${tally.spent} tinybar over ${tally.answered + tally.refused + tally.failed} ticks`,
  );
  if (tally.refused > 0) {
    console.log(`${tally.refused} refused tick(s) cost nothing and triggered no action.`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`\nautonomous buyer → ${url}`);
console.log(
  `interval ${intervalSeconds}s · ${maxTicks === Infinity ? 'ctrl-c to stop' : `${maxTicks} ticks then stop`}\n`,
);

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\nstopping after current tick…');
});

// Ticks run strictly one after another rather than on a timer. A paid read
// takes a few seconds, so an interval timer would let two settlements from the
// same buyer account overlap — and the point of this loop is to model a
// well-behaved agent, not to race itself.
for (let n = 1; n <= maxTicks && !stopping; n += 1) {
  await tick(n);
  if (n < maxTicks && !stopping) await sleep(intervalSeconds * 1000);
}

summarise();
