/**
 * Autonomous buyer that acts on proven rates.
 *
 * Wakes on an interval, pays for a read, and only then decides ENTER / HOLD.
 * REFUSED ticks correctly do nothing and pay nothing. On ENTER it pays a second
 * tighter-lag confirm read before signing an action intent.
 *
 *   npm run agent -- --interval 30 --ticks 10 --metric supplyAPY --asset USDC --threshold 3.5
 *
 * Bounded to 10 ticks by default because each answered tick may settle twice.
 * Pass --ticks 0 to run until interrupted. Pass --no-confirm to skip the second pay.
 */

import { config } from '../src/config.js';
import { runActTick } from '../src/agent-act.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const base = arg('base', `http://localhost:${config.port}`) as string;
const family = arg('family', 'aave-v3-ethereum') as string;
const metric = arg('metric', 'supplyAPY') as string;
const asset = arg('asset', 'USDC') as string;
const intervalSeconds = Number.parseInt(arg('interval', '30') as string, 10);
const threshold = Number.parseFloat(arg('threshold', '3.5') as string);
const confirm = !hasFlag('no-confirm');

const ticksArg = Number.parseInt(arg('ticks', '10') as string, 10);
const maxTicks = ticksArg === 0 ? Infinity : ticksArg;

const tally = {
  answered: 0,
  refused: 0,
  failed: 0,
  enter: 0,
  hold: 0,
  none: 0,
  spent: 0n,
};

async function tick(n: number): Promise<void> {
  const stamp = new Date().toISOString().slice(11, 19);
  const { read, confirm: conf, intent } = await runActTick({
    base,
    family,
    metric,
    asset,
    threshold,
    confirm,
  });

  const spend = (body: unknown): bigint => {
    const a = (body as { payment?: { amount?: string } } | undefined)?.payment?.amount;
    return BigInt(a ?? '0');
  };

  if (read.ok) {
    tally.answered += 1;
    tally.spent += spend(read.body);
    if (conf?.ok) tally.spent += spend(conf.body);
  } else if (read.status === 409) {
    tally.refused += 1;
  } else {
    tally.failed += 1;
  }

  if (intent.body.decision === 'ENTER') tally.enter += 1;
  else if (intent.body.decision === 'HOLD') tally.hold += 1;
  else tally.none += 1;

  const shown =
    intent.body.answerValue !== null && intent.body.answerValue !== undefined
      ? intent.body.answerValue.toFixed(4)
      : '-';

  console.log(
    `${stamp}  #${n}  ${intent.body.decision.padEnd(5)}  ${shown} ${intent.body.unit ?? ''} ` +
      `(threshold ${threshold})  intent=${intent.digest.slice(0, 12)}  ${intent.body.note}`,
  );
}

function summarise(): void {
  console.log(
    `\nanswered ${tally.answered} · refused ${tally.refused} · errors ${tally.failed} · ` +
      `ENTER ${tally.enter} · HOLD ${tally.hold} · NONE ${tally.none} · ` +
      `spent ${tally.spent} tinybar`,
  );
  if (tally.refused > 0) {
    console.log(`${tally.refused} refused tick(s) cost nothing and triggered no action.`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`\nautonomous acting buyer → ${family} ${metric} ${asset}`);
console.log(
  `threshold ${threshold} · confirm ${confirm ? 'on' : 'off'} · interval ${intervalSeconds}s · ` +
    `${maxTicks === Infinity ? 'ctrl-c to stop' : `${maxTicks} ticks then stop`}\n`,
);

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\nstopping after current tick…');
});

for (let n = 1; n <= maxTicks && !stopping; n += 1) {
  await tick(n);
  if (n < maxTicks && !stopping) await sleep(intervalSeconds * 1000);
}

summarise();
