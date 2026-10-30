import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { withTransaction } from '../db.js';
import { loggable } from '../shared/errors.js';

export type OutboxEvent = {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
};
export type Publisher = (event: OutboxEvent) => Promise<void>;

const BATCH_SIZE = 50;

// At-least-once: a crash after publish() but before COMMIT republishes the event, so consumers dedupe by eventId.
// An event with attempts >= maxAttempts stays unpublished: the dead-letter set, queryable with SQL.
// shortcut: row locks and one pool connection are held while publish() runs, so a hung publisher stalls
// its batch, and one slower than idle_in_transaction_session_timeout loses the session (the round fails
// and the batch is republished); add a publish timeout when a real broker replaces logPublisher.
export function relayOnce(
  pool: pg.Pool,
  publish: Publisher,
  opts: { batchSize?: number; maxAttempts?: number; log?: FastifyBaseLogger } = {},
): Promise<number> {
  const { batchSize = BATCH_SIZE, maxAttempts = 10, log } = opts;
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
        const attempts = event.attempts + 1;
        const fields = {
          eventId: event.id,
          aggregateId: event.aggregateId,
          attempts,
          err: loggable(err),
        };
        if (attempts >= maxAttempts) log?.error(fields, 'outbox event parked');
        else log?.warn(fields, 'outbox publish failed');
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
// A round that published a full batch means a backlog, so the next one starts right away.
export function startRelay(
  pool: pg.Pool,
  publish: Publisher,
  intervalMs: number,
  log: FastifyBaseLogger,
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout;
  let round: Promise<void> = Promise.resolve();
  const schedule = (delayMs: number) => {
    timer = setTimeout(() => {
      round = relayOnce(pool, publish, { log })
        .then(
          (published) => (published === BATCH_SIZE ? 0 : intervalMs),
          (err) => {
            log.error({ err: loggable(err) }, 'outbox relay round failed');
            return intervalMs;
          },
        )
        .then((next) => {
          if (!stopped) schedule(next);
        });
    }, delayMs);
  };
  schedule(intervalMs);
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
