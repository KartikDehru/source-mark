import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const raw = fs.readFileSync(path.join(root, 'public', 'demo.html'), 'utf8');
const css = raw.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = raw.match(/<script>([\s\S]*?)<\/script>/)[1];

fs.mkdirSync(path.join(root, 'public', 'css'), { recursive: true });
fs.mkdirSync(path.join(root, 'public', 'js'), { recursive: true });

fs.writeFileSync(
  path.join(root, 'public', 'css', 'site.css'),
  `${css.trim()}

/* multi-page */
footer .byline{margin-top:28px;padding-top:18px;border-top:1px solid var(--line);font:500 12px/1.5 var(--mono);color:var(--muted)}
footer .byline a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line-strong)}
footer .byline a:hover{border-color:var(--ink)}
nav .links a.on{color:var(--ink)}
.page-hero{padding:56px 0 24px;border-top:0}
.sdk-block{border:1px solid var(--line);background:var(--surface);padding:18px 20px;margin:0 0 16px}
.sdk-block pre{margin:12px 0 0;overflow:auto;font:12px/1.5 var(--mono);color:var(--ink)}
`,
);

const DOCS = 'https://github.com/KartikDehru/source-mark';
const RECIPE =
  'https://bazantic.com/dashboard/recipes/sourcemark-proven-lending-rate-with-hedera-settl';

function shell({ title, active, body, scripts }) {
  const link = (href, label, key) =>
    `<a href="${href}"${active === key ? ' class="on"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="Paid, provenance-checked reads of standardized onchain data. x402 on Hedera, sources pinned on The Graph, revenue split onchain with slashable holdback." />
<link rel="icon" type="image/png" href="/assets/sourcemark-icon.png?v=5" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Spline+Sans+Mono:wght@300..700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/css/site.css" />
</head>
<body>
<nav>
  <div class="inner">
    <a class="mark" href="/">
      <img src="/assets/sourcemark-icon.png?v=5" alt="" />
      <span class="wm">source<i>mark</i></span>
    </a>
    <div class="links">
      ${link('/', 'Home', 'home')}
      ${link('/demo', 'Live demo', 'demo')}
      ${link('/explore', 'Data', 'explore')}
      ${link('/sdk', 'SDK', 'sdk')}
      <a href="${DOCS}" target="_blank" rel="noopener">Docs</a>
      <a href="${RECIPE}" target="_blank" rel="noopener">Recipe</a>
      <a href="/openapi.json" target="_blank" rel="noopener">API</a>
    </div>
    <div class="right">
      <span class="netpill"><span class="led" id="navled"></span> <span id="navnet">hedera testnet</span></span>
    </div>
  </div>
</nav>
${body}
<footer>
  <div class="wrap">
    <p class="lbl">// source mark</p>
    <div class="sig">
      <img src="/assets/sourcemark-icon.png?v=5" alt="" />
      <span class="wm">source<i>mark</i></span>
      <span class="faint">· every answer names its sources, or there is no answer</span>
    </div>
    <p class="byline">Made by <a href="https://github.com/KartikDehru" target="_blank" rel="noopener">Kartik Dehru</a>
      · <a href="${DOCS}" target="_blank" rel="noopener">GitHub docs</a>
      · MIT · ETHOnline 2026</p>
  </div>
</footer>
${scripts}
</body>
</html>
`;
}

