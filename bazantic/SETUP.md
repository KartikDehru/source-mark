# Bazantic track setup — SourceMark

Target prize: **Best Recipe that uses EthGlobal Hackathon Sponsor APIs**
([ETHOnline 2026 · Bazantic](https://ethglobal.com/events/ethonline2026/prizes/bazantic))

> Continuity-only prize ("Help an Agent Use Your Hackathon Project") is **not** eligible for this From Scratch submission.

## Qualification checklist

| Requirement | Status | Notes |
| --- | --- | --- |
| Bazantic account | ✅ | CLI session account `john swift` / id `9e1e99c6-3334-4bb9-afad-80a2f76868d4` |
| Gateway for this project | ✅ registered | Slug **`kz46uwbv5fewjo2l57uuvnzajq`** · name **SourceMark** · Railway endpoint |
| Gateway credential (api-key) | ⚠️ **you must set in dashboard** | Until the shared `RESALE_API_KEY` is saved under Payment Gateway → Authentication, every path on the new slug returns **404** |
| Second service (sponsor **or** already on Bazantic) | ✅ chosen | **Hedera Mirror Node** slug `wonsgifa6zha7p4wku4mp5i6em` (Hedera is an ETHOnline sponsor) |
| Recipe using both in one flow | ⚠️ paste in UI | Definition in `recipe-sourcemark-proven-lending-rate.json` |
| Final result depends on both | ✅ by design | Rate from SourceMark + independent Hedera account proof |
| Screen recording | ⏳ submission video | Walk gateway → recipe run → both tools fire |
| Bazantic username in submission | ⏳ | Use the handle/email you registered with |

## Live URLs

| | |
| --- | --- |
| Backend | https://source-mark-production.up.railway.app |
| OpenAPI | https://source-mark-production.up.railway.app/openapi.json |
| Bazantic gateway | https://kz46uwbv5fewjo2l57uuvnzajq.bazgateway.com |
| MCP (once credential is set) | https://kz46uwbv5fewjo2l57uuvnzajq.bazgateway.com/mcp |
| Old stale listing | `rj5zqylrjnezdkpvh3powvzn7a` — still points at a dead Cloudflare tunnel; retire it in the dashboard |

Auth type is **`api-key`** (not `x402-mpp`): Bazantic settles callers in USDC on Base; SourceMark prices in HBAR on Hedera. Those rails do not meet. The gateway forwards `RESALE_API_KEY`; SourceMark still runs the full provenance gate and pays sources onchain.

## Dashboard steps (required now)

1. Open https://bazantic.com and sign in as the same account the CLI uses.
2. Open the **SourceMark** gateway (`kz46uwbv5fewjo2l57uuvnzajq`).
3. **Payment Gateway / Authentication**
   - Auth: API key
   - Send as: header (prefer `x-api-key`, or Bearer — SourceMark accepts both)
   - Credential: paste the same value as local/Railway `RESALE_API_KEY`
   - Connection base URL: `https://source-mark-production.up.railway.app`
4. Click **Test connection** — expect success against `/health` or `/v1/registry`.
5. Retire **Provenance Meter (resale)** so judges only see SourceMark.

Verify from a shell after the credential is saved:

```bash
curl -sS "https://kz46uwbv5fewjo2l57uuvnzajq.bazgateway.com/health"
# should be HTTP 200 with service: sourcemark
```

## Create the Recipe (dashboard)

Bazantic's public recipe write API requires an admin platform key; creation is done in the web UI.

1. In bazantic.com go to **Recipes → New**.
2. Paste fields from `recipe-sourcemark-proven-lending-rate.json`:
   - handle, name, description
   - model: `anthropic/claude-sonnet-4.6`
   - input schema / example / output example
   - prompt template
3. Bind tools (exact names may appear with slight MCP formatting — pick the matching ones):
   - SourceMark → `health`, `listSchemaFamilies`, `readMetric`, `getReceipt`
   - Hedera Mirror Node → account-by-id (`GET /api/v1/accounts/{idOrAliasOrEvmAddress}`)
4. **Publish** the recipe.
5. Run one test with the input example; confirm both gateways are called.

## Why this qualifies

- **SourceMark** is the project gateway (Graph-backed provenance reads + Hedera liability).
- **Hedera Mirror Node** is a second, sponsor-adjacent service already listed on Bazantic.
- The recipe’s output is incomplete if either step fails: no rate without SourceMark; no independent settlement-rail check without Mirror Node.

## Re-register later

```bash
npx bazantic-cli login
npx bazantic-cli gateway add \
  --spec-url https://source-mark-production.up.railway.app/openapi.json \
  --endpoint https://source-mark-production.up.railway.app \
  --name "SourceMark" \
  --auth-type api-key \
  --status active \
  --json
```

Never point a Bazantic gateway at `trycloudflare` again — Railway is the stable host.
