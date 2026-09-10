import fs from 'node:fs';

for (const file of ['public/js/demo.js', 'public/js/explore.js']) {
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes("const ev = $('evidence')")) {
    s = s.replace(
      "$('evidence').innerHTML = cells.map",
      "const ev = $('evidence');\n  if (!ev) return;\n  ev.innerHTML = cells.map",
    );
  }
  fs.writeFileSync(file, s);
  console.log(file, 'evidence-guard', s.includes("if (!ev) return"));
}

let css = fs.readFileSync('public/css/site.css', 'utf8');
css = css.replace(
  `@media(max-width:860px){
    nav .links{display:none}
    .qmeta{margin-left:0;justify-content:flex-start}
    .answer .tags{margin-left:0}
    .limits li,footer .ep div{grid-template-columns:1fr;gap:6px}
    .invert{padding:30px 24px 32px}
  }`,
  `@media(max-width:860px){
    nav .inner{flex-wrap:wrap;gap:10px 16px}
    nav .links{
      display:flex;flex-wrap:wrap;gap:10px 14px;
      width:100%;order:3;margin:6px 0 0;padding-top:10px;
      border-top:1px solid var(--line);
    }
    nav .links a{font-size:11px;letter-spacing:.1em}
    .qmeta{margin-left:0;justify-content:flex-start}
    .answer .tags{margin-left:0}
    .limits li,footer .ep div{grid-template-columns:1fr;gap:6px}
    .invert{padding:30px 24px 32px}
  }`,
);
fs.writeFileSync('public/css/site.css', css);
console.log('css nav links always visible');