// ── Home ───────────────────────────────────────────────────────────────────
const homeBody = `
<main id="top">
  <section class="hero">
    <svg class="smoke" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <filter id="sm" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves="4" seed="7" />
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer><feFuncA type="linear" slope="0.5" intercept="0" /></feComponentTransfer>
      </filter>
      <rect width="100%" height="100%" filter="url(#sm)" />
      <rect width="100%" height="100%" fill="url(#fade)" />
      <defs>
        <radialGradient id="fade" cx="62%" cy="30%" r="62%">
          <stop offset="55%" stop-color="#f6f7f7" stop-opacity="0" />
          <stop offset="100%" stop-color="#f6f7f7" stop-opacity="1" />
        </radialGradient>
      </defs>
    </svg>
    <div class="wrap">
      <div class="brand">
        <img src="/assets/sourcemark-icon.png?v=5" alt="" />
        <span class="wm">source<i>mark</i></span>
      </div>
      <h1>No proof,<br /><span class="hl">no answer.</span><span class="caret"></span></h1>
      <p class="sub">
        A metered read layer for onchain data that <b>declines to answer</b> rather than
        guess. One query fans out across independently pinned subgraph deployments speaking
        the same schema, each checked against live chain head.
      </p>
      <p class="sub">
        Enough of them fresh and in agreement, you get a number and a signed receipt.
        Otherwise you get a refusal — <b>and a refusal is free</b>.
      </p>
      <a class="cta" href="/demo"><span class="dia">◇</span> run it live · real HBAR, real subgraphs →</a>
      <div class="evidence" id="evidence">
        <div class="ev"><div class="k">reading service…</div><div class="v">—</div></div>
      </div>
      <div class="builton">
        <span class="t">// built on</span>
        <span class="row">
          <span class="b">The Graph</span>
          <span class="b">Hedera</span>
          <span class="b">x402 · Blocky402</span>
          <span class="b">Bazantic</span>
        </span>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="invert">
        <h3>Verified before the read. Settled <span class="hl">only after</span> it passes.</h3>
        <p>
          A read that fails the provenance policy returns <code>409 REFUSED</code> and is never
          charged. You only ever pay for an answer this service is willing to stand behind.
        </p>
        <div class="foot">
          <span>402 unpaid</span>
          <span>409 refused · 0 charged</span>
          <span>200 answered · signed · split onchain</span>
        </div>
      </div>
    </div>
  </section>

  <section id="how">
    <div class="wrap">
      <p class="lbl">// how the gate works</p>
      <h2 class="sec">Seven stages between your query and a number.</h2>
      <p class="lede">The fourth is the product. Everything before it is plumbing; everything after only runs because it passed.</p>
      <div class="steps-grid">
        <div class="st"><div class="top"><span class="no">01</span><span class="role">paywall</span></div><h4>Challenge</h4><p>Unpaid read → <code>402</code> with x402 requirements. No key, no signup.</p></div>
        <div class="st"><div class="top"><span class="no">02</span><span class="role">verify</span></div><h4>Prove funds</h4><p>Facilitator validates the signed Hedera transfer. Nothing moves yet.</p></div>
        <div class="st"><div class="top"><span class="no">03</span><span class="role">fan out</span></div><h4>Ask every source</h4><p>Same query hits every pinned deployment in the family via The Graph.</p></div>
        <div class="st gate"><div class="top"><span class="no">04</span><span class="role">the product</span></div><h4><span>Provenance gate</span></h4><p>Lag, age, quorum, agreement. Any failure refuses the whole read.</p></div>
        <div class="st"><div class="top"><span class="no">05</span><span class="role">money</span></div><h4>Settle · or refuse</h4><p>Pass → settle in HBAR. Fail → 409, unsettled.</p></div>
        <div class="st"><div class="top"><span class="no">06</span><span class="role">evidence</span></div><h4>Sign a receipt</h4><p>Answer + sources + blocks, hashed and signed.</p></div>
        <div class="st"><div class="top"><span class="no">07</span><span class="role">liability</span></div><h4>Split · hold back</h4><p>Sources get paid; a slashable slice stays unvested.</p></div>
      </div>
    </div>
  </section>

  <section id="stack">
    <div class="wrap">
      <p class="lbl">// built on</p>
      <h2 class="sec">Three integrations, none decorative.</h2>
      <div class="cards">
        <div class="card"><div class="top"><h4>The Graph</h4><span class="role">the data</span></div><ul>
          <li>Pinned deployment IDs and byte-identical schema hashes.</li>
          <li>Live gateway queries — no fixtures on the serving path.</li>
        </ul></div>
        <div class="card"><div class="top"><h4>Hedera</h4><span class="role">the money</span></div><ul>
          <li>x402 over HBAR via Blocky402; <code>SourcePayouts</code> for split + holdback.</li>
          <li>Receipt digests anchored on HCS when configured.</li>
        </ul></div>
        <div class="card"><div class="top"><h4>Bazantic</h4><span class="role">distribution</span></div><ul>
          <li>USDC-on-Base buyers hit the same gate via resale.</li>
          <li><a href="${RECIPE}" target="_blank" rel="noopener">Published recipe</a> with Hedera Mirror Node.</li>
        </ul></div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <p class="lbl">// stated plainly</p>
      <h2 class="sec">What this does not do.</h2>
      <ul class="limits">
        <li><b>Payees are opt-in demo operators</b><span>Consent is real EIP-191. Production indexer teams have not necessarily registered.</span></li>
        <li><b>Disputes are evidence-backed, not fully trustless</b><span>Graph re-derive offchain; onchain open + arbiter or deadline uphold.</span></li>
        <li><b>Testnet scale</b><span>Hedera testnet HBAR and a demo liability pool — not insurance.</span></li>
        <li><b>Resale float is operator-funded</b><span>Bazantic’s USDC and our HBAR rails do not bridge.</span></li>
      </ul>
    </div>
  </section>
</main>
`;

