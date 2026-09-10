'use strict';

window.$ = (id) => document.getElementById(id);
window.esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

window.num = function num(v, digits = 6) {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  if (!Number.isFinite(n)) return esc(v);
  if (n !== 0 && Math.abs(n) < 0.001) return n.toExponential(3);
  if (Math.abs(n) >= 1e6) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return String(Number(n.toPrecision(digits)));
};

window.hbar = function hbar(tinybar) {
  if (tinybar === null || tinybar === undefined) return '-';
  const n = Number(tinybar);
  if (!Number.isFinite(n)) return esc(tinybar);
  return (n / 1e8).toFixed(5).replace(/0+$/, '').replace(/\.$/, '') + ' HBAR';
};

window.short = function short(s, head = 10, tail = 6) {
  const v = String(s ?? '');
  return v.length <= head + tail + 1 ? v : v.slice(0, head) + '...' + v.slice(-tail);
};

window.duration = function duration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '-';
  if (s % 86400 === 0) return s / 86400 + 'd';
  if (s % 3600 === 0) return s / 3600 + 'h';
  return s + 's';
};

window.payee = function payee(addr) {
  const v = String(addr ?? '');
  if (!v || v === 'unassigned' || v.startsWith('<FILL:')) {
    return '<td class="warn" title="' + esc(v) + '">unassigned</td>';
  }
  return '<td class="faint" title="' + esc(v) + '">' + esc(short(v, 10, 6)) + '</td>';
};

window.tag = function tag(label, value, state) {
  return (
    '<span class="tag">' +
    (state ? '<span class="led ' + state + '"></span>' : '') +
    esc(label) +
    ' <b>' +
    value +
    '</b></span>'
  );
};

window.api = async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};

window.raw = function raw(obj, label) {
  return (
    '<details class="raw"><summary>' +
    esc(label || 'raw json') +
    '</summary><pre>' +
    esc(JSON.stringify(obj, null, 2)) +
    '</pre></details>'
  );
};

window.bootNav = async function bootNav() {
  const h = await api('/health');
  const led = $('navled');
  const net = $('navnet');
  if (!led || !net) return h.body;
  if (!h.body) {
    led.className = 'led bad';
    net.textContent = 'unreachable';
    return null;
  }
  led.className = 'led up';
  net.textContent = (h.body.x402 && h.body.x402.network) || 'hedera testnet';
  return h.body;
};
