'use strict';

const ACTIONS = ['b402', 'bpay', 'bstale', 'bresale', 'bact'];

let HEALTH = null;
let REGISTRY = null;
let LAST_RECEIPT_DIGEST = null;

function busy(on, label) {
  ACTIONS.forEach((b) => { const el = $(b); if (el) el.disabled = on; });
  if (on) {
    const rsp = $('rsp');
    const result = $('result');
    if (rsp) rsp.innerHTML = '';
    if (result) result.innerHTML = '<div class="placeholder">' + esc(label) + '</div>';
  }
}

async function boot() {
  const healthP = api('/health');
  const registryP = api('/v1/registry');
  const payoutsP = api('/v1/payouts');

  const [h, r] = await Promise.all([healthP, registryP]);
  HEALTH = h.body;
  REGISTRY = r.body;

  if (!HEALTH) {
    $('navled').className = 'led bad';
    $('navnet').textContent = 'unreachable';
    const offline = $('evidence');
    if (offline) offline.innerHTML = '<div class="ev"><div class="k">service</div><div class="v">offline</div></div>';
    return;
  }

  $('navled').className = 'led up';
  $('navnet').textContent = (HEALTH.x402 && HEALTH.x402.network) || 'hedera testnet';
  renderFamilies();
  if ($('tabs')) loadTab('registry');

  const p = await payoutsP;
  renderEvidence(p.body);
}

/**
 * The hero strip.
 *
 * Every figure is read from the service at load rather than written into the
 * markup - a page that advertises verifiable reads should not be asserting its
 * own numbers.
 */
function renderEvidence(payouts) {
  const h = HEALTH;
  const fams = (REGISTRY && REGISTRY.families) || [];
  const pinned = fams.reduce((sum, f) => sum + f.sources.filter((s) => s.pinned).length, 0);
  const ready = fams.filter((f) => f.ready).length;
  const routed = ((payouts && payouts.sources) || []).reduce((sum, s) => sum + BigInt(s.earned || 0), 0n);

  const consented = h.consent
    ? h.consent.consented + '/' + h.consent.totalSources
    : '-';
  const cells = [
    ['price / read', hbar(h.x402 && h.x402.price), (h.x402 && h.x402.network) || ''],
    ['a refusal costs', '0 HBAR', 'verified, then deliberately unsettled', 'free'],
    ['pinned sources', String(pinned), ready + ' of ' + fams.length + ' families at quorum'],
    ['sources consented', consented, 'EIP-191 opt-in on file'],
    ['held back', h.split ? h.split.holdbackBps / 100 + '%' : '-',
      h.split ? 'unvested ' + duration(h.split.holdbackVestingSeconds) + ' | slashable' : ''],
    ['routed to sources', hbar(routed.toString()), 'across every settled read'],
  ];

  const ev = $('evidence');
  if (!ev) return;
  ev.innerHTML = cells.map((c) =>
    '<div class="ev' + (c[3] ? ' ' + c[3] : '') + '"><div class="k">' + esc(c[0]) + '</div>' +
    '<div class="v">' + esc(c[1]) + '</div>' +
    '<div class="n">' + esc(c[2]) + '</div></div>').join('');
}

function renderFamilies() {
  const fams = (REGISTRY && REGISTRY.families) || [];
  $('family').innerHTML = fams.map((f) =>
    '<option value="' + esc(f.family) + '">' + esc(f.family) + (f.ready ? '' : ' (unpinned)') + '</option>').join('');
  $('family').onchange = onFamilyChange;
  onFamilyChange();
}

function selectedFamily() {
  const name = $('family').value;
  return ((REGISTRY && REGISTRY.families) || []).find((f) => f.family === name) || null;
}

