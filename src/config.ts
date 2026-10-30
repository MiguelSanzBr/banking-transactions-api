import { z } from 'zod';

const int = (def: number) => z.coerce.number().int().positive().default(def);

const env = z.object({
  PORT: int(3000),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
  DB_POOL_MAX: int(10),
  DB_LOCK_TIMEOUT_MS: int(5000),
  DB_STATEMENT_TIMEOUT_MS: int(15000),
  OUTBOX_RELAY_ENABLED: z.enum(['true', 'false']).default('true'),
  OUTBOX_RELAY_INTERVAL_MS: int(1000),
});

export type Config = {
  port: number;
  databaseUrl: string;
  logLevel: string;
  dbPoolMax: number;
  dbLockTimeoutMs: number;
  dbStatementTimeoutMs: number;
  outboxRelayEnabled: boolean;
  outboxRelayIntervalMs: number;
};

export function loadConfig(source: NodeJS.ProcessEnv): Config {
  const e = env.parse(source);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    dbPoolMax: e.DB_POOL_MAX,
    dbLockTimeoutMs: e.DB_LOCK_TIMEOUT_MS,
    dbStatementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    outboxRelayEnabled: e.OUTBOX_RELAY_ENABLED === 'true',
    outboxRelayIntervalMs: e.OUTBOX_RELAY_INTERVAL_MS,
  };
}
