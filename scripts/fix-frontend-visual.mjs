import fs from 'fs';

// Fix CSS: remove visual noise overlays that read as broken glyphs.
let css = fs.readFileSync('public/css/site.css', 'utf8');
css = css.replace(
  /\/\* Faint scanlines[\s\S]*?body::before\{[\s\S]*?\}\n/,
  '/* Scanlines removed - they read as broken glyphs on some screens. */\n',
);
css = css.replace(/\/\* Halftone over the smoke[\s\S]*?\.hero::after\{[\s\S]*?\}\n/, '');
css = css.replace(/\.invert::before\{[\s\S]*?\}\n/, '');
css = css.replace(/\.answer::before\{[\s\S]*?\}\n/, '');
fs.writeFileSync('public/css/site.css', css);
console.log('css cleaned, scanlines removed:', !css.includes('body::before'));

let common = fs.readFileSync('public/js/common.js', 'utf8');
common = common.replaceAll('\u2026', '...');
fs.writeFileSync('public/js/common.js', common);

function ascii(s) {
  return s
    .replaceAll('\u210F', 'HBAR') // ℏ
    .replaceAll('\u2713', 'OK') // ✓
    .replaceAll('\u2717', 'X') // ✗
    .replaceAll('\u2026', '...')
    .replaceAll('\u2014', '-')
    .replaceAll('\u2013', '-')
    .replaceAll('\u2192', '->')
    .replaceAll('\u00B7', '|');
}

function cleanPageJs(path) {
  let s = fs.readFileSync(path, 'utf8');
  const bootIdx = s.indexOf('async function boot()');
  if (bootIdx < 0) throw new Error('boot() not found in ' + path);

  const header = `'use strict';

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

`;

  let rest = ascii(s.slice(bootIdx));
  rest = rest.replace(
    "$('metric').addEventListener('change', updateCurl);\n$('asset').addEventListener('input', updateCurl);",
    "const metricEl = $('metric');\nif (metricEl) metricEl.addEventListener('change', updateCurl);\nconst assetEl = $('asset');\nif (assetEl) assetEl.addEventListener('input', updateCurl);",
  );
  for (const id of ['b402', 'bpay', 'bstale', 'bact', 'bresale']) {
    const re = new RegExp("\\$\\('" + id + "'\\)\\.onclick =", 'g');
    rest = rest.replace(re, "if ($('" + id + "')) $('" + id + "').onclick =");
  }

  // Ensure boot catch exists
  if (!rest.includes('boot().catch')) {
    rest = rest.replace(
      /boot\(\);\s*$/,
      `boot().catch((err) => {
  console.error('SourceMark boot failed', err);
  const led = $('navled');
  if (led) led.className = 'led bad';
  const net = $('navnet');
  if (net) net.textContent = 'boot error';
});
`,
    );
  }

  const out = header + rest;
  fs.writeFileSync(path, out);
  console.log('cleaned', path, 'bytes', out.length, 'startsOk', out.startsWith("'use strict'"));
}

cleanPageJs('public/js/demo.js');
cleanPageJs('public/js/explore.js');

for (const f of [
  'public/demo.html',
  'public/index.html',
  'public/explore.html',
  'public/sdk.html',
]) {
  let h = fs.readFileSync(f, 'utf8');
  h = h.replaceAll('?v=4', '?v=5').replaceAll('?v=3', '?v=5');
  fs.writeFileSync(f, h);
}
console.log('cache bust -> v=5');