function onFamilyChange() {
  const f = selectedFamily();
  if (!f) return;
  $('metric').innerHTML = f.metrics.map((m) => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');

  // Comparability changes what a family's numbers mean, so it belongs next to
  // the query: `identical` sources disagreeing is a fault, `peer` sources
  // disagreeing is the market.
  $('qmeta').innerHTML = [
    tag('sources', f.sources.filter((s) => s.pinned).length + ' pinned', 'ok'),
    tag('quorum', f.policy.minSources, 'ok'),
    tag('max lag', f.policy.maxBlockLag + ' blk', 'ok'),
    tag('max age', f.policy.maxAgeSeconds + 's', 'ok'),
    tag('consent', (f.consentedSources || 0) + '/' + f.sources.length + ' opted in',
      f.consentedSources ? 'ok' : 'warn'),
    tag(f.comparability, f.comparability === 'identical'
      ? 'match within ' + ((f.agreementToleranceBps ?? 100) / 100) + '%'
      : 'spread expected', f.comparability === 'identical' ? 'ok' : 'warn'),
  ].join('');
  updateCurl();
}

function query() {
  return {
    family: $('family').value,
    metric: $('metric').value,
    asset: $('asset').value.trim() || undefined,
  };
}

function readPath(extra) {
  const q = query();
  const p = new URLSearchParams({ metric: q.metric });
  if (q.asset) p.set('asset', q.asset);
  if (extra) Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
  return '/v1/reads/' + encodeURIComponent(q.family) + '?' + p.toString();
}

function updateCurl() {
  const curlEl = $('curl');
  if (!curlEl) return;
  curlEl.textContent = 'curl -i "' + location.origin + readPath() + '"';
}
const metricEl = $('metric');
if (metricEl) metricEl.addEventListener('change', updateCurl);
const assetEl = $('asset');
if (assetEl) assetEl.addEventListener('input', updateCurl);

/* ── renderers ──────────────────────────────────────────────────────────── */

function traceList(trace) {
  if (!Array.isArray(trace) || !trace.length) return '';
  return '<ul class="trace">' + trace.map((s) =>
    '<li><span class="mark2 ' + (s.ok ? 'ok' : 'bad') + '">' + (s.ok ? 'OK' : 'X') + '</span>' +
    '<span class="name">' + esc(s.step) + '</span>' +
    '<span class="txt">' + esc(s.detail) + '</span></li>').join('') + '</ul>';
}

function answerCard(a) {
  if (!a) return '';
  let html = '<div class="answer"><span class="v">' + num(a.value) + '</span><span class="u">' + esc(a.unit) + '</span>' +
    '<span class="tags">' +
      tag('method', esc(a.method) + ' of ' + a.contributors) +
      (a.spreadBps !== null && a.spreadBps !== undefined ? tag('spread', a.spreadBps + ' bps') : '') +
      tag('sources', esc(a.comparability)) +
    '</span></div>';

  // On a peer family the headline summarises different protocols, so showing it
  // without the range it was drawn from would be false precision.
  if (a.range) {
    html += '<div class="banner hold"><strong>Range across sources</strong> - ' +
      num(a.range.min, 4) + ' ' + esc(a.unit) + ' (' + esc(a.range.minProtocol) + ') to ' +
      num(a.range.max, 4) + ' ' + esc(a.unit) + ' (' + esc(a.range.maxProtocol) + ')' +
      (a.caveat ? '<span class="s">' + esc(a.caveat) + '</span>' : '') + '</div>';
  }
  return html;
}

function graphExplorerUrl(deploymentId) {
  return 'https://thegraph.com/explorer?search=' + encodeURIComponent(deploymentId || '');
}

function blockExplorerUrl(chainId, block) {
  if (block === null || block === undefined || block === '') return null;
  if (Number(chainId) === 1) return 'https://etherscan.io/block/' + block;
  return null;
}

function hederaAccountUrl(payer) {
  if (!payer || !/^0\.0\.\d+$/.test(String(payer))) return null;
  return 'https://hashscan.io/testnet/account/' + encodeURIComponent(payer);
}

function sourcesTable(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  const rows = sources.map((s) => {
    const okRow = s.status === 'OK';
    const note = okRow ? 'within policy' : (s.why || '') + (s.detail ? ' - ' + s.detail : '');
    const depUrl = s.deploymentId ? graphExplorerUrl(s.deploymentId) : null;
    const blkUrl = blockExplorerUrl(s.chainId, s.block);
    return '<tr>' +
      '<td class="' + (okRow ? 'st-ok' : 'st-no') + '">' + esc(s.status) + '</td>' +
      '<td>' + esc(s.protocol) + '</td>' +
      '<td class="faint" title="' + esc(s.deploymentId) + '">' +
        (depUrl
          ? '<a href="' + esc(depUrl) + '" target="_blank" rel="noopener">' + esc(short(s.deploymentId, 12, 5)) + '</a>'
          : esc(short(s.deploymentId, 12, 5))) +
      '</td>' +
      '<td class="num">' +
        (blkUrl
          ? '<a href="' + esc(blkUrl) + '" target="_blank" rel="noopener">' + (s.block ?? '-') + '</a>'
          : (s.block ?? '-')) +
      '</td>' +
      '<td class="num ' + (s.blockLag === 0 ? 'ok' : '') + '">' + (s.blockLag ?? '-') + '</td>' +
      '<td class="num">' + (s.ageSeconds !== null && s.ageSeconds !== undefined ? s.ageSeconds + 's' : '-') + '</td>' +
      '<td class="num">' + num(s.value) + '</td>' +
      '<td class="num faint">' + (s.weightUSD ? '$' + num(s.weightUSD, 4) : '-') + '</td>' +
      '<td class="num faint">' + (s.latencyMs !== undefined ? s.latencyMs + 'ms' : '-') + '</td>' +
      '<td class="wrap">' + esc(note) + '</td>' +
      '</tr>';
  }).join('');
  return '<div class="tbl"><table><thead><tr>' +
    '<th>status</th><th>protocol</th><th>pinned deployment</th><th class="num">block</th>' +
    '<th class="num">lag</th><th class="num">age</th><th class="num">value</th>' +
    '<th class="num">market tvl</th><th class="num">latency</th><th>note</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function paymentBanner(p) {
  if (!p) return '';
  if (p.channel === 'resale') {
    return '<div class="banner info"><strong>Billed upstream by ' + esc(p.via) + '</strong> - priced at ' +
      hbar(p.amount) + ' here, but collected by ' + esc(p.via) + ' in its own currency on its own chain.' +
      '<span class="s">' + esc(p.note || '') + '</span></div>';
  }
  if (p.transaction) {
    const payerUrl = hederaAccountUrl(p.payer);
    return '<div class="banner good"><strong>Settled ' + hbar(p.amount) + '</strong> on ' + esc(p.network) +
      (p.payer
        ? ' from ' + (payerUrl
          ? '<a href="' + esc(payerUrl) + '" target="_blank" rel="noopener"><code>' + esc(p.payer) + '</code></a>'
          : '<code>' + esc(p.payer) + '</code>')
        : '') +
      (p.explorer ? ' - <a href="' + esc(p.explorer) + '" target="_blank" rel="noopener">payment on HashScan</a>' : '') +
      '<span class="s">Money moved only after the read passed the policy, never before.</span></div>';
  }
  if (p.mode === 'free') {
    return '<div class="banner info">PAYMENT_MODE=free - the read layer without the paywall.</div>';
  }
  return '';
}

function receiptBox(r) {
  if (!r || !r.digest) return '';
  LAST_RECEIPT_DIGEST = r.digest;
  const anchors = (r.body && r.body.sources) || [];
  const chainLinks = anchors.slice(0, 3).map((s) => {
    const g = graphExplorerUrl(s.deploymentId);
    const b = blockExplorerUrl(s.chainId, s.block);
    return '<span class="s">| <a href="' + esc(g) + '" target="_blank" rel="noopener">' + esc(s.protocol) + ' on The Graph</a>' +
      (b ? ' | <a href="' + esc(b) + '" target="_blank" rel="noopener">block ' + s.block + '</a>' : '') + '</span>';
  }).join('');
  return '<div class="banner hold"><strong>Signed receipt</strong> <code>' + esc(short(r.digest, 18, 8)) + '</code>' +
    (r.signer ? '<span class="s">Signed by <code>' + esc(r.signer) + '</code> over the answer, every source, its block, and the policy that admitted it.</span>' : '') +
    (r.hcs
      ? '<span class="s">Anchored on HCS topic <code>' + esc(r.hcs.topicId) + '</code> | seq ' +
        r.hcs.sequenceNumber +
        ' - <a href="' + esc(r.hcs.explorer) + '" target="_blank" rel="noopener">submit tx on HashScan</a>' +
        ' | <a href="' + esc(r.hcs.mirror) + '" target="_blank" rel="noopener">mirror message</a></span>'
      : '') +
    (chainLinks || '') +
    '<div class="btnrow">' +
      '<button class="ghost sm" onclick="verifyReceipt(\'' + esc(r.digest) + '\')">Verify signature &amp; digest</button>' +
      '<button class="ghost sm" onclick="disputeReceipt(\'' + esc(r.digest) + '\')">Challenge | re-derive vs Graph</button>' +
      '<button class="ghost sm" onclick="disputeFalsified(\'' + esc(r.digest) + '\')">Demo slash | falsified twin</button>' +
    '</div></div>';
}

/* The split is what distinguishes this from a subgraph behind a paywall, so it
   gets its own block rather than living in the raw JSON. */
function payoutBox(payout) {
  if (!payout || !payout.shares || !payout.shares.length) return '';

  const rows = payout.shares.map((s) =>
    '<tr><td>' + esc(s.protocol) + '</td>' +
    '<td class="num">' + hbar(s.amount) + '</td>' +
    '<td class="num ok">' + hbar(s.vested) + '</td>' +
    '<td class="num warn">' + hbar(s.heldBack) + '</td>' +
    payee(s.payoutAddress) + '</tr>').join('');

  const c = HEALTH && HEALTH.consent;
  const consentLine = c && c.consented
    ? c.consented + '/' + c.totalSources + ' registry sources have EIP-191 consent on file. Payees are dedicated demo source operators (DEMO_SOURCE_MNEMONIC) - not the gateway operator, and not real indexer production keys.'
    : 'No EIP-191 consents on file yet - addresses remain unclaimed.';

  let html = '<div class="block"><div class="blockhead">Revenue split <span>| ' +
    hbar(payout.gross) + ' gross | ' + hbar(payout.routingFee) + ' routing fee (' +
    (payout.routingFeeBps / 100) + '%) | ' + (payout.holdbackBps / 100) + '% held back for ' +
    duration(payout.holdbackVestingSeconds) +
    (Number(payout.dust) ? ' | ' + payout.dust + ' tinybar dust to operator' : '') + '</span></div>' +
    '<div class="tbl"><table><thead><tr><th>source</th><th class="num">earned</th>' +
    '<th class="num">cleared</th><th class="num">held back</th><th>payee</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  if (payout.onchain && payout.onchain.transaction) {
    const contractUrl = HEALTH && HEALTH.split && HEALTH.split.explorer
      ? HEALTH.split.explorer
      : null;
    html += '<div class="banner good"><strong>Split recorded onchain</strong> in <code>SourcePayouts</code> - ' +
      '<a href="' + esc(payout.onchain.explorer) + '" target="_blank" rel="noopener">split tx on HashScan</a>' +
      (contractUrl
        ? ' | <a href="' + esc(contractUrl) + '" target="_blank" rel="noopener">contract</a>'
        : '') +
      '<span class="s">The held-back slice is unvested and slashable if this receipt is later disproved. ' +
      esc(consentLine) + '</span></div>';
  } else {
    html += '<div class="banner hold">Recorded in the local ledger only (<code>SPLIT_MODE=ledger</code>). ' +
      'Set <code>SPLIT_MODE=onchain</code> to have the contract enforce this.' +
      '<span class="s">' + esc(consentLine) + '</span></div>';
  }
  return html + '</div>';
}

