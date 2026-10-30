import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type OutboxEvent, type Publisher, relayOnce, startRelay } from '../src/outbox/relay.js';
import { makeApp } from './helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

// Other test files write events into the same table: a big batch keeps our rows inside it.
const BIG = { batchSize: 1000 };

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
    await relayOnce(pool, collect, BIG);
    await relayOnce(pool, collect, BIG);
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
    const opts = { ...BIG, maxAttempts: 3 };
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

  it('truncates last_error to 500 characters', async () => {
    const { aggregateId } = await addEvent();
    const boom: Publisher = async (e) => {
      if (e.aggregateId === aggregateId) throw new Error('x'.repeat(600));
    };
    await relayOnce(pool, boom, BIG);
    expect((await rowOf(aggregateId)).last_error).toBe('x'.repeat(500));
  });

  it('an error message Postgres cannot store (NUL) still parks the event and does not block its neighbours', async () => {
    const bad = await addEvent();
    const next = await addEvent();
    const boom: Publisher = async (e) => {
      if (e.aggregateId === bad.aggregateId) throw new Error('bad\0byte');
    };
    await relayOnce(pool, boom, BIG);
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
});
