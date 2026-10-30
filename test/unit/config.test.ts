import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(c).toMatchObject({
      port: 3000,
      databaseUrl: 'postgres://x',
      logLevel: 'info',
      dbPoolMax: 10,
      dbLockTimeoutMs: 5000,
      dbStatementTimeoutMs: 15000,
      dbIdleInTxTimeoutMs: 30000,
      outboxRelayEnabled: true,
      outboxRelayIntervalMs: 1000,
    });
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://x',
      PORT: '8080',
      OUTBOX_RELAY_ENABLED: 'false',
      DB_IDLE_IN_TX_TIMEOUT_MS: '45000',
    });
    expect(c).toMatchObject({ port: 8080, outboxRelayEnabled: false, dbIdleInTxTimeoutMs: 45000 });
  });

  it('fails fast without DATABASE_URL', () => expect(() => loadConfig({})).toThrow());
});