function refusalBox(b) {
  return '<div class="banner hold"><strong>409 REFUSED - ' + esc(b.reason) + '</strong>' +
    '<span class="s">' + esc(b.detail || '') + '</span>' +
    (b.survived !== undefined ? '<span class="s">' + b.survived + ' of ' + b.required +
      ' required sources satisfied the policy.</span>' : '') +
    '<span class="s"><strong>' + esc(b.note || '') + '</strong></span></div>' + sourcesTable(b.sources);
}

/**
 * A refusal by the *demo harness* rather than by the gate.
 *
 * These have to read differently from a 409: a rate limit says nothing about
 * the data, and a reader who has just been told refusals are meaningful should
 * not have to wonder which kind of "no" this was.
 */
function harnessError(status, body) {
  const b = body || {};
  const wait = b.retryAfterMs ? Math.ceil(b.retryAfterMs / 1000) + 's' : null;
  return '<div class="banner err"><strong>' + esc(b.error || 'HTTP ' + status) + '</strong>' +
    '<span class="s">' + esc(b.detail || '') + '</span>' +
    (wait ? '<span class="s">Try again in about ' + wait + '.</span>' : '') +
    (b.hint ? '<span class="s">' + esc(b.hint) + '</span>' : '') +
    (status === 429
      ? '<span class="s">This is the demo harness protecting its own funds, not the provenance gate refusing a read.</span>'
      : '') + '</div>';
}

function statusPill(status) {
  const state = status === 200 ? 'ok' : status === 402 || status === 409 ? 'warn' : 'bad';
  return '<span class="tag"><span class="led ' + state + '"></span>http <b>' + status + '</b></span>';
}

function answerView(b) {
  return answerCard(b.answer) + sourcesTable(b.sources) + paymentBanner(b.payment) +
         receiptBox(b.receipt) + payoutBox(b.payout);
}

/* ── the four actions ───────────────────────────────────────────────────── */

