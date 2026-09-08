---
name: sourcemark
description: Read standardized onchain data (lending rates, TVL) through a gateway that proves the data's provenance before answering, and refuses rather than guessing when it cannot. Use this whenever an answer will inform a transaction, a position, or an irreversible action — not when a rough number is fine.
---

# SourceMark

A paid read layer over The Graph. It fans one query across several pinned
deployments that speak the same standardized schema, checks each one's indexed
block against actual chain head, and only answers if enough of them are fresh
and agree.

## When to use this instead of a plain subgraph query

Use it when being **wrong is worse than being slow**. A single subgraph query
tells you what one indexer believes and gives you no way to know whether that
indexer is 3 blocks behind or 30,000. If you are about to size a position, quote
a rate to a user, or trigger a transaction, that gap matters.

Use a plain query instead when you are exploring, backfilling history, or
displaying something a human will sanity-check.

## The one behaviour you must handle

**This service refuses.** A `REFUSED` result is not an error and not a retry
signal — it is the service telling you it could not establish provenance and
therefore will not give you a number.

When you get `REFUSED`:

- **Do not** substitute a cached value, a single-source query, or an estimate.
- **Do not** retry immediately in a loop. The sources are lagging; time is the
  only fix.
- **Do** tell the user or calling system that the data could not be verified,
  and quote the `reason` and the per-source detail.
- **Do** stop the action that depended on the number.

You are not charged for a refused read. Refusing costs you nothing, so there is
never a reason to prefer a shakier answer to save money.

## Tools

| Tool | Use it to |
| --- | --- |
| `list_schema_families` | Discover what can be read and under which freshness policy, before asking for anything. |
| `read_metric` | Get a provenance-checked value. Returns either an answer with its sources, or a refusal with the reason per source. |
| `get_receipt` | Fetch the signed evidence behind an earlier answer, so a third party can re-derive it. |
| `check_sources` | Inspect current source health. Use this to explain *why* reads are refusing. |

## Reading the answer

An answer includes `contributors` (how many sources backed it), `spreadBps` (the
gap between the highest and lowest source), a per-source table with each one's
block and lag, and a `comparability` field that changes how you should read the
number.

### `comparability: "identical"`

Every source indexes the *same protocol* with the same schema, so they should
agree. They are redundant indexers of one truth. Here a disagreement is a fault,
and the service refuses with `AGREEMENT_FAILED` rather than picking a side. If
you get a number, the sources concurred within tolerance — you can treat it as
the value.

### `comparability: "peer"`

Sources index *different protocols* that share a schema. They are supposed to
disagree; Aave V2 and Spark genuinely have different rates. Aggregating them
into one number is a summary, not a measurement.

For these, `value` is a **TVL-weighted mean**, `range` gives the real low and
high across protocols, and `caveat` names the limitation in words.

**Report the range, not just the value.** Saying "the rate is 3.57%" when the
underlying protocols span 0.5% to 3.6% is the kind of false precision this
service exists to prevent. Quote the value as a market-wide average and give the
range alongside it.

### Spread

A wide `spreadBps` is a warning worth surfacing even when the read succeeded —
for `peer` families especially, it means the protocols in the family are not
currently interchangeable.

## Verifying you handle refusal correctly

Pass `strictAge: 1` to `read_metric`. Indexed data is never less than a second
old, so this **always** refuses. Use it once, on purpose, to confirm your code
takes the refusal branch — rather than discovering at the worst possible moment
that you treated a refusal as a retryable error.

## Payment

Reads are priced per call in HBAR on Hedera testnet over x402. Payment is
verified before the work and settled only after the read passes the policy.
Configure the buyer account once; you do not manage payment per call.
