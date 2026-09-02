-- Initial Fleece schema: a virtual-account ledger over one or more real broker
-- accounts.
--
-- Every order the system places goes through a real broker account, but each strategy
-- trades under its own virtual `account`. `position`, `profit` and `ledger_transaction`
-- are therefore all keyed by the virtual account, which is what makes per-strategy
-- P&L possible from a single brokerage statement.
--
-- Prices and sizes are DOUBLE PRECISION rather than NUMERIC. This is deliberate and
-- worth knowing about: all arithmetic — averaging a cost basis, realising a profit —
-- happens in TypeScript against IEEE doubles and is bounded by `roundPrice`, so NUMERIC
-- here would give exact storage of an inexact computation while adding a string
-- conversion on every read. Moving the arithmetic into SQL is the change that would
-- make NUMERIC worth it, and that is a redesign rather than a column type.

CREATE TABLE IF NOT EXISTS account (
  account_id   TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('active', 'inactive')),
  account_type TEXT        NOT NULL CHECK (account_type IN ('live', 'paper', 'mirror')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_status_idx ON account (status);

-- One row per symbol the account has ever traded. A closed position stays at size 0
-- rather than being deleted, because its `avg_price` history and the transactions
-- pointing at it are still the record of what happened.
CREATE TABLE IF NOT EXISTS position (
  account_id TEXT             NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol     TEXT             NOT NULL,
  -- 0 is flat, negative is short.
  size       DOUBLE PRECISION NOT NULL,
  -- Cost basis per share, always positive; reset to 0 when the position closes.
  avg_price  DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol)
);

-- Realised profit to date. Kept alongside `position` rather than summed from
-- `ledger_transaction` on demand because it is read on the path that writes every
-- fill, and it is updated in the same transaction as the position that produced it.
CREATE TABLE IF NOT EXISTS profit (
  account_id TEXT             NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol     TEXT             NOT NULL,
  profit     DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol)
);

-- The append-only trade log, and the source of truth everything else is reconciled
-- against.
--
-- Named `ledger_transaction` rather than `transaction` so that it never has to be
-- read twice in a file that also issues BEGIN and COMMIT.
--
-- `reference_id` is the broker order id and is deliberately not unique: an order that
-- fills in several pieces writes one row per fill.
--
-- `cumulative_size` is what makes a position-history query possible without a second
-- table — each row records the position it left behind, so the history is a projection
-- of this column.
CREATE TABLE IF NOT EXISTS ledger_transaction (
  transaction_id       BIGSERIAL        PRIMARY KEY,
  reference_id         TEXT             NOT NULL,
  account_id           TEXT             NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol               TEXT             NOT NULL,
  occurred_at          TIMESTAMPTZ      NOT NULL,
  avg_price            DOUBLE PRECISION NOT NULL,
  -- Negative means sell.
  size                 DOUBLE PRECISION NOT NULL,
  -- Both NULL together: a trade that only opened or added to a position realised
  -- nothing, which is a different statement from realising zero.
  profit               DOUBLE PRECISION,
  roi                  DOUBLE PRECISION,
  cumulative_size      DOUBLE PRECISION NOT NULL,
  cumulative_profit    DOUBLE PRECISION NOT NULL,
  -- Nullable: the column was added in 2023-03 and rows written before then lack it.
  cumulative_avg_price DOUBLE PRECISION
);

-- `transaction_id` trails each index so that two fills sharing a timestamp still page
-- in a defined order; without it a keyset page can repeat or skip a row.
CREATE INDEX IF NOT EXISTS ledger_transaction_account_symbol_time_idx ON ledger_transaction (account_id, symbol, occurred_at, transaction_id);
CREATE INDEX IF NOT EXISTS ledger_transaction_account_time_idx ON ledger_transaction (account_id, occurred_at, transaction_id);
CREATE INDEX IF NOT EXISTS ledger_transaction_reference_idx ON ledger_transaction (reference_id);