if ($('b402')) if ($('b402')) $('b402').onclick = async () => {
  busy(true, 'requesting a read with no payment attached...');
  try {
    const r = await api(readPath());
    $('rsp').innerHTML = statusPill(r.status);
    const req = (r.body && r.body.accepts && r.body.accepts[0]) || null;
    let html = r.status === 402
      ? '<div class="banner good"><strong>402 Payment Required</strong> - the paywall is real, and it told you exactly how to satisfy it.' +
        (req ? '<span class="s">' + hbar(req.amount) + ' on <code>' + esc(req.network) + '</code> to <code>' +
          esc(req.payTo) + '</code> | scheme <code>' + esc(req.scheme) + '</code></span>' : '') +
        '<span class="s">No API key, no account, no signup - the challenge itself is the onboarding.</span></div>'
      : '<div class="banner err">HTTP ' + r.status + ' - expected 402 here.</div>';
    if (r.body && r.body.policy) {
      html += '<div class="banner info">The challenge also carries the policy it will be judged against: quorum <strong>' +
        r.body.policy.minSources + '</strong>, max lag <strong>' + r.body.policy.maxBlockLag +
        '</strong> blocks, max age <strong>' + r.body.policy.maxAgeSeconds + '</strong>s.</div>';
    }
    $('result').innerHTML = html + raw(r.body, 'raw 402 challenge');
  } catch (e) {
    $('result').innerHTML = '<div class="banner err">' + esc(e.message) + '</div>';
  }
  busy(false);
};

async function runAgent(strictAge) {
  busy(true, strictAge !== undefined
    ? 'paying, then demanding freshness no source can meet...'
    : 'agent is taking a 402, signing a Hedera transfer, and retrying...');
  try {
    const q = query();
    if (strictAge !== undefined) q.strictAge = strictAge;
    const r = await api('/demo/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(q),
    });
    const run = r.body || {};
    if (r.status !== 200) {
      $('rsp').innerHTML = statusPill(r.status);
      $('result').innerHTML = harnessError(r.status, run);
      busy(false);
      return;
    }
    $('rsp').innerHTML = statusPill(run.status);
    let html = traceList(run.trace);
    if (run.status === 409) html += refusalBox(run.body || {});
    else if (run.body && run.body.answer) html += answerView(run.body);
    else if (run.body) html += '<div class="banner err">HTTP ' + run.status + ' - ' + esc(run.body.error || 'unexpected') +
      '<span class="s">' + esc(run.body.detail || run.body.note || '') + '</span></div>';
    $('result').innerHTML = html + raw(run.body ?? run.challenge, 'raw response body');
  } catch (e) {
    $('result').innerHTML = '<div class="banner err">' + esc(e.message) + '</div>';
  }
  busy(false);
}

if ($('bpay')) if ($('bpay')) $('bpay').onclick = () => runAgent(undefined);
if ($('bstale')) if ($('bstale')) $('bstale').onclick = () => runAgent(1);

if ($('bact')) if ($('bact')) $('bact').onclick = async () => {
  const threshold = Number.parseFloat(($('threshold') && $('threshold').value) || '3.5');
  busy(true, 'acting agent: pay -> decide -> confirm -> sign intent...');
  try {
    const q = query();
    q.threshold = Number.isFinite(threshold) ? threshold : 3.5;
    q.confirm = true;
    const r = await api('/demo/run-act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(q),
    });
    const run = r.body || {};
    if (r.status !== 200) {
      $('rsp').innerHTML = statusPill(r.status);
      $('result').innerHTML = harnessError(r.status, run);
      busy(false);
      return;
    }
    const intent = run.intent || {};
    const body = intent.body || {};
    const decision = body.decision || 'NONE';
    const banner =
      decision === 'ENTER' ? 'good' : decision === 'HOLD' ? 'hold' : 'info';
    $('rsp').innerHTML = statusPill(run.read && run.read.status);
    let html = traceList((run.read && run.read.trace) || []);
    if (run.read && run.read.status === 409) html += refusalBox(run.read.body || {});
    else if (run.read && run.read.body && run.read.body.answer) html += answerView(run.read.body);
    html +=
      '<div class="banner ' + banner + '"><strong>Action intent | ' + esc(decision) + '</strong>' +
      '<span class="s">' + esc(body.note || '') + '</span>' +
      '<span class="s">threshold <code>' + esc(body.threshold) + '</code>' +
      (body.answerValue != null ? ' | answer <code>' + num(body.answerValue) + '</code>' : '') +
      (body.confirmValue != null ? ' | confirm <code>' + num(body.confirmValue) + '</code>' : '') +
      (body.confirmed ? ' | confirmed' : '') + '</span>' +
      '<span class="s">intent digest <code>' + esc(short(intent.digest, 14, 8)) + '</code>' +
      (intent.signer ? ' | signer <code>' + esc(short(intent.signer, 10, 6)) + '</code>' : ' | unsigned') +
      '</span></div>';
    if (run.confirm && run.confirm.status === 409) {
      html += '<div class="banner hold"><strong>Confirm read refused</strong><span class="s">Second look failed the policy - no ENTER.</span></div>';
    }
    $('result').innerHTML = html + raw({ intent, read: run.read && run.read.body, confirm: run.confirm && run.confirm.body }, 'acting agent');
    if (currentTab === 'intents') loadTab('intents');
  } catch (e) {
    $('result').innerHTML = '<div class="banner err">' + esc(e.message) + '</div>';
  }
  busy(false);
};

if ($('bresale')) if ($('bresale')) $('bresale').onclick = async () => {
  busy(true, 'calling the gate the way the Bazantic gateway does...');
  try {
    const r = await api('/demo/resale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(query()),
    });
    const run = r.body || {};
    if (r.status !== 200) {
      $('rsp').innerHTML = statusPill(r.status);
      $('result').innerHTML = harnessError(r.status, run);
      busy(false);
      return;
    }
    $('rsp').innerHTML = statusPill(run.status);

    // Be exact about what this proves. It is the same credential check, gate and
    // split that Bazantic's gateway hits - but the request did not traverse
    // their gateway, so it does not prove they billed anybody.
    let html = '<div class="banner info"><strong>Requested with the shared resale credential, server-side</strong>' +
      '<span class="s">The browser cannot hold this secret - publishing it would publish the bypass - so the demo ' +
      'presents it from the server. Identical credential check, provenance gate, refusal rule and onchain split to a ' +
      'request arriving through <code>' + esc(run.via || 'the reseller') + '</code>. What it does not exercise is their ' +
      'billing leg, which runs against the public URL.</span></div>';

    if (run.status === 409) html += refusalBox(run.body || {});
    else if (run.body && run.body.answer) html += answerView(run.body);
    else html += '<div class="banner err">HTTP ' + run.status + ' - ' +
      esc((run.body && (run.body.error || run.body.detail)) || 'unexpected') + '</div>';
    $('result').innerHTML = html + raw(run.body, 'raw response body');
  } catch (e) {
    $('result').innerHTML = '<div class="banner err">' + esc(e.message) + '</div>';
  }
  busy(false);
};

