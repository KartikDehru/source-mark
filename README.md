<img src="public/assets/sourcemark-lockup-light.svg#gh-light-mode-only" alt="SourceMark" height="52" />
<img src="public/assets/sourcemark-lockup-dark.svg#gh-dark-mode-only" alt="SourceMark" height="52" />

# SourceMark — no proof, no answer

**A paid read layer for onchain data that refuses to answer when it cannot prove provenance, pays the sources that answered, and slashes the ones that lie.**

Built from scratch for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026).
Data from The Graph · payments over x402 on Hedera testnet via the [Blocky402](https://blocky402.com) facilitator · resold through a [Bazantic](https://bazantic.com) gateway for agents that pay in USDC on Base.

```bash
curl -i "http://localhost:8787/v1/reads/aave-v3-ethereum?metric=supplyAPY&asset=USDC"
# HTTP/1.1 402 Payment Required
```

---

## The problem

An agent that reads onchain data and then *acts* on it has a correctness problem no dashboard has. A stale number in a UI is a cosmetic bug. A stale number fed to a transaction is a loss.

Today, three things are broken at once:

- **Nobody agrees on what conforms to a standard.** Want every lending market that speaks the standardized Messari schema? You hand-build that registry yourself. So does everyone else.
- **Freshness is self-reported and advisory.** A subgraph tells you its own indexed block. Nothing forces you to check it, and nothing happens to the provider when it's wrong.
- **The sources capture none of the value.** A gateway monetises the query; the deployments that actually produced the answer aren't in the payment path.

## What this does

One endpoint, priced per call:

```
GET /v1/reads/:family?metric=<metric>&asset=<symbol>
```

1. **Unpaid → a real HTTP 402** carrying x402 payment requirements. No key, no account, no signup.
2. **Paid → verify first, work second.** The payment is verified with the facilitator but *not settled yet*.
3. **Fan out across a schema family.** The registry maps the family to N pinned deployment IDs; the same query goes to all of them.
4. **Enforce provenance.** Every source must be within the block-lag and age bounds, must report no indexing errors, and must match its pinned deployment ID. Failures are dropped, with a reason.
5. **Refuse, or answer.** Below quorum → `409 REFUSED`, and the payment is **never settled**. Above quorum → settle, then answer.
6. **Receipt.** Signed, naming every contributing deployment and the exact block its claim rests on.
7. **Split.** The settled amount goes to the sources that answered, minus a routing fee, with a slice held back unvested.
8. **Dispute.** Anyone can re-derive a receipt. If it's false, the buyer is refunded from the responsible source's unvested holdback.

### The bit that makes it honest

**Refusal is free.** Settlement happens *after* the read passes the policy, so a question the service can't answer truthfully costs the buyer nothing. It's structurally unable to profit from a guess.

That property falls out of one design decision: `verify` and `settle` are separate facilitator calls, made at different points in the request.

```
                 ┌────────────────────────────────────────┐
  agent ───────▶ │ ① no X-PAYMENT   → 402 + requirements  │
                 │ ② X-PAYMENT      → verify (NOT settle) │
                 │ ③ fan out to pinned deployments        │
                 │ ④ freshness gate vs real chain head    │
       409 ◀─────│    ├── below quorum → REFUSE, no charge│
                 │    └── above quorum → ⑤ settle         │
       200 ◀─────│ ⑥ signed receipt · split · holdback    │
                 └────────────────────────────────────────┘
```

---

## Quickstart

```bash
git clone <this repo> && cd sourcemark
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
| --- | --- |
| `GRAPH_API_KEY` | [thegraph.com/studio](https://thegraph.com/studio) → API Keys (required; without it every read refuses) |
| `X402_PAY_TO` | A Hedera testnet account id from [portal.hedera.com](https://portal.hedera.com) |
| `BUYER_ACCOUNT_ID` / `BUYER_PRIVATE_KEY` | A **second**, funded Hedera testnet account — this is the one that pays |
| `RECEIPT_SIGNING_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `RESALE_API_KEY` | Optional. The shared secret a reseller gateway forwards. Leave unset and the resale channel is off — it fails closed. |

The registry ships with two families already pinned to live mainnet deployments. Verify them, then start:

```bash
npm run registry:doctor    # live-pings every source, checks lag + schema identity
npm run dev                # http://localhost:8787
```

To add sources, find conforming deployments and paste the generated entries into `registry/families.json`:

```bash
npm run discover -- --search aave
npm run discover -- --schema QmNnWjciPb8Qy83RmdgctZmwzwofamjkfmkd5NjK1Swwsa --network mainnet --live
```

Verify the paywall with nothing but curl:

```bash
curl -i "http://localhost:8787/v1/reads/aave-v3-ethereum?metric=supplyAPY&asset=USDC"
```

Pay for a read, and force a refusal:

```bash
npm run pay                          # 402 → sign → settle → answer + receipt
npm run pay -- --strict-age 1        # demands impossible freshness → 409, not charged
npm run agent -- --interval 30       # autonomous buyer on a loop
```

`--strict-age` is the reliable refusal lever rather than `--strict-lag`: healthy sources routinely sit at lag 0, so a lag bound cannot be made to fail on demand, but a source is always at least a few seconds old.

Or open **http://localhost:8787/demo**, which drives the whole service from one
page: pick any family and metric out of the registry, then get the raw 402, pay
it with the live agent, force a refusal, or arrive through the resale channel.
A paid read renders its own sources at their answering block, the settlement,
the signed receipt, and the onchain split — with buttons to re-fetch the receipt
and to dispute it and watch the holdback get slashed. The registry, policy,
payouts, disputes and service state are each a tab rendering one public
endpoint.

The two demo buttons that spend money (`POST /demo/run`, `POST /demo/resale`)
are rate limited — one run at a time per caller, 120 an hour overall — because
they are unauthenticated by design and would otherwise be a way to drain the
accounts the demo runs on. The paid endpoint needs no such limit: it charges per
request.

To expose it publicly — needed for anything that fetches the spec server-side, a
reseller gateway included:

```bash
npm run tunnel    # prints the URL, writes PUBLIC_URL to .env, waits until it really answers
```

### No Graph key yet?

The service still starts and still serves its 402. Every read will `REFUSE` with `SOURCES_UNPINNED`. That's deliberate — it will never substitute fixtures for live data. A provenance check that falls back to a mock when the real source is unreachable is not a provenance check.

### Degradation flags

| Flag | Values | Effect |
| --- | --- | --- |
| `PAYMENT_MODE` | `x402` \| `free` | `free` drops the paywall; the read layer and its refusals work unchanged. |
| `SPLIT_MODE` | `ledger` \| `onchain` | `ledger` writes payouts to an auditable local file; `onchain` uses `SourcePayouts.sol`. |
| `ANCHOR_MODE` | `rpc` \| `relative` | `rpc` compares to true chain head; `relative` compares sources to their best peer (weaker, and labelled as such in every response). |

---

## API

| Route | What it does |
| --- | --- |
| `GET /v1/reads/:family` | The gate. 402 unpaid · 200 with receipt · 409 refused and uncharged. |
| `GET /v1/registry` | The conformance registry, as data. Adding a protocol is one entry, zero code. |
| `GET /v1/policy/:family` | Freshness policy and available metrics for a family. |
| `GET /v1/receipts/:digest` | The signed evidence behind an answer, plus how to re-derive it. |
| `POST /v1/disputes` | Challenge a receipt. |
| `GET /v1/payouts` | Per-source earnings: cleared, held back, slashed. |
| `GET /v1/consent` · `POST /v1/consent` | List or submit EIP-191 opt-ins from a source's payout address. |
| `GET /health` | Modes, facilitator reachability, split contract and holdback terms, arbiter, consent counts, resale float, per-family readiness, config warnings. |
| `GET /openapi.json` | OpenAPI 3.1 description, with 402 and 409 documented as ordinary responses. `servers` reflects the URL the request actually arrived on. |
| `GET /demo` | Hosted page driving every capability above against live data. |
| `POST /demo/run` | Runs the real buyer loop against this service and returns the trace. Rate limited. |
| `POST /demo/resale` | Calls the gate with the shared resale credential server-side, so the browser never holds it. Same path the reseller's gateway hits, minus their billing leg. Rate limited. |

<details>
<summary><b>Sample 402</b></summary>

```json
{
  "error": "PAYMENT_REQUIRED",
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "hedera:testnet",
    "amount": "100000",
    "payTo": "0.0.8011510",
    "asset": "0.0.0",
    "maxTimeoutSeconds": 300,
    "extra": { "feePayer": "0.0.7162784" }
  }],
  "policy": { "maxBlockLag": 50, "maxAgeSeconds": 600, "minSources": 2 },
  "note": "Settlement occurs only if the read satisfies the policy. A refused read is never charged."
}
```

The `feePayer` is read live from the facilitator's `/supported` endpoint on every challenge, not hardcoded.
</details>

<details>
<summary><b>Sample refusal</b></summary>

```json
{
  "error": "REFUSED",
  "reason": "QUORUM_NOT_MET",
  "survived": 1, "required": 2,
  "sources": [
    { "protocol": "aave-v3-ethereum",     "status": "OK",       "block": 23110441, "blockLag": 3 },
    { "protocol": "compound-v3-ethereum", "status": "REJECTED", "why": "BLOCK_LAG_EXCEEDED", "detail": "918 > 50" },
    { "protocol": "spark-ethereum",       "status": "REJECTED", "why": "INDEXING_ERRORS" }
  ],
  "settled": false,
  "note": "Payment was verified but deliberately not settled. You have not been charged."
}
```
</details>

---

## How it's made

**The registry is data, not code.** `registry/families.json` maps a schema family to the deployments that claim to speak it, plus one query template and the metric definitions. Adding a protocol is an edit to that file. Nothing in `src/` knows what Aave is.

**Conformance is byte-identity, not a label.** A family declares a `schemaIpfsHash`, and `npm run registry:doctor` asks The Graph's own network subgraph what schema each pinned deployment actually uses. If the hashes are not identical, the source does not belong in the family regardless of what it is named. That is what makes "speaks a standardized schema" a claim anyone can check rather than one we assert. `npm run discover -- --schema <hash>` walks the same index in reverse to find every conforming deployment — the Messari lending schema currently has 45 deployments, 22 of them live.

**Sources that should agree are held to it; sources that shouldn't, aren't.** Each family declares its `comparability`:

- `identical` — same protocol, same chain, same schema. These index the same underlying facts, so they must agree within `agreementToleranceBps`. If they don't, at least one is wrong, we cannot tell which, and the read is **refused** rather than answered with a median that splits the difference. This is what stops the freshness gate from being a mere recency check: recent and wrong is still wrong.
- `peer` — different protocols that happen to share a schema. A USDC supply rate legitimately differs between Aave and Spark, so spread is information about the market, not a fault. No agreement check applies.

Conflating the two was a real bug during the build: a plain median across Aave V3, Aave V2, Spark, and a wound-down Aave ARC pool reported USDC supply APY as **2.02%** — a rate none of those markets paid. Peer answers are now weighted by the TVL behind each rate (**3.57%**, against Aave V3's 3.60% on $2.3B), which fixes it without an arbitrary size cutoff. The alternative was tuning a TVL floor until the number looked right, which is not a defensible way to choose a threshold. The dead pool still appears in the per-source table; it just cannot move the headline.

**Deployment IDs are pinned, and the pin is enforced.** Every response carries `_meta.deployment`. If the gateway serves anything other than the ID we pinned, the response is dropped rather than merged — a subtle failure mode that would otherwise let a substituted deployment silently into the median.

**Freshness is measured against real chain head.** A subgraph's self-reported block is a claim, not a fact; it only means something next to where the chain actually is. `ANCHOR_MODE=rpc` goes and looks. The weaker best-peer fallback exists, but every response says which reference it used.

**Verify and settle are deliberately split.** This is the whole design. The facilitator exposes them as separate calls, so we verify before doing any work and settle only after the answer clears the policy.

**Liability comes out of revenue, not collateral.** A slice of every payout is held back unvested for a fixed window. That slice is the dispute pool. No source has to post a bond to participate, and a source that repeatedly serves stale data simply earns less and eventually nothing. `SourcePayouts.sol` gives the operator no code path to source balances, and no rescue function to sweep unclaimed funds.

**The buyer ships with the seller.** An x402 endpoint only its author can pay is a paywall, not a payment rail. `src/buyer.ts` backs all three clients — the in-page agent, the CLI, and the loop.

**A read can be resold without loosening the policy.** Bazantic settles in USDC on Base; we price in HBAR on Hedera. Those rails do not meet — a gateway registered `x402-mpp` proxies our free endpoints but fails the paid read with `payment_rejected`, because its payer cannot answer a Hedera challenge. Rather than register an integration whose payment leg cannot execute, the gateway authenticates with a shared secret and the arrangement is modelled as what it is: the reseller bills its callers on its own rail, the operator float covers the inbound leg, and sources are still paid onchain in HBAR with the same split, holdback and liability.

The thing worth pointing at is what *doesn't* change. Both channels run one `completeRead()`, so the refusal rule cannot be enforced on the paid path and quietly skipped on the resale one — a resold read still refuses, still for free. Reads arriving this way carry `channel: "resale"` in both the response and the signed receipt, so anyone reading a receipt can tell which rail paid for it. The credential check fails closed: an unset `RESALE_API_KEY` matches nothing, including a caller sending nothing, so a missing config cannot silently become free reads.

### Stack

| | |
| --- | --- |
| Gateway | TypeScript · [Hono](https://hono.dev) · Node 22 |
| Data | The Graph decentralized gateway, standardized schemas, pinned deployment IDs |
| Payments | x402 v2 · `exact` scheme · `hedera:testnet` · [Blocky402](https://blocky402.com) facilitator · `@x402/hedera` |
| Receipts | keccak256 over canonical JSON, EIP-191 signed via viem |
| Contract | Solidity 0.8.24 — `contracts/SourcePayouts.sol` |
| Agents | MCP server + `SKILL.md` in `mcp/` |

### Deployed contracts

| Contract | Network | Address |
| --- | --- | --- |
| `SourcePayouts` | Hedera testnet (296) | [`0x56cd017467615a51548d5f7972687397d0690148`](https://hashscan.io/testnet/contract/0x56cd017467615a51548d5f7972687397d0690148) |

All six pinned deployments are registered as sources. Check live state with
`npm run payouts:status`, which reads the contract directly and verifies that
every tinybar it holds is attributed to the routing fee, a source's cleared
balance, or a source's holdback.

**The payout addresses start as stand-ins.** No indexer or protocol team has
handed us a production address. Every source in `registry/families.json` ships
as `consent: pending`, with addresses derived from the public Hardhat test
mnemonic (`test test … junk`, indices 0–5) so they cannot be mistaken for real
operator wallets — anyone can derive the keys and run
`npx tsx scripts/claim-demo.ts` to claim as a source.

**Consent is still a real path.** `POST /v1/consent` accepts an EIP-191
signature from the registered payout key and overlays `consent: consented` on
the live registry without rewriting the file. `npm run consent:demo` signs for
every stand-in to prove the join path works end to end. What is being
demonstrated is the contract *and* the opt-in mechanism — not a payout network
of real teams that does not exist yet.

### Verified end to end

Both claims below were confirmed against live services, not asserted.

**A paid read settles.** Hedera testnet transaction
[`0.0.7162784@1788816238.698547026`](https://hashscan.io/testnet/transaction/0.0.7162784%401788816238.698547026),
result `SUCCESS`:

| Account | Change | Role |
| --- | --- | --- |
| `0.0.10409983` | −100,000 tinybar | buyer — pays the price, and only the price |
| `0.0.10409341` | +100,000 tinybar | gateway — read revenue |
| `0.0.7162784` | −242,480 tinybar | facilitator — absorbs gas, per Hedera's x402 scheme |

The answer returned with it: USDC supply APY **3.5919577023205784%** at block
25928142, from two independently-operated Aave V3 deployments agreeing to the
digit (spread 0 bps), receipt
`0xca7d06249556386b698bbbdbf48fda4d7b26ed2f0162bec6907595aba9c8b50e` signed by
`0xc1BA021F87Fcd26e47d43b98519faCa47Ad375EA`.

**A refused read costs nothing.** The same buyer signed a valid payment, the
gateway verified it with the facilitator, the freshness policy failed, and the
gateway declined to settle:

```
✓ challenge  402 Payment Required — 100000 on hedera:testnet to 0.0.10409341
✓ sign       partially-signed TransferTransaction built by 0.0.10409983
✓ settle     read REFUSED — provenance policy not satisfied, so the gateway did not settle

buyer balance before : 99999900000 tinybar
buyer balance after  : 99999900000 tinybar
delta                : 0 tinybar
```

**The split lands onchain, and a source can withdraw it.** With
`SPLIT_MODE=onchain`, a settled read is recorded by `recordRead()` in the same
request. Two reads produced
[`0x2c1532430528afeef0f7e810a0942054b3c3d0a6a0db546aba81ee1a7fdd573c`](https://hashscan.io/testnet/transaction/0x2c1532430528afeef0f7e810a0942054b3c3d0a6a0db546aba81ee1a7fdd573c)
and split 100,000 tinybar each as 10,000 routing fee and 45,000 per source, of
which 9,000 is held back. Source `aave-v3-ethereum-a` then claimed its cleared
balance in
[`0x02f8fff8d2372bb14e9f6666483b65a628a45abf203b6d602912eed1f4c45b63`](https://hashscan.io/testnet/transaction/0x02f8fff8d2372bb14e9f6666483b65a628a45abf203b6d602912eed1f4c45b63)
— 72,000 tinybar owed, exactly 0.00072 HBAR received — while its holdback
stayed withheld. `npm run payouts:status` reports the contract balanced.

**Dollars go in on one chain, source payouts come out on another.** Through the
Bazantic gateway
[`kz46uwbv5fewjo2l57uuvnzajq.bazgateway.com`](https://kz46uwbv5fewjo2l57uuvnzajq.bazgateway.com)
(SourceMark, Railway-backed; older Cloudflare listings are stale),
a caller paid **$0.01 in USDC on
Base**; Bazantic forwarded the request; the read was fanned across two pinned
Graph deployments at block 25,933,010 (lag 0, age 13s) and answered **3.6331%**
supplyAPY — and both sources were paid **in HBAR on Hedera** in
[`0xe2d834345a98109b0da0e11bbe85992b16907afcaa172882fa1bdf111d9b3041`](https://hashscan.io/testnet/transaction/0xe2d834345a98109b0da0e11bbe85992b16907afcaa172882fa1bdf111d9b3041).
The same request with `strictAge=1` returns `409`, free, `channel: "resale"`,
nothing settled and no source paid. The policy is not relaxed for resold reads.

Bazantic track setup (gateway + multi-service Recipe draft for Hedera Mirror
Node): **[bazantic/SETUP.md](./bazantic/SETUP.md)**. The gateway is registered;
set the dashboard API credential and publish the Recipe from
`bazantic/recipe-sourcemark-proven-lending-rate.json` to finish qualification.

Bazantic also generates an MCP endpoint per gateway from the same spec. It was
observed serving 7 tools carrying our own `operationId`s and descriptions —
`readMetric`, `listSchemaFamilies`, `getReceipt`, `listPayouts`,
`getFamilyPolicy`, `health`, `info` — which is a useful independent check that
the spec is machine-consumable. It is **currently returning 404 on every
gateway**, ours and the throwaways alike, so treat that as a Bazantic-side
outage rather than a working feature. The first-party MCP server in `mcp/` is
unaffected and is the one to demo.

Reproduce with `npm run pay`, `npm run pay -- --strict-age 1`,
`npm run payouts:status`, and `npx tsx scripts/claim-demo.ts`.

> **A Hedera unit trap worth knowing.** Inside a contract `msg.value` arrives
> in **tinybar** — the JSON-RPC relay divides the transaction's weibar value by
> 1e10 — while `eth_getBalance` answers in **weibar**. Compare the two directly
> and correct accounting looks off by 1e10. `scripts/claim-demo.ts` checks
> owed-against-received on-chain rather than assuming the two units agree,
> because if they had not, every source payout would have been 1e10 too small.

---

## What this does **not** do

Stated up front, because the mechanism is easy to overstate:

1. **Payout addresses are still stand-ins.** Consent is real — `POST /v1/consent` verifies an EIP-191 signature from the registered payout key, overlays `consent: consented` on the live registry, and `npm run consent:demo` proves the path with the public Hardhat mnemonic. What it does *not* claim is that Messari or Aave have joined. The addresses remain derived from `test test … junk` until a real team registers their own.
2. **Holdback percentages are unpriced.** We demonstrate that the mechanism executes correctly. We do not claim the numbers are correctly calibrated against real risk. The dispute bond (`DISPUTE_BOND_TINYBAR`, default 1 HBAR) is likewise a demo default, not a market-priced griefing cost.
3. **Dispute resolution is arbiter-gated.** Anyone can *open* a dispute permissionlessly and every one is a public event, but a named arbiter decides it. Trustless resolution would need onchain re-derivation of a subgraph query.
4. **The arbiter is separated from the operator on this deployment.** `ARBITER_ADDRESS` is a distinct key, rotated onchain with `npm run payouts:set-arbiter` ([tx](https://hashscan.io/testnet/transaction/0xab09a3e6557affbfac67874f9baa6455e43ea9bf87f780cca5e85b8e4458db83)). `/health` and `payouts:status` flag any reversion to the same-key setup. Separation is operational, not trustless — the arbiter is still a person with a key.
5. **The liability window can be griefed.** An open dispute freezes the named sources' holdback so it cannot be waited out. The bond is the only thing making a frivolous freeze expensive.
6. **Liability expires.** Once a holdback vests it is gone; a dispute raised after `vestingSeconds` recovers nothing. Fraud discovered late is not recoverable.
7. **A successful read proves provenance, not truth.** On an `identical` family, agreement between independent deployments is real evidence — but both could be indexing the same faulty logic, and agreement would not catch that. On a `peer` family the headline is a market summary, not a verified value; `range` and the per-source table are the honest output.
8. **Amounts are testnet-scale.** The liability pool is a working demonstration, not insurance.
9. **A resold read is funded by the operator, not by the caller's dollars.** The two rails never touch: Bazantic collects USDC on Base and we pay sources HBAR on Hedera out of the operator float. Nothing bridges them. The float *is* now an auditable ledger (`/health` → `resale.float`, and `data/resale-float.json`), so what we fronted is visible even though the currencies never meet.
10. **Local tunneling is still ephemeral.** `npm run tunnel` remains useful for local demos. Production and judging links should use a stable host (this deployment runs on Railway) so gateway registrations and receipts stay reproducible.

---

## Repo

```
src/          gateway: registry · graph · anchor · resolver · x402 · receipt · split · server
registry/     families.json — the conformance registry (data)
client/       one-shot CLI buyer
agent/        autonomous buyer on a loop
mcp/          MCP server + SKILL.md
contracts/    SourcePayouts.sol
public/       hosted demo page + brand assets (served read-only from /assets)
test/         aggregation + freshness tests; test/contracts/ for Solidity
scripts/      doctors and one-shot tools (below)
```

| Script | What it is for |
| --- | --- |
| `registry:doctor` | Live source health, and whether each deployment's schema hash matches the family it claims |
| `hedera:doctor` | Preflight the payment rail — account existence, balances, ECDSA-vs-ED25519 key type |
| `mcp:smoke` | Drive the MCP server as a real stdio client through both the answered and refused paths |
| `discover` | Find deployments sharing a schema hash, to add sources without code changes |
| `payouts:deploy` | Deploy `SourcePayouts` and register every source in the registry |
| `payouts:status` | Read contract state and check every tinybar is attributed |
| `payouts:set-arbiter` | Rotate the onchain arbiter to `ARBITER_ADDRESS` (must differ from the operator) |
| `consent:demo` | EIP-191-sign consent for every stand-in payout address and POST it |
| `claim-demo` | Claim as a source, verifying owed matches received on-chain |
| `rpc-probe` | Show raw Hedera relay status codes, which viem otherwise collapses into "unknown RPC error" |
| `tunnel` | Put the gateway on a public HTTPS URL, record it as `PUBLIC_URL`, and poll until it genuinely answers rather than trusting the announcement |

AI tool attribution: **[AI-USAGE.md](./AI-USAGE.md)**

```bash
npm run typecheck        # gateway
npm test                 # gateway tests (aggregation, freshness, resale gate, consent), then contract tests
npm run contracts:test   # Solidity only, with its own typecheck
```

## Author

**Kartik Dehru** — [kartikdehru2003@gmail.com](mailto:kartikdehru2003@gmail.com)

Built solo for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026).

## License

MIT
