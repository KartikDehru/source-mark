/**
 * OpenAPI description of the read layer.
 *
 * This exists because a machine has to be able to discover the service without
 * reading the README — Bazantic fetches this document server-side to generate a
 * listing and an MCP endpoint from it, and an agent framework needs the same
 * thing to call the API at all.
 *
 * Two things it documents that a normal spec would leave out, and which are the
 * whole point of the service:
 *
 *   - **402 is a normal response**, not an error. It carries the payment
 *     requirements needed to retry.
 *   - **409 REFUSED is a normal response too**, and it is *free*. A caller that
 *     treats it as a retryable failure will hammer sources that are lagging and
 *     still get nothing. The description says so, because a spec is the only
 *     documentation some callers will ever read.
 */

export function openApiDocument(origin: string): unknown {
  return {
    openapi: '3.1.0',
    info: {
      title: 'SourceMark',
      version: '0.1.0',
      summary: 'Paid, provenance-checked reads of standardized onchain data.',
      description: [
        'A read layer over The Graph that fans a single query across several pinned',
        'deployments speaking the same standardized schema, checks each one against',
        'live chain head, and answers only if enough of them are fresh and agree.',
        '',
        'It refuses rather than guessing. A refusal is free — you are charged only',
        'for an answer the service is willing to stand behind. Revenue from each',
        'paid read is split onchain across the deployments that actually answered',
        'it, with a portion held back as slashable liability.',
        '',
        'Payment is x402 over HBAR on Hedera testnet.',
      ].join('\n'),
      license: { name: 'MIT' },
    },

    servers: [{ url: origin, description: 'this instance' }],

    tags: [
      { name: 'reads', description: 'The paid, provenance-checked read path.' },
      { name: 'evidence', description: 'Receipts and payouts — verify what you were told.' },
      { name: 'discovery', description: 'What can be read, and under what policy.' },
    ],

    paths: {
      '/v1/reads/{family}': {
        get: {
          tags: ['reads'],
          operationId: 'readMetric',
          summary: 'Read a metric, or be told why it cannot be answered',
          description: [
            'Returns a value only if the freshness and agreement policy passes.',
            '',
            '**Handling the responses:**',
            '',
            '- `200` — an answer, with the per-source evidence behind it and a signed receipt.',
            '- `402` — you have not paid. The body carries the payment requirements; sign and retry.',
            '- `409` — REFUSED. Provenance could not be established, and **you were not charged**.',
            '  Do not retry in a loop and do not substitute a cached or single-source value.',
            '  The sources are lagging; time is the only fix.',
            '',
            'On a family whose sources index *different* protocols, the headline value is a',
            'TVL-weighted summary and the response includes `range` and `caveat`. Report the',
            'range — quoting the average alone is false precision.',
          ].join('\n'),
          parameters: [
            {
              name: 'family',
              in: 'path',
              required: true,
              description: 'Schema family id. List them via GET /v1/registry.',
              schema: { type: 'string', examples: ['aave-v3-ethereum', 'lending-v1-ethereum'] },
            },
            {
              name: 'metric',
              in: 'query',
              required: true,
              description: 'Metric the family exposes, e.g. supplyAPY.',
              schema: { type: 'string', examples: ['supplyAPY', 'borrowAPY', 'tvlUSD'] },
            },
            {
              name: 'asset',
              in: 'query',
              required: false,
              description: 'Optional asset symbol filter.',
              schema: { type: 'string', examples: ['USDC', 'WETH'] },
            },
            {
              name: 'strictLag',
              in: 'query',
              required: false,
              description:
                'Tighten the block-lag bound for this request. Can only tighten, never loosen. Makes refusal more likely.',
              schema: { type: 'integer', minimum: 0 },
            },
            {
              name: 'strictAge',
              in: 'query',
              required: false,
              description:
                'Tighten the wall-clock age bound, in seconds. A value of 1 always refuses, because indexed data is never less than a second old — use it once to verify you handle a refusal correctly.',
              schema: { type: 'integer', minimum: 0 },
            },
          ],
          responses: {
            200: {
              description: 'Answered. You were charged, and the answer carries its evidence.',
              headers: {
                'X-Payment-Receipt': {
                  description: 'Base64 of the signed receipt, so a third party can re-derive the answer.',
                  schema: { type: 'string' },
                },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/AnsweredRead' } } },
            },
            400: {
              description: 'Unknown family or metric.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            402: {
              description: 'Payment required. The body states exactly how to pay.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentRequired' } } },
            },
            409: {
              description: 'REFUSED — provenance not established. Not an error, and not charged.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Refusal' } } },
            },
          },
        },
      },

      '/v1/registry': {
        get: {
          tags: ['discovery'],
          operationId: 'listSchemaFamilies',
          summary: 'What can be read, and from which pinned deployments',
          description:
            'The conformance registry as data. A family is defined by a schema IPFS hash, so membership is an objective fact drawn from The Graph network subgraph rather than a label we assert.',
          responses: {
            200: {
              description: 'The registry.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
          },
        },
      },

      '/v1/policy/{family}': {
        get: {
          tags: ['discovery'],
          operationId: 'getFamilyPolicy',
          summary: 'The freshness policy a family is held to',
          parameters: [{ name: 'family', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'The effective policy.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Policy' } } },
            },
            404: {
              description: 'No such family.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },

      '/v1/receipts/{digest}': {
        get: {
          tags: ['evidence'],
          operationId: 'getReceipt',
          summary: 'Fetch the signed evidence behind an earlier answer',
          parameters: [
            {
              name: 'digest',
              in: 'path',
              required: true,
              description: 'Receipt digest returned with the answer.',
              schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
            },
          ],
          responses: {
            200: {
              description: 'The signed receipt.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            404: {
              description: 'Unknown digest.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },

      '/v1/payouts': {
        get: {
          tags: ['evidence'],
          operationId: 'listPayouts',
          summary: 'What each source has earned, and what is still slashable',
          responses: {
            200: {
              description: 'Per-source earnings and holdback.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
          },
        },
      },

      '/v1/consent': {
        get: {
          tags: ['discovery'],
          operationId: 'listConsents',
          summary: 'Which sources have opted in by signing with their payout key',
          responses: {
            200: {
              description: 'Consent summary and records.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
          },
        },
        post: {
          tags: ['discovery'],
          operationId: 'submitConsent',
          summary: 'Opt a source in with an EIP-191 signature from its payout address',
          responses: {
            200: {
              description: 'Consent recorded.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            400: {
              description: 'Bad signature or mismatched payout address.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },

      '/health': {
        get: {
          tags: ['discovery'],
          operationId: 'health',
          summary: 'Readiness, and an honest list of what is misconfigured',
          responses: {
            200: {
              description: 'Service state.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
          },
        },
      },
    },

    components: {
      schemas: {
        Policy: {
          type: 'object',
          description: 'The bar a read must clear.',
          properties: {
            maxBlockLag: { type: 'integer', description: 'Blocks a source may trail chain head.' },
            maxAgeSeconds: { type: 'integer', description: 'Wall-clock staleness allowed.' },
            minSources: { type: 'integer', description: 'Fresh sources required to answer at all.' },
          },
        },

        Answer: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            unit: { type: 'string', examples: ['percent', 'usd'] },
            method: {
              type: 'string',
              enum: ['median', 'tvl-weighted'],
              description: 'tvl-weighted is used for families whose sources index different protocols.',
            },
            contributors: { type: 'integer', description: 'Sources that backed this value.' },
            spreadBps: { type: 'integer', description: 'Gap between the highest and lowest source, in bps.' },
            comparability: {
              type: 'string',
              enum: ['identical', 'peer'],
              description:
                'identical: sources index the same protocol and should agree, so disagreement is a fault. peer: sources index different protocols and are expected to differ, so the value is a summary.',
            },
            range: {
              type: 'object',
              description: 'Present on peer families. Report this alongside the value.',
              properties: { low: { type: 'number' }, high: { type: 'number' } },
            },
            caveat: { type: 'string', description: 'Plain-language statement of the limitation.' },
          },
          required: ['value', 'unit', 'method', 'contributors'],
        },

        SourceReport: {
          type: 'object',
          description: 'One source, and whether it cleared the policy.',
          properties: {
            protocol: { type: 'string' },
            chainId: { type: 'integer' },
            deploymentId: { type: 'string', description: 'Pinned deployment id. A mismatch is dropped, not merged.' },
            block: { type: 'integer' },
            blockHash: { type: 'string' },
            blockLag: { type: 'integer' },
            ageSeconds: { type: 'integer' },
            status: { type: 'string', enum: ['OK', 'REJECTED'] },
            reason: { type: 'string', description: 'Why it was rejected, when it was.' },
            value: { type: 'number' },
            weightUSD: { type: 'number', description: 'TVL backing this source, used for weighting.' },
          },
        },

        AnsweredRead: {
          type: 'object',
          properties: {
            family: { type: 'string' },
            metric: { type: 'string' },
            asset: { type: ['string', 'null'] },
            answer: { $ref: '#/components/schemas/Answer' },
            sources: { type: 'array', items: { $ref: '#/components/schemas/SourceReport' } },
            policy: { $ref: '#/components/schemas/Policy' },
            payment: {
              type: 'object',
              properties: {
                network: { type: 'string' },
                amount: { type: 'string' },
                asset: { type: 'string' },
                payer: { type: ['string', 'null'] },
                transaction: { type: ['string', 'null'] },
                explorer: { type: ['string', 'null'] },
              },
            },
            payout: {
              type: 'object',
              description: 'How this payment was split across the sources that answered.',
              properties: {
                gross: { type: 'string' },
                routingFee: { type: 'string' },
                shares: { type: 'array', items: { type: 'object', additionalProperties: true } },
                onchain: {
                  type: ['object', 'null'],
                  description: 'Present when SPLIT_MODE=onchain: the SourcePayouts transaction.',
                  properties: {
                    contract: { type: 'string' },
                    transaction: { type: 'string' },
                    explorer: { type: 'string' },
                  },
                },
              },
            },
            receipt: {
              type: 'object',
              properties: {
                digest: { type: 'string' },
                signature: { type: 'string' },
                signer: { type: 'string' },
              },
            },
          },
        },

        Refusal: {
          type: 'object',
          description: 'A refusal. Free, final, and not a retry signal.',
          properties: {
            error: { type: 'string', const: 'REFUSED' },
            reason: {
              type: 'string',
              enum: [
                'QUORUM_NOT_MET',
                'AGREEMENT_FAILED',
                'MARKET_NOT_LIQUID',
                'UNKNOWN_FAMILY',
                'UNKNOWN_METRIC',
                'NO_CHAIN_HEAD',
              ],
            },
            detail: { type: 'string' },
            survived: { type: 'integer', description: 'Sources that cleared the policy.' },
            required: { type: 'integer', description: 'Sources needed.' },
            sources: { type: 'array', items: { $ref: '#/components/schemas/SourceReport' } },
            policy: { $ref: '#/components/schemas/Policy' },
            settled: { type: 'boolean', const: false, description: 'Always false. You were not charged.' },
            note: { type: 'string' },
          },
        },

        PaymentRequired: {
          type: 'object',
          description: 'x402 payment requirements. Sign one and retry with the X-PAYMENT header.',
          properties: {
            x402Version: { type: 'integer' },
            accepts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            error: { type: 'string' },
          },
        },

        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, detail: { type: 'string' } },
        },
      },

      securitySchemes: {
        x402: {
          type: 'http',
          scheme: 'bearer',
          description:
            'x402 over HBAR on Hedera testnet. Request without credentials to receive a 402 carrying the requirements, then retry with the signed payload in the X-PAYMENT header.',
        },
      },
    },
  };
}