/* ── receipts and disputes ──────────────────────────────────────────────── */

window.verifyReceipt = async function (digest) {
  LAST_RECEIPT_DIGEST = digest;
  const r = await api('/v1/receipts/' + encodeURIComponent(digest));
  if (!r.ok) {
    $('result').insertAdjacentHTML('beforeend',
      '<div class="banner err">Receipt not found: <code>' + esc(digest) + '</code></div>');
    return;
  }
  const rec = r.body.receipt;
  const v = r.body.verification || {};
  const hv = r.body.hcsVerification || null;
  const sigOk = v.signatureValid === true;
  const digestOk = v.digestMatches === true;
  const allOk = sigOk && digestOk;
  const bannerClass = allOk ? 'good' : (v.signatureValid === null && digestOk ? 'hold' : 'err');
  const headline = allOk
    ? 'OK Signature valid | digest matches'
    : v.signatureValid === null
      ? (digestOk ? 'Digest matches | receipt was unsigned' : 'X Digest mismatch')
      : 'X Verification failed';

  $('result').insertAdjacentHTML('beforeend',
    '<div class="block" id="verify-panel"><div class="blockhead">Cryptographic check <span>| GET /v1/receipts/' +
      esc(short(digest, 10, 6)) + '</span></div>' +
    '<div class="banner ' + bannerClass + '"><strong>' + headline + '</strong>' +
    '<span class="s">Body digest ' + (digestOk ? 'matches' : 'does not match') +
      ' <code>' + esc(short(v.recomputedDigest || rec.digest, 14, 8)) + '</code></span>' +
    '<span class="s">EIP-191 signature: ' +
      (v.signatureValid === true ? 'valid' : v.signatureValid === false ? 'invalid' : 'absent') +
      (v.recoveredSigner ? ' | recovered <code>' + esc(v.recoveredSigner) + '</code>' : '') +
      (v.claimedSigner ? ' | claimed <code>' + esc(v.claimedSigner) + '</code>' : '') + '</span>' +
    '<span class="s">Answer hash <code>' + esc(short(rec.body.answerHash || '-', 14, 8)) + '</code> | ' +
    (rec.body.sources || []).length + ' sources pinned at their answering block.</span></div>' +
    (rec.hcs
      ? '<div class="banner ' + (hv && hv.ok ? 'good' : 'hold') + '"><strong>' +
        (hv && hv.ok ? 'OK HCS mirror confirms digest' : 'HCS anchor') + '</strong>' +
        '<span class="s">Topic <code>' + esc(rec.hcs.topicId) + '</code> | sequence ' + rec.hcs.sequenceNumber +
        (rec.hcs.consensusTimestamp ? ' | consensus ' + esc(rec.hcs.consensusTimestamp) : '') + '</span>' +
        '<span class="s"><a href="' + esc(rec.hcs.explorer) + '" target="_blank" rel="noopener">HashScan tx</a> | ' +
        '<a href="' + esc(rec.hcs.mirror) + '" target="_blank" rel="noopener">mirror message</a>' +
        (hv && hv.detail ? ' - ' + esc(hv.detail) : '') + '</span></div>'
      : '<div class="banner hold"><strong>No HCS anchor</strong><span class="s">' +
        esc((hv && hv.detail) || 'This receipt was not published to a consensus topic.') + '</span></div>') +
    '<div class="banner info"><strong>How anyone re-checks it</strong>' +
    (r.body.howToVerify || []).map((s) => '<span class="s">| ' + esc(s) + '</span>').join('') + '</div>' +
    '<div class="btnrow">' +
      '<button class="ghost sm" onclick="disputeReceipt(\'' + esc(digest) + '\')">Challenge | re-derive vs Graph</button>' +
      '<button class="ghost sm" onclick="disputeFalsified(\'' + esc(digest) + '\')">Demo slash | arbiter</button>' +
      '<button class="ghost sm" onclick="disputeFalsifiedDeadline(\'' + esc(digest) + '\')">Demo slash | open + wait for deadline</button>' +
    '</div>' +
    raw(r.body, 'full signed receipt + verification') + '</div>');
  const panel = $('verify-panel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.disputeReceipt = async function (digest, preferDeadline) {
  const target = digest || LAST_RECEIPT_DIGEST;
  if (!target) {
    $('result').insertAdjacentHTML('beforeend',
      '<div class="banner err">No receipt to challenge yet - run a paid read first.</div>');
    return;
  }
  LAST_RECEIPT_DIGEST = target;
  const r = await api('/v1/disputes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      digest: target,
      claimant: 'demo-page',
      reason: preferDeadline
        ? 'demo: open onchain and leave ruling to resolveAfterDeadline after silence'
        : 'demo: re-derive this receipt against live Graph data at the recorded blocks',
      preferDeadline: Boolean(preferDeadline),
    }),
  });
  if (!r.ok) {
    $('result').insertAdjacentHTML('beforeend',
      '<div class="banner err">Dispute failed: ' + esc((r.body && r.body.detail) || r.status) + '</div>');
    return;
  }
  const d = r.body.dispute;
  const repro = r.body.reproduction;
  const onchain = r.body.onchain || (d && d.onchain);
  const status = d.status;
  const banner =
    status === 'UPHELD' ? 'err' : status === 'REJECTED' ? 'good' : 'hold';
  const headline =
    status === 'UPHELD'
      ? hbar(d.refunded) + ' refunded - re-derive MISMATCH, holdback slashed'
      : status === 'REJECTED'
        ? 'OK Receipt reproduced - dispute rejected, no slash'
        : 'Ambiguous - could not fully re-derive, no slash';

  let deadlineBtn = '';
  if (onchain && onchain.resolveMode === 'open-only' && onchain.deadlineAt) {
    deadlineBtn =
      '<div class="btnrow"><button class="ghost sm" onclick="resolveDeadline(\'' +
      esc(target) +
      '\')">Resolve after deadline | resolveAfterDeadline</button>' +
      '<span class="s">opens ' + esc(new Date(onchain.deadlineAt * 1000).toISOString()) + '</span></div>';
  }

  $('result').insertAdjacentHTML('beforeend',
    '<div class="block" id="dispute-panel"><div class="blockhead">Dispute | re-derive <span>| POST /v1/disputes</span></div>' +
    '<div class="banner ' + banner + '"><strong>' + headline + '</strong>' +
    '<span class="s">Receipt <code>' + esc(short(target, 14, 8)) + '</code> | decision <code>' +
      esc(d.decision || 'reproduce') + '</code></span>' +
    (repro ? '<span class="s">' + esc(repro.detail) + '</span>' : '') +
    (repro && repro.expectedAnswerHash
      ? '<span class="s">expected <code>' + esc(short(repro.expectedAnswerHash, 14, 8)) + '</code>' +
        (repro.recomputedAnswerHash
          ? ' | recomputed <code>' + esc(short(repro.recomputedAnswerHash, 14, 8)) + '</code>'
          : '') + '</span>'
      : '') +
    (onchain
      ? '<span class="s">Onchain: ' + esc(onchain.detail) +
        (onchain.openExplorer
          ? ' - <a href="' + esc(onchain.openExplorer) + '" target="_blank" rel="noopener">openDispute</a>'
          : '') +
        (onchain.resolveExplorer
          ? ' | <a href="' + esc(onchain.resolveExplorer) + '" target="_blank" rel="noopener">resolve</a>'
          : '') + '</span>'
      : '') +
    '<span class="s">' + esc(r.body.note || '') + '</span></div>' +
    deadlineBtn +
    raw(r.body, 'raw dispute + reproduction') + '</div>');
  const panel = $('dispute-panel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (currentTab === 'payouts' || currentTab === 'disputes') loadTab(currentTab);
};

