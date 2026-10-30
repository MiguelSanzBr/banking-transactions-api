import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { logPublisher, startRelay } from './outbox/relay.js';
import { loggable } from './shared/errors.js';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl, {
  max: config.dbPoolMax,
  lockTimeoutMs: config.dbLockTimeoutMs,
  statementTimeoutMs: config.dbStatementTimeoutMs,
});
await migrate(pool);

const app = await buildApp({
  pool,
  logger: { level: config.logLevel, redact: ['req.headers.authorization'] },
});
// Swap db.ts's console.error fallback for the structured logger now that one exists.
pool
  .removeAllListeners('error')
  .on('error', (err) => app.log.error({ err: loggable(err) }, 'idle pg client error'));

let stopRelay: (() => Promise<void>) | undefined; // set after listen; undefined if the relay is disabled
let closing = false; // SIGTERM then SIGINT must not end the pool twice
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await stopRelay?.(); // first: an in-flight round must end before the pool does
    await app.close();
    await pool.end();
  } catch (err) {
    app.log.error({ err: loggable(err) }, 'shutdown failed');
    process.exitCode = 1;
  }
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: config.port });

if (config.outboxRelayEnabled)
  stopRelay = startRelay(pool, logPublisher(app.log), config.outboxRelayIntervalMs, app.log);