fs.writeFileSync(
  path.join(root, 'public', 'index.html'),
  shell({
    title: 'SourceMark — no proof, no answer',
    active: 'home',
    body: homeBody,
    scripts: `<script src="/js/common.js"></script>\n<script src="/js/home.js"></script>`,
  }),
);

// ── Demo (console only) ────────────────────────────────────────────────────
const demoMatch = raw.match(/<!-- ─+ LIVE DEMO[\s\S]*?<!-- ─+ EXPLORER/);
let demoSection = '';
if (demoMatch) {
  demoSection = demoMatch[0].replace(/<!-- ─+ EXPLORER[\s\S]*$/, '');
} else {
  // fallback: extract by id="demo"
  const start = raw.indexOf('<section id="demo">');
  const explore = raw.indexOf('<!-- ────────────────────────────── EXPLORER');
  demoSection = raw.slice(start, explore);
}

const demoBody = `
<main id="top">
  <section class="page-hero">
    <div class="wrap">
      <p class="lbl">// live demo</p>
      <h2 class="sec">Real HBAR. Real Graph deployments.</h2>
      <p class="lede">Pay, refuse, resale, act — then verify the receipt. Nothing here is mocked.</p>
    </div>
  </section>
  ${demoSection}
</main>
`;

fs.writeFileSync(
  path.join(root, 'public', 'demo.html'),
  shell({
    title: 'SourceMark — live demo',
    active: 'demo',
    body: demoBody,
    scripts: `<script src="/js/common.js"></script>\n<script src="/js/demo.js"></script>`,
  }),
);

// ── Explore ────────────────────────────────────────────────────────────────
const exploreStart = raw.indexOf('<section id="explore">');
const stackStart = raw.indexOf('<!-- ────────────────────────────── STACK');
const exploreSection = raw.slice(exploreStart, stackStart);