window.disputeFalsified = async function (digest, preferDeadline) {
  const target = digest || LAST_RECEIPT_DIGEST;
  if (!target) {
    $('result').insertAdjacentHTML('beforeend',
      '<div class="banner err">No receipt to falsify - run a paid read first.</div>');
    return;
  }
  const fake = await api('/demo/falsify-receipt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ digest: target }),
  });
  if (!fake.ok) {
    $('result').insertAdjacentHTML('beforeend',
      '<div class="banner err">Falsify failed: ' + esc((fake.body && fake.body.detail) || fake.status) + '</div>');
    return;
  }
  $('result').insertAdjacentHTML('beforeend',
    '<div class="banner hold"><strong>Falsified twin stored</strong>' +
    '<span class="s">Corrupted answerHash on purpose. Challenging <code>' +
    esc(short(fake.body.falsifiedDigest, 14, 8)) + '</code>' +
    (preferDeadline ? ' (open only - resolveAfterDeadline after silence)...' : '...') +
    '</span></div>');
  await window.disputeReceipt(fake.body.falsifiedDigest, preferDeadline);
};

window.disputeFalsifiedDeadline = function (digest) {
  return window.disputeFalsified(digest, true);
};

window.resolveDeadline = async function (digest) {
  const target = digest || LAST_RECEIPT_DIGEST;
  if (!target) return;
  const r = await api('/v1/disputes/resolve-deadline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ digest: target }),
  });
  const onchain = r.body && r.body.onchain;
  $('result').insertAdjacentHTML('beforeend',
    '<div class="block"><div class="blockhead">resolveAfterDeadline <span>| POST /v1/disputes/resolve-deadline</span></div>' +
    '<div class="banner ' + (r.ok ? 'good' : 'hold') + '"><strong>' +
      esc((onchain && onchain.detail) || ('HTTP ' + r.status)) + '</strong>' +
    (onchain && onchain.resolveExplorer
      ? '<span class="s"><a href="' + esc(onchain.resolveExplorer) + '" target="_blank" rel="noopener">HashScan</a></span>'
      : '') +
    '</div>' + raw(r.body, 'deadline resolve') + '</div>');
};

/* ── explorer tabs ──────────────────────────────────────────────────────── */

let currentTab = 'registry';

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) loadTab(btn.dataset.tab);
});

async function loadTab(name) {
  currentTab = name;
  [...document.querySelectorAll('.tab')].forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $('tabbody').innerHTML = '<div class="placeholder">loading...</div>';
  try {
    $('tabbody').innerHTML = await TABS[name]();
  } catch (e) {
    $('tabbody').innerHTML = '<div class="banner err">' + esc(e.message) + '</div>';
  }
}

