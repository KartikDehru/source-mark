import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
let body = fs.readFileSync(path.join(root, 'public', 'js', '_extracted-demo-script.js'), 'utf8');

body = body
  .replace(/^'use strict';\s*/, '')
  .replace(/loadTab\('registry'\);/, "if ($('tabs')) loadTab('registry');")
  .replace(
    /ACTIONS\.forEach\(\(b\) => \{ \$\(b\)\.disabled = on; \}\);/,
    "ACTIONS.forEach((b) => { const el = $(b); if (el) el.disabled = on; });",
  );

const header = `'use strict';\n`;

fs.writeFileSync(path.join(root, 'public', 'js', 'demo.js'), header + body);

const explore = body.replace(
  /\$\('(b402|bpay|bstale|bresale|bact)'\)\.onclick =/g,
  (_m, id) => `if ($('${id}')) $('${id}').onclick =`,
);

fs.writeFileSync(path.join(root, 'public', 'js', 'explore.js'), header + explore);
console.log('demo', fs.statSync('public/js/demo.js').size, 'explore', fs.statSync('public/js/explore.js').size);
