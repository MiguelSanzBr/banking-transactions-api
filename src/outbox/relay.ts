import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { withTransaction } from '../db.js';

export type OutboxEvent = {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
};
export type Publisher = (event: OutboxEvent) => Promise<void>;

// At-least-once: a crash after publish() but before COMMIT republishes the event, so consumers dedupe by eventId.
// An event with attempts >= maxAttempts stays unpublished: the dead-letter set, queryable with SQL.
// shortcut: row locks and one pool connection are held while publish() runs, so a hung publisher stalls
// its batch; add a publish timeout when a real broker replaces logPublisher.
export function relayOnce(
  pool: pg.Pool,
  publish: Publisher,
  opts: { batchSize?: number; maxAttempts?: number } = {},
): Promise<number> {
  const { batchSize = 50, maxAttempts = 10 } = opts;
  return withTransaction(pool, async (c) => {
    // SKIP LOCKED: concurrent relays (other instances) take disjoint events instead of waiting.
    const { rows } = await c.query<OutboxEvent>(
      `SELECT id, event_type AS "eventType", aggregate_id AS "aggregateId", payload, attempts
         FROM outbox_events
        WHERE published_at IS NULL AND attempts < $1
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [maxAttempts, batchSize],
    );
    let published = 0;
    for (const event of rows) {
      try {
        await publish(event);
      } catch (err) {
        // NUL is not storable in Postgres text: left in, this UPDATE would fail and roll back the whole batch every round.
        const message = (err instanceof Error ? err.message : String(err))
          .replaceAll('\0', '')
          .slice(0, 500);
        await c.query(
          'UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
          [event.id, message],
        );
        continue;
      }
      // Outside the try: a database error here must abort the transaction, not count as a publish failure.
      await c.query('UPDATE outbox_events SET published_at = now() WHERE id = $1', [event.id]);
      published++;
    }
    return published;
  });
}

// Rounds never overlap in this process: the next one is scheduled only after the current one ends.
export function startRelay(
  pool: pg.Pool,
  publish: Publisher,
  intervalMs: number,
  log: FastifyBaseLogger,
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout;
  let round: Promise<void> = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      round = relayOnce(pool, publish)
        .then(
          () => {},
          (err) => log.error({ err }, 'outbox relay round failed'),
        )
        .then(() => {
          if (!stopped) schedule();
        });
    }, intervalMs);
  };
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await round;
  };
}

export const logPublisher =
  (log: FastifyBaseLogger): Publisher =>
  async (event) => {
    log.info({ event }, 'event published');
  };