const exploreBody = `
<main id="top">
  <section class="page-hero">
    <div class="wrap">
      <p class="lbl">// everything as data</p>
      <h2 class="sec">Registry, money, disputes — readable.</h2>
      <p class="lede">Each tab is one public endpoint. Run a paid read on the <a href="/demo">live demo</a> first if a table is empty.</p>
      <div class="qbar" style="margin-top:18px">
        <div class="field">
          <label for="family">Schema family</label>
          <select id="family"><option>loading…</option></select>
        </div>
        <div class="field">
          <label for="metric">Metric</label>
          <select id="metric"><option>—</option></select>
        </div>
        <div class="field">
          <label for="asset">Asset</label>
          <input type="text" id="asset" value="USDC" style="min-width:112px" />
        </div>
        <div class="qmeta" id="qmeta"></div>
      </div>
    </div>
  </section>
  ${exploreSection}
  <section>
    <div class="wrap">
      <p class="lbl">// api surface</p>
      <div class="ep">
        <div><code>GET /v1/reads/:family</code><span>402 unpaid · 409 refused · 200 answered</span></div>
        <div><code>GET /v1/registry</code><span>Conformance registry</span></div>
        <div><code>GET /v1/payouts</code><span>Earned / cleared / slashable</span></div>
        <div><code>POST /v1/disputes</code><span>Re-derive and slash</span></div>
        <div><code>GET /v1/agent-intents</code><span>Signed ENTER/HOLD decisions</span></div>
        <div><code>GET /openapi.json</code><span>Machine-readable contract</span></div>
      </div>
      <div class="curl" id="curl">curl -i "/v1/reads/aave-v3-ethereum?metric=supplyAPY&amp;asset=USDC"</div>
    </div>
  </section>
</main>
`;

fs.writeFileSync(
  path.join(root, 'public', 'explore.html'),
  shell({
    title: 'SourceMark — data explorer',
    active: 'explore',
    body: exploreBody,
    scripts: `<script src="/js/common.js"></script>\n<script src="/js/explore.js"></script>`,
  }),
);

// ── SDK page ───────────────────────────────────────────────────────────────
const sdkBody = `
<main id="top">
  <section class="page-hero">
    <div class="wrap">
      <p class="lbl">// sdk</p>
      <h2 class="sec">Call SourceMark from your agent.</h2>
      <p class="lede">Thin TypeScript client for the HTTP gate. Pay-per-read still uses the Hedera buyer helpers in the repo when you attach <code>X-PAYMENT</code>.</p>
    </div>
  </section>
  <section>
    <div class="wrap">
      <div class="sdk-block">
        <strong>Install from this repo</strong>
        <pre>npm install ./sdk
# or import from the monorepo path</pre>
      </div>
      <div class="sdk-block">
        <strong>Challenge + paid read</strong>
        <pre>import { SourceMark } from 'sourcemark-sdk';

const sm = new SourceMark({ baseUrl: 'https://source-mark-production.up.railway.app' });

// Unpaid → 402 with payment requirements
const challenge = await sm.challenge('aave-v3-ethereum', { metric: 'supplyAPY', asset: 'USDC' });

// After you build X-PAYMENT (see repo buyer / npm run pay):
const result = await sm.read('aave-v3-ethereum', {
  metric: 'supplyAPY',
  asset: 'USDC',
  paymentHeader: process.env.X_PAYMENT,
});

console.log(result.status, result.body?.answer);</pre>
      </div>
      <div class="sdk-block">
        <strong>Also available</strong>
        <pre>await sm.registry()
await sm.policy('aave-v3-ethereum')
await sm.receipt(digest)
await sm.payouts()
await sm.health()</pre>
      </div>
      <p class="lede" style="margin-top:24px">Full docs and source: <a href="${DOCS}/tree/main/sdk" target="_blank" rel="noopener">${DOCS}/tree/main/sdk</a></p>
    </div>
  </section>
</main>
`;

fs.writeFileSync(
  path.join(root, 'public', 'sdk.html'),
  shell({
    title: 'SourceMark — SDK',
    active: 'sdk',
    body: sdkBody,
    scripts: `<script src="/js/common.js"></script>\n<script src="/js/nav-boot.js"></script>`,
  }),
);

// Keep raw script for manual split into common/demo/explore
fs.writeFileSync(path.join(root, 'public', 'js', '_extracted-demo-script.js'), script);
console.log('wrote pages + css; extracted script bytes', script.length);
