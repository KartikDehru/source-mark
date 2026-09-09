import { serve } from '@hono/node-server';
import { app } from './server.js';
import { config, configWarnings } from './config.js';
import { log } from './logger.js';
import { registrySummary } from './registry.js';

const warnings = configWarnings();
for (const w of warnings) log.warn(w);

const families = registrySummary();
for (const f of families) {
  const pinned = f.sources.filter((s) => s.pinned).length;
  log.info(`family ${f.family}: ${pinned}/${f.sources.length} sources pinned, quorum ${f.policy.minSources} — ${f.ready ? 'READY' : 'NOT READY (reads will refuse)'}`);
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info(`sourcemark listening on http://localhost:${info.port}`);
  log.info(`payment=${config.x402.mode} split=${config.split.mode} anchor=${config.anchor.mode} hcs=${config.hcs.enabled && config.hcs.topicId ? config.hcs.topicId : 'off'}`);
  log.info(`try: curl -i "http://localhost:${info.port}/v1/reads/aave-v3-ethereum?metric=supplyAPY&asset=USDC"`);
});