const TABS = {
  async registry() {
    const r = await api('/v1/registry');
    const b = r.body;
    let html = '<div class="banner info">' + esc(b.note || '') +
      '<span class="s"><strong>' + esc(b.howToExtend) + '</strong></span></div>';

    for (const f of b.families) {
      const rows = f.sources.map((s) =>
        '<tr><td>' + esc(s.protocol) + '</td><td class="num faint">' + s.chainId + '</td>' +
        '<td class="' + (s.pinned ? 'dim' : 'bad') + '" title="' + esc(s.id) + '">' + esc(short(s.id, 20, 6)) + '</td>' +
        '<td class="' + (s.pinned ? 'st-ok' : 'st-no') + '">' + (s.pinned ? 'pinned' : 'UNPINNED') + '</td>' +
        '<td class="' + (s.consent === 'consented' ? 'st-ok' : 'st-no') + '">' + esc(s.consent || 'pending') + '</td></tr>').join('');

      html += '<div class="block"><div class="blockhead"><b>' + esc(f.family) +
        '</b> <span>| ' + esc(f.label) + '</span></div>' +
        '<div class="qmeta" style="justify-content:flex-start;margin:0 0 14px">' +
          tag('status', f.ready ? 'ready' : 'below quorum', f.ready ? 'ok' : 'bad') +
          tag('comparability', esc(f.comparability), f.comparability === 'identical' ? 'ok' : 'warn') +
          tag('consent', (f.consentedSources || 0) + '/' + f.sources.length, f.consentedSources ? 'ok' : 'warn') +
          tag('quorum', f.policy.minSources, 'ok') +
          tag('metrics', esc(f.metrics.join(', ')), 'ok') +
          (f.schemaIpfsHash ? tag('schema hash', esc(short(f.schemaIpfsHash, 10, 6)), 'ok') : '') +
        '</div>' +
        (f.comparabilityNote ? '<div class="banner info">' + esc(f.comparabilityNote) + '</div>' : '') +
        '<div class="tbl"><table><thead><tr><th>protocol</th><th class="num">chain</th>' +
        '<th>deployment id</th><th>state</th><th>consent</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }
    return html + raw(b, 'GET /v1/registry');
  },

  async policy() {
    const fam = $('family').value;
    const r = await api('/v1/policy/' + encodeURIComponent(fam));
    const b = r.body;
    if (!r.ok) return '<div class="banner err">' + esc(b && b.error) + '</div>';

    const metrics = Object.entries(b.metrics).map(([name, spec]) =>
      '<tr><td>' + esc(name) + '</td><td>' + esc(spec.unit) + '</td><td>' + esc(spec.kind) + '</td>' +
      '<td class="faint">' + esc(spec.field || [spec.side, spec.type].filter(Boolean).join(' | ')) + '</td></tr>').join('');

    return '<div class="banner info"><strong>' + esc(b.label) + '</strong>' +
      '<span class="s">Schema <code>' + esc(b.schema) + '</code>' +
      (b.schemaUrl ? ' - <a href="' + esc(b.schemaUrl) + '" target="_blank" rel="noopener">read it</a>' : '') + '</span>' +
      '<span class="s">Showing the family selected in the console above. A caller may tighten any bound below; ' +
      'nothing a caller sends can loosen one.</span></div>' +
      '<div class="qmeta" style="justify-content:flex-start;margin:0 0 14px">' +
        tag('max block lag', b.policy.maxBlockLag, 'ok') +
        tag('max age', b.policy.maxAgeSeconds + 's', 'ok') +
        tag('min sources', b.policy.minSources, 'ok') +
        tag('registered sources', b.sources, 'ok') +
      '</div>' +
      '<div class="tbl"><table><thead><tr><th>metric</th><th>unit</th><th>kind</th><th>derived from</th>' +
      '</tr></thead><tbody>' + metrics + '</tbody></table></div>' + raw(b, 'GET /v1/policy/' + fam);
  },

  async payouts() {
    const r = await api('/v1/payouts');
    const b = r.body;
    if (!b.sources || !b.sources.length) {
      return '<div class="banner info"><strong>No settled reads yet</strong>' +
        '<span class="s">Run the buying agent in the console above. Each paid read credits the sources that ' +
        'answered it, and this table fills in.</span></div>';
    }
    const rows = b.sources.map((s) =>
      '<tr><td>' + esc(s.protocol) + '</td><td class="num">' + s.reads + '</td>' +
      '<td class="num">' + hbar(s.earned) + '</td>' +
      '<td class="num ok">' + hbar(s.vested) + '</td>' +
      '<td class="num warn">' + hbar(s.unvestedHoldback) + '</td>' +
      '<td class="num ' + (Number(s.slashed) ? 'bad' : 'faint') + '">' + hbar(s.slashed) + '</td>' +
      payee(s.payoutAddress) + '</tr>').join('');

    return '<div class="qmeta" style="justify-content:flex-start;margin:0 0 14px">' +
        tag('mode', esc(b.mode), b.mode === 'onchain' ? 'ok' : 'warn') +
        tag('routing fee', (b.routingFeeBps / 100) + '%', 'ok') +
        tag('holdback', (b.holdbackBps / 100) + '%', 'ok') +
        tag('vesting', duration(b.holdbackVestingSeconds), 'ok') +
      '</div>' +
      '<div class="tbl"><table><thead><tr><th>source</th><th class="num">reads</th><th class="num">earned</th>' +
      '<th class="num">cleared</th><th class="num">slashable</th><th class="num">slashed</th><th>payee</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="banner hold">' + esc(b.note) + '</div>' + raw(b, 'GET /v1/payouts');
  },

  async disputes() {
    const r = await api('/v1/disputes');
    const list = (r.body && r.body.disputes) || [];
    if (!list.length) {
      return '<div class="banner info"><strong>No disputes filed</strong>' +
        '<span class="s">Pay for a read, then <strong>Challenge | re-derive vs Graph</strong> (honest receipt -> REJECTED) ' +
        'or <strong>Demo slash | falsified twin</strong> (corrupted answerHash -> UPHELD + slash).</span></div>';
    }
    const rows = list.map((d) =>
      '<tr><td class="faint">' + new Date(d.ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + '</td>' +
      '<td class="faint" title="' + esc(d.digest) + '">' + esc(short(d.digest, 10, 6)) + '</td>' +
      '<td>' + esc(d.claimant) + '</td>' +
      '<td class="' + (d.status === 'UPHELD' ? 'st-no' : d.status === 'REJECTED' ? 'st-ok' : 'dim') + '">' +
        esc(d.status) + (d.decision ? ' | ' + esc(d.decision) : '') + '</td>' +
      '<td class="num">' + hbar(d.refunded) + '</td>' +
      '<td class="num faint">' + d.chargedTo.length + '</td>' +
      '<td class="wrap">' + esc(d.reason) + '</td></tr>').join('');
    return '<div class="tbl"><table><thead><tr><th>filed</th><th>receipt</th><th>claimant</th><th>status</th>' +
      '<th class="num">refunded</th><th class="num">sources charged</th><th>reason</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' + raw(r.body, 'GET /v1/disputes');
  },

  async intents() {
    const r = await api('/v1/agent-intents');
    const list = (r.body && r.body.intents) || [];
    if (!list.length) {
      return '<div class="banner info"><strong>No action intents yet</strong>' +
        '<span class="s">Run <strong>05 | Act on a proven rate</strong>. ENTER requires a paid read that clears the threshold and a confirm read; REFUSED never acts.</span></div>';
    }
    const rows = list.map((i) => {
      const b = i.body || {};
      return '<tr><td class="faint">' + (b.at ? new Date(b.at * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-') + '</td>' +
        '<td class="' + (b.decision === 'ENTER' ? 'st-ok' : b.decision === 'HOLD' ? 'dim' : 'st-no') + '">' + esc(b.decision) + '</td>' +
        '<td class="num">' + (b.answerValue != null ? num(b.answerValue) : '-') + '</td>' +
        '<td class="num">' + esc(b.threshold) + '</td>' +
        '<td>' + (b.confirmed ? 'yes' : 'no') + '</td>' +
        '<td class="faint" title="' + esc(i.digest) + '">' + esc(short(i.digest, 10, 6)) + '</td>' +
        '<td class="wrap">' + esc(b.note) + '</td></tr>';
    }).join('');
    return '<div class="banner info">' + esc(r.body.note || '') + '</div>' +
      '<div class="tbl"><table><thead><tr><th>at</th><th>decision</th><th class="num">answer</th><th class="num">threshold</th>' +
      '<th>confirmed</th><th>intent</th><th>note</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      raw(r.body, 'GET /v1/agent-intents');
  },

  async health() {
    const r = await api('/health');
    const h = r.body;
    const warn = (h.warnings || []).length
      ? '<div class="banner hold"><strong>Configuration warnings</strong>' +
        h.warnings.map((w) => '<span class="s">| ' + esc(w) + '</span>').join('') + '</div>'
      : '<div class="banner good"><strong>Fully configured</strong>' +
        '<span class="s">No warnings: a live Graph key, a payable x402 challenge, and signed receipts.</span></div>';
    return warn +
      '<div class="qmeta" style="justify-content:flex-start;margin:0 0 14px">' +
        tag('payment', esc(h.modes.payment), h.modes.payment === 'x402' ? 'ok' : 'warn') +
        tag('facilitator', h.x402.reachable ? 'reachable' : 'unreachable', h.x402.reachable ? 'ok' : 'bad') +
        tag('graph key', h.graph.apiKeyConfigured ? 'set' : 'missing', h.graph.apiKeyConfigured ? 'ok' : 'bad') +
        tag('split', esc(h.modes.split), h.modes.split === 'onchain' ? 'ok' : 'warn') +
        (h.consent ? tag('consent', h.consent.consented + '/' + h.consent.totalSources, h.consent.consented ? 'ok' : 'warn') : '') +
        (h.split && h.split.arbiterAddress ? tag('arbiter', esc(short(h.split.arbiterAddress, 8, 6)), 'ok') : '') +
        (h.resale ? tag('resale', h.resale.enabled ? h.resale.label : 'disabled', h.resale.enabled ? 'ok' : 'warn') : '') +
        (h.resale && h.resale.float ? tag('float spent', hbar(h.resale.float.grossTinybar) + ' | ' + h.resale.float.reads + ' reads', 'warn') : '') +
        (h.receipts && h.receipts.signer ? tag('receipt signer', esc(short(h.receipts.signer, 8, 6)), 'ok') : '') +
        (h.hcs ? tag('hcs', h.hcs.enabled ? esc(h.hcs.topicId || 'topic unset') : 'off',
          h.hcs.enabled ? 'ok' : 'warn') : '') +
      '</div>' +
      (h.split && h.split.contract
        ? '<div class="banner good"><strong>Payout contract</strong> <code>' + esc(h.split.contract) + '</code>' +
          ' - <a href="' + esc(h.split.explorer) + '" target="_blank" rel="noopener">view on HashScan</a>' +
          '<span class="s">Routing fee ' + (h.split.routingFeeBps / 100) + '%, holdback ' +
          (h.split.holdbackBps / 100) + '% unvested for ' + duration(h.split.holdbackVestingSeconds) + '.' +
          (h.split.arbiterAddress ? ' Arbiter <code>' + esc(h.split.arbiterAddress) + '</code>.' : '') +
          (h.split.disputeResolveSeconds
            ? ' Silence window <code>' + esc(h.split.disputeResolveSeconds) + 's</code> then anyone may resolveAfterDeadline.'
            : '') +
          '</span></div>'
        : '') +
      (h.hcs && h.hcs.enabled && h.hcs.topicId
        ? '<div class="banner good"><strong>HCS receipt topic</strong> <code>' + esc(h.hcs.topicId) + '</code>' +
          (h.hcs.explorer
            ? ' - <a href="' + esc(h.hcs.explorer) + '" target="_blank" rel="noopener">view on HashScan</a>'
            : '') +
          '<span class="s">Every answered read publishes its receipt digest here so existence-at-time is not only in our store.</span></div>'
        : (h.hcs && h.hcs.configured === false
          ? '<div class="banner hold"><strong>HCS not configured</strong>' +
            '<span class="s">Run <code>npm run hcs:setup</code> and set <code>HCS_TOPIC_ID</code>.</span></div>'
          : '')) +
      '<div class="banner info"><strong>The facilitator advertises</strong>' +
      '<span class="s">' + (h.x402.advertisedNetworks || []).map((n) => '<code>' + esc(n) + '</code>').join(' | ') +
      '</span><span class="s">We price in <code>' + esc(h.x402.network) + '</code>, which is why a buyer settling in ' +
      'USDC on Base has to arrive through the resale channel instead.</span></div>' +
      raw(h, 'GET /health');
  },
};

boot().catch((err) => {
  console.error('SourceMark boot failed', err);
  const led = $('navled');
  if (led) led.className = 'led bad';
  const net = $('navnet');
  if (net) net.textContent = 'boot error';
});
