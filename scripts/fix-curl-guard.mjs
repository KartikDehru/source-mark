import fs from 'node:fs';

for (const file of ['public/js/demo.js', 'public/js/explore.js']) {
  let s = fs.readFileSync(file, 'utf8');

  // Guard offline evidence write in boot
  s = s.replace(
    `$('navled').className = 'led bad';
    $('navnet').textContent = 'unreachable';
    $('evidence').innerHTML = '<div class="ev"><div class="k">service</div><div class="v">offline</div></div>';
    return;`,
    `$('navled').className = 'led bad';
    $('navnet').textContent = 'unreachable';
    const offline = $('evidence');
    if (offline) offline.innerHTML = '<div class="ev"><div class="k">service</div><div class="v">offline</div></div>';
    return;`,
  );

  // Guard curl updater (element only exists on explore / old single page)
  if (!s.includes("const curlEl = $('curl')")) {
    s = s.replace(
      /function updateCurl\(\) \{[\s\S]*?\$\('curl'\)\.textContent =/,
      (m) =>
        m.replace(
          "$('curl').textContent =",
          "const curlEl = $('curl');\n  if (!curlEl) return;\n  curlEl.textContent =",
        ),
    );
  }

  fs.writeFileSync(file, s);
  console.log(file, 'curl guard', s.includes("const curlEl = $('curl')"));
}
