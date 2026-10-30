CREATE TABLE accounts (
  id            uuid PRIMARY KEY,
  holder_name   text NOT NULL,
  document      text NOT NULL UNIQUE,
  status        text NOT NULL CHECK (status IN ('ACTIVE','BLOCKED','CLOSED')),
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deposits (
  id              uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id                     uuid PRIMARY KEY,
  idempotency_key        text NOT NULL UNIQUE,
  source_account_id      uuid NOT NULL REFERENCES accounts(id),
  destination_account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents           bigint NOT NULL CHECK (amount_cents > 0),
  status                 text NOT NULL CHECK (status IN ('COMPLETED','FAILED')),
  failure_code           text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (source_account_id <> destination_account_id),
  CHECK ((status = 'FAILED') = (failure_code IS NOT NULL))
);

CREATE TABLE ledger_entries (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id          uuid NOT NULL REFERENCES accounts(id),
  type                text NOT NULL CHECK (type IN ('DEPOSIT','TRANSFER_IN','TRANSFER_OUT')),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  balance_after_cents bigint NOT NULL CHECK (balance_after_cents >= 0),
  deposit_id          uuid REFERENCES deposits(id),
  transfer_id         uuid REFERENCES transfers(id),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(deposit_id, transfer_id) = 1)
);
CREATE INDEX ledger_entries_account_id_idx ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_account_created_idx ON ledger_entries (account_id, created_at);
CREATE INDEX transfers_source_idx ON transfers (source_account_id);
CREATE INDEX transfers_destination_idx ON transfers (destination_account_id);

CREATE TABLE outbox_events (
  id           uuid PRIMARY KEY,
  event_type   text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  last_error   text
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at) WHERE published_at IS NULL;
