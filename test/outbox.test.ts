import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool, migrate } from '../src/db.js';
import { type OutboxEvent, type Publisher, relayOnce, startRelay } from '../src/outbox/relay.js';

let app: FastifyInstance;
let pool: pg.Pool;

// Own database: a relay publishes every pending event, and other test files assert theirs stay unpublished.
const dbUrl = new URL('/outbox_test', inject('databaseUrl')).href;

beforeAll(async () => {
  const admin = createPool(inject('databaseUrl'));
  await admin.query('DROP DATABASE IF EXISTS outbox_test'); // left by the previous run in watch mode
  await admin.query('CREATE DATABASE outbox_test');
  await admin.end();
  pool = createPool(dbUrl, { max: 20 });
  await migrate(pool);
  app = await buildApp({ pool });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function addEvent() {
  const id = randomUUID();
  const aggregateId = randomUUID();
  await pool.query(
    `INSERT INTO outbox_events (id, event_type, aggregate_id, payload) VALUES ($1, 'TransferCompleted', $2, $3)`,
    [id, aggregateId, { eventId: id }],
  );
  return { id, aggregateId };
}

const rowOf = async (aggregateId: string) =>
  (
    await pool.query(
      'SELECT attempts, published_at, last_error FROM outbox_events WHERE aggregate_id = $1',
      [aggregateId],
    )
  ).rows[0];

describe('outbox relay', () => {
  it('relayOnce publishes pending events once', async () => {
    const { id, aggregateId } = await addEvent();
    const seen: OutboxEvent[] = [];
    const collect: Publisher = async (e) => {
      seen.push(e);
    };
    await relayOnce(pool, collect);
    await relayOnce(pool, collect);
    expect(seen.filter((e) => e.aggregateId === aggregateId)).toEqual([
      {
        id,
        eventType: 'TransferCompleted',
        aggregateId,
        payload: { eventId: id },
        attempts: 0,
      },
    ]);
    expect((await rowOf(aggregateId)).published_at).not.toBeNull();
  });

  it('failing publisher increments attempts and keeps the event pending; stops after maxAttempts', async () => {
    const { aggregateId } = await addEvent();
    const boom: Publisher = async (e) => {
      if (e.aggregateId === aggregateId) throw new Error('broker down');
    };
    const opts = { maxAttempts: 3 };
    for (let i = 0; i < 3; i++) await relayOnce(pool, boom, opts);
    expect(await rowOf(aggregateId)).toMatchObject({
      attempts: 3,
      published_at: null,
      last_error: 'broker down',
    });
    const ok = vi.fn(async () => {});
    await relayOnce(pool, ok, opts);
    expect(ok).not.toHaveBeenCalledWith(expect.objectContaining({ aggregateId }));
    expect((await rowOf(aggregateId)).attempts).toBe(3);
  });

  it('logs each publish failure as a warning and the parking one as an error', async () => {
    const { id, aggregateId } = await addEvent();
    const boom: Publisher = async (e) => {
      if (e.aggregateId === aggregateId) throw new Error('broker down');
    };
    const log = { warn: vi.fn(), error: vi.fn() };
    const opts = { maxAttempts: 2, log: log as unknown as FastifyBaseLogger };
    await relayOnce(pool, boom, opts);
    expect(log.warn).toHaveBeenCalledWith(
      {
        eventId: id,
        aggregateId,
        attempts: 1,
        err: expect.objectContaining({ message: 'broker down' }),
      },
      'outbox publish failed',
    );
    expect(log.error).not.toHaveBeenCalled();
    await relayOnce(pool, boom, opts);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: id, aggregateId, attempts: 2 }),
      'outbox event parked',
    );
  });

  it('truncates last_error to 500 characters', async () => {
    const { aggregateId } = await addEvent();
    const boom: Publisher = async (e) => {
      if (e.aggregateId === aggregateId) throw new Error('x'.repeat(600));
    };
    await relayOnce(pool, boom);
    expect((await rowOf(aggregateId)).last_error).toBe('x'.repeat(500));
  });

  it('an error message Postgres cannot store (NUL) still parks the event and does not block its neighbours', async () => {
    const bad = await addEvent();
    const next = await addEvent();
    const boom: Publisher = async (e) => {
      if (e.aggregateId === bad.aggregateId) throw new Error('bad\0byte');
    };
    await relayOnce(pool, boom);
    expect(await rowOf(bad.aggregateId)).toMatchObject({
      attempts: 1,
      published_at: null,
      last_error: 'badbyte',
    });
    expect((await rowOf(next.aggregateId)).published_at).not.toBeNull();
  });

  it('two concurrent relays never publish the same event twice (SKIP LOCKED)', async () => {
    for (let i = 0; i < 6; i++) await addEvent();
    // B starts only after A holds its locks, and A holds them until B has published something:
    // without SKIP LOCKED, B waits for A's rows and the two deadlock (B hits lock_timeout, test fails).
    let aHolds!: () => void;
    const aLocked = new Promise<void>((resolve) => {
      aHolds = resolve;
    });
    let bPublished!: () => void;
    const gate = new Promise<void>((resolve) => {
      bPublished = resolve;
    });
    const a: string[] = [];
    const b: string[] = [];
    const slowA: Publisher = async (e) => {
      a.push(e.id);
      aHolds();
      await gate;
    };
    const fastB: Publisher = async (e) => {
      b.push(e.id);
      bPublished();
    };
    const relayA = relayOnce(pool, slowA, { batchSize: 3 });
    await aLocked;
    const relayB = relayOnce(pool, fastB, { batchSize: 3 });
    // finally: release A even if B fails, so a failure does not leave A holding its connection.
    await Promise.all([relayA, relayB]).finally(bPublished);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });

  it('a publisher slower than idle_in_transaction_session_timeout fails the round, not the process', async () => {
    const { aggregateId } = await addEvent();
    const short = createPool(dbUrl, { idleInTxTimeoutMs: 200 });
    const slow: Publisher = () => sleep(500);
    await expect(relayOnce(short, slow)).rejects.toThrow();
    await short.end();
    expect(await rowOf(aggregateId)).toMatchObject({ attempts: 0, published_at: null });
  });

  it('startRelay publishes on an interval and its stop function waits for the round in progress', async () => {
    const mine = await addEvent();
    let inRound!: () => void;
    const started = new Promise<void>((resolve) => {
      inRound = resolve;
    });
    let finished = false;
    const stop = startRelay(
      pool,
      async (e) => {
        if (e.aggregateId !== mine.aggregateId) return;
        inRound();
        await sleep(100);
        finished = true;
      },
      10,
      app.log,
    );
    await started;
    await stop();
    expect(finished).toBe(true);
    expect((await rowOf(mine.aggregateId)).published_at).not.toBeNull();

    const later = await addEvent(); // no round may run after stop()
    await sleep(60);
    expect((await rowOf(later.aggregateId)).published_at).toBeNull();
  });

  it('startRelay drains a backlog of several batches without waiting an interval per batch', async () => {
    const mine = new Set<string>();
    for (let i = 0; i < 120; i++) mine.add((await addEvent()).aggregateId);
    let drained!: () => void;
    const allSeen = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const seen = new Set<string>();
    const started = Date.now();
    const stop = startRelay(
      pool,
      async (e) => {
        if (mine.has(e.aggregateId)) seen.add(e.aggregateId);
        if (seen.size === mine.size) drained();
      },
      1000,
      app.log,
    );
    await allSeen;
    const elapsed = Date.now() - started;
    await stop();
    // The first round starts after one interval; at one batch of 50 per interval, 120 events need three.
    expect(elapsed).toBeLessThan(2000);
  });

  it('a batch that only fails is retried once per interval, not right away', async () => {
    // A full batch: a relay that re-ran whenever it fetched rows (or a full batch) would spin on it.
    const mine = new Set<string>();
    for (let i = 0; i < 50; i++) mine.add((await addEvent()).aggregateId);
    const [first] = mine;
    const tries: number[] = []; // when `first` was attempted
    let thirdTry!: () => void;
    const triedThrice = new Promise<void>((resolve) => {
      thirdTry = resolve;
    });
    const stop = startRelay(
      pool,
      async (e) => {
        if (!mine.has(e.aggregateId)) return;
        if (e.aggregateId === first && tries.push(performance.now()) === 3) thirdTry();
        throw new Error('broker down');
      },
      250,
      app.log,
    );
    await triedThrice;
    await stop();
    const [t1, t2, t3] = tries as [number, number, number];
    expect(Math.min(t2 - t1, t3 - t2)).toBeGreaterThanOrEqual(240);
  });
});
