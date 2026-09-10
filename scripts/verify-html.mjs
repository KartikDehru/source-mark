import fs from 'node:fs';

for (const f of ['public/index.html', 'public/demo.html', 'public/explore.html', 'public/sdk.html']) {
  const t = fs.readFileSync(f, 'utf8');
  console.log(f, {
    mojibake: /â€|Â./.test(t),
    brokenClose: /<\/\s*\/a>|<\\\\\/a>/.test(t),
    hasCta: t.includes('class="cta"'),
    hasByline: t.includes('Made by'),
    hasDocs: t.includes('>Docs<'),
  });
}

const idx = fs.readFileSync('public/index.html', 'utf8');
const m = idx.match(/<a class="cta"[\s\S]*?<\/a>/);
console.log('CTA:', m ? m[0] : 'MISSING');
