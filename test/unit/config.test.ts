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
      outboxRelayEnabled: true,
      outboxRelayIntervalMs: 1000,
    });
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://x',
      PORT: '8080',
      OUTBOX_RELAY_ENABLED: 'false',
    });
    expect(c).toMatchObject({ port: 8080, outboxRelayEnabled: false });
  });

  it('fails fast without DATABASE_URL', () => expect(() => loadConfig({})).toThrow());
});
