import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, inject, it, vi } from 'vitest';
import { createPool } from '../src/db.js';
import { randomDocument, waitForQueue } from './helpers.js';

it('boot with the database down → one structured log line and exit 1 (the restart policy retries)', () => {
  const boot = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', LOG_LEVEL: 'info' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(boot.status).toBe(1);
  expect(boot.stderr).toBe(''); // no raw Node stack
  expect(boot.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(boot.stdout)).toMatchObject({
    level: 60,
    msg: 'boot failed',
    err: { code: 'ECONNREFUSED' },
  });
});

it('SIGTERM with a keep-alive request in flight → the request completes and the process exits 0 at once', async () => {
  const free = net.createServer().listen(0);
  await once(free, 'listening');
  const { port } = free.address() as net.AddressInfo;
  free.close();
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    // Relay off: it would publish the events other test files expect to stay pending.
    env: {
      ...process.env,
      DATABASE_URL: inject('databaseUrl'),
      PORT: String(port),
      LOG_LEVEL: 'info',
      OUTBOX_RELAY_ENABLED: 'false',
    },
  });
  const exited = once(server, 'exit');
  let out = '';
  server.stdout.on('data', (d) => {
    out += d;
  });
  // Keep-alive: like a pooling client, the socket stays open after each response.
  const agent = new http.Agent({ keepAlive: true });
  const post = (path: string, body: object) =>
    new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { port, path, method: 'POST', agent, headers: { 'content-type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (d) => {
            text += d;
          });
          res.on('end', () => resolve({ status: res.statusCode, body: text }));
        },
      );
      req.on('error', reject).end(JSON.stringify(body));
    });
  const pool = createPool(inject('databaseUrl'));
  const holder = await pool.connect();
  try {
    await vi.waitFor(() => expect(out).toContain('Server listening'), { timeout: 10_000 });
    const account = await post('/accounts', { holderName: 'Shutdown', document: randomDocument() });
    const { id } = JSON.parse(account.body);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    const { rows } = await holder.query('SELECT pg_backend_pid() AS pid');
    const deposit = post(`/accounts/${id}/deposits`, { amount: 10 });
    await waitForQueue(pool, rows[0].pid, 1);
    const signalled = Date.now();
    server.kill('SIGTERM');
    await sleep(200); // close() starts while the deposit still waits on the lock
    await holder.query('COMMIT');
    expect((await deposit).status).toBe(201);
    expect((await exited)[0]).toBe(0);
    expect(Date.now() - signalled).toBeLessThan(5000); // the shutdown deadline is 20 s
  } finally {
    await holder.query('ROLLBACK').catch(() => {}); // no-op after COMMIT
    holder.release();
    server.kill('SIGKILL'); // no-op once it exited
    agent.destroy();
    await pool.end();
  }
});