-- Dates are TEXT in ISO `YYYY-MM-DD` form, not DATE. They are market calendar dates
-- rather than instants, and a DATE column comes back through node-postgres as a JS
-- Date at local midnight — which is the previous day for anyone west of UTC. ISO text
-- still compares and sorts correctly, and round-trips exactly.
CREATE TABLE IF NOT EXISTS dividend (
  account_id       TEXT             NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol           TEXT             NOT NULL,
  ex_dividend_date TEXT             NOT NULL CHECK (ex_dividend_date ~ '^\d{4}-\d{2}-\d{2}$'),
  -- The position held going into the ex-dividend date; negative for a short.
  size             DOUBLE PRECISION NOT NULL,
  amount_per_share DOUBLE PRECISION NOT NULL,
  declaration_date TEXT             NOT NULL CHECK (declaration_date ~ '^\d{4}-\d{2}-\d{2}$'),
  record_date      TEXT             NOT NULL CHECK (record_date ~ '^\d{4}-\d{2}-\d{2}$'),
  pay_date         TEXT             NOT NULL CHECK (pay_date ~ '^\d{4}-\d{2}-\d{2}$'),
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol, ex_dividend_date)
);

CREATE INDEX IF NOT EXISTS dividend_account_symbol_idx ON dividend (account_id, symbol);

-- One upstream intent, which may become several broker orders.
CREATE TABLE IF NOT EXISTS order_group (
  group_id         TEXT        PRIMARY KEY,
  correlation_id   TEXT        NOT NULL,
  correlation_type TEXT        NOT NULL,
  status           TEXT        NOT NULL CHECK (status IN ('open', 'closed')),
  account_id       TEXT        NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  documents        JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One index per search property the list endpoint accepts, each paired with
-- created_at. This is what the "exactly one search property, plus a time window" rule
-- on that endpoint exists to enforce: every permitted query is an index range scan,
-- and every rejected one would be a table scan. `correlation_id` is selective enough
-- on its own to need no window.
CREATE INDEX IF NOT EXISTS order_group_correlation_idx ON order_group (correlation_id);
CREATE INDEX IF NOT EXISTS order_group_account_created_idx ON order_group (account_id, created_at);
CREATE INDEX IF NOT EXISTS order_group_type_created_idx ON order_group (correlation_type, created_at);
CREATE INDEX IF NOT EXISTS order_group_status_created_idx ON order_group (status, created_at);

-- `group_id` is NULL for an orphan: an order placed outside the system, or a leg whose
-- parent could not be resolved before the injector stopped waiting. The legacy store
-- spelled this as the sentinel string `_OrphanGroup_`, which every query had to
-- exclude by hand and which callers were forbidden from passing. NULL says the same
-- thing to the database, and the partial index below makes finding orphans cheap.
CREATE TABLE IF NOT EXISTS broker_order (
  broker_order_id   TEXT        PRIMARY KEY,
  symbol            TEXT        NOT NULL,
  account_id        TEXT        NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  broker            TEXT        NOT NULL CHECK (broker IN ('alpaca', 'traderq')),
  broker_account_id TEXT        NOT NULL,
  status            TEXT        NOT NULL,
  group_id          TEXT        REFERENCES order_group (group_id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_order_group_idx ON broker_order (group_id);
CREATE INDEX IF NOT EXISTS broker_order_orphan_idx ON broker_order (created_at) WHERE group_id IS NULL;
CREATE INDEX IF NOT EXISTS broker_order_symbol_created_idx ON broker_order (symbol, created_at);
CREATE INDEX IF NOT EXISTS broker_order_account_created_idx ON broker_order (account_id, created_at);
CREATE INDEX IF NOT EXISTS broker_order_broker_account_created_idx ON broker_order (broker_account_id, created_at);
CREATE INDEX IF NOT EXISTS broker_order_status_created_idx ON broker_order (status, created_at);

-- Every event a broker sent about an order, kept verbatim so an execution can be
-- replayed. Many rows share one `broker_order_id`.
--
-- The legacy collection carried a ten-year TTL index. Postgres has no equivalent, and
-- a ten-year retention window on a system that is not yet two years old is not a
-- policy anything depends on — so nothing expires here. Add a retention job when the
-- table's size says one is needed.
CREATE TABLE IF NOT EXISTS broker_order_record (
  record_id       BIGSERIAL   PRIMARY KEY,
  broker_order_id TEXT        NOT NULL REFERENCES broker_order (broker_order_id) ON DELETE CASCADE,
  record          JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_order_record_order_idx ON broker_order_record (broker_order_id, created_at, record_id);
