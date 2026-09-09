import { anchorReceiptOnHcs, verifyHcsAnchor } from '../src/hcs.js';

const digest = '0xdeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe';

const anchor = await anchorReceiptOnHcs({
  digest,
  family: 'smoke',
  issuedAt: Math.floor(Date.now() / 1000),
});

console.log(JSON.stringify(anchor, null, 2));
if (!anchor) {
  console.error('anchor returned null');
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 5000));
console.log(await verifyHcsAnchor(anchor, digest));
