import fs from 'node:fs';

const byline =
  'Made by <a href="https://github.com/KartikDehru" target="_blank" rel="noopener">Kartik Dehru</a> · <a href="https://github.com/KartikDehru/source-mark" target="_blank" rel="noopener">GitHub docs</a> · MIT · ETHOnline 2026</p>';

for (const f of ['public/index.html', 'public/demo.html', 'public/explore.html', 'public/sdk.html']) {
  let s = fs.readFileSync(f, 'utf8');
  s = s
    .replace(/\uFFFD/g, '')
    .replace(/◇/g, '*')
    .replace(/→/g, '->')
    .replace(/[—–]/g, '-')
    .replace(/Made by[\s\S]*?ETHOnline 2026<\/p>/, byline)
    .replace(
      /<span class="faint">[\s\S]*?every answer names its sources, or there is no answer<\/span>/,
      '<span class="faint">· every answer names its sources, or there is no answer</span>',
    )
    .replace(
      /run it live[\s\S]*?real HBAR, real subgraphs[\s\S]*?</,
      'run it live · real HBAR, real subgraphs -></',
    );
  fs.writeFileSync(f, s, 'utf8');
  console.log('fixed', f);
}
