# SourceMark SDK

Thin TypeScript client for the SourceMark HTTP gate.

```bash
npm install ./sdk
```

```ts
import { SourceMark } from 'sourcemark-sdk';

const sm = new SourceMark({
  baseUrl: 'https://source-mark-production.up.railway.app',
});

const challenge = await sm.challenge('aave-v3-ethereum', {
  metric: 'supplyAPY',
  asset: 'USDC',
});
// challenge.status === 402

const paid = await sm.read('aave-v3-ethereum', {
  metric: 'supplyAPY',
  asset: 'USDC',
  paymentHeader: process.env.X_PAYMENT, // build with repo buyer / npm run pay
});
```

Payment signing stays in the main repo (`src/buyer.ts`) so this package stays dependency-light. Docs: [github.com/KartikDehru/source-mark](https://github.com/KartikDehru/source-mark).
