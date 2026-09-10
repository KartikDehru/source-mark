'use strict';

(async () => {
  const [h, r, p] = await Promise.all([api('/health'), api('/v1/registry'), api('/v1/payouts')]);
  await bootNav();
  const HEALTH = h.body;
  const REGISTRY = r.body;
  const evidence = $('evidence');
  if (!evidence) return;

  if (!HEALTH) {
    evidence.innerHTML =
      '<div class="ev"><div class="k">service</div><div class="v">offline</div></div>';
    return;
  }

  const fams = (REGISTRY && REGISTRY.families) || [];
  const pinned = fams.reduce((sum, f) => sum + f.sources.filter((s) => s.pinned).length, 0);
  const ready = fams.filter((f) => f.ready).length;
  const routed = ((p.body && p.body.sources) || []).reduce(
    (sum, s) => sum + BigInt(s.earned || 0),
    0n,
  );
  const consented = HEALTH.consent
    ? HEALTH.consent.consented + '/' + HEALTH.consent.totalSources
    : '-';

  const cells = [
    ['price / read', hbar(HEALTH.x402 && HEALTH.x402.price), (HEALTH.x402 && HEALTH.x402.network) || ''],
    ['a refusal costs', '0 HBAR', 'verified, then deliberately unsettled', 'free'],
    ['pinned sources', String(pinned), ready + ' of ' + fams.length + ' families at quorum'],
    ['sources consented', consented, 'EIP-191 opt-in on file'],
    [
      'held back',
      HEALTH.split ? HEALTH.split.holdbackBps / 100 + '%' : '-',
      HEALTH.split
        ? 'unvested ' + duration(HEALTH.split.holdbackVestingSeconds) + ' | slashable'
        : '',
    ],
    ['routed to sources', hbar(routed.toString()), 'across every settled read'],
  ];

  evidence.innerHTML = cells
    .map(
      (c) =>
        '<div class="ev' +
        (c[3] ? ' ' + c[3] : '') +
        '"><div class="k">' +
        esc(c[0]) +
        '</div><div class="v">' +
        esc(c[1]) +
        '</div><div class="n">' +
        esc(c[2]) +
        '</div></div>',
    )
    .join('');
})();
