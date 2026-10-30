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
  idleInTxTimeoutMs: config.dbIdleInTxTimeoutMs,
});
const app = await buildApp({
  pool,
  logger: { level: config.logLevel },
});
// Swap db.ts's console.error fallback for the structured logger now that one exists.
pool
  .removeAllListeners('error')
  .on('error', (err) => app.log.error({ err: loggable(err) }, 'idle pg client error'));

try {
  await migrate(pool);
} catch (err) {
  // E.g. the database is down: one structured line instead of a raw stack; the restart policy retries.
  app.log.fatal({ err: loggable(err) }, 'boot failed');
  process.exit(1);
}

let stopRelay: (() => Promise<void>) | undefined; // set after listen; undefined if the relay is disabled
let closing = false; // SIGTERM then SIGINT must not end the pool twice
const shutdown = async () => {
  if (closing) return;
  closing = true;
  // In-flight queries end within statement_timeout (15 s), but a frozen database can hold the drain open;
  // exit before compose's stop_grace_period (25 s) turns the stop into a SIGKILL.
  setTimeout(() => {
    app.log.error('shutdown deadline exceeded, exiting');
    process.exit(1);
  }, 20_000).unref();
  try {
    await stopRelay?.(); // first: an in-flight round must end before the pool does
    // close() drops only the sockets idle right then; one whose request finishes later would stay open for
    // keepAliveTimeout (72 s), so keep closing the idle ones until close() resolves.
    setInterval(() => app.server.closeIdleConnections(), 250).unref();
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
