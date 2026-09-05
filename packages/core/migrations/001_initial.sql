-- Initial Fleece schema: a virtual-account ledger over one or more real broker
-- accounts.
--
-- Every order the system places goes through a real broker account, but each strategy
-- trades under its own virtual `account`. `position`, `profit` and `ledger_transaction`
-- are therefore all keyed by the virtual account, which is what makes per-strategy
-- P&L possible from a single brokerage statement.
--
-- Two decisions run through the whole file.
--
-- **Money and sizes are NUMERIC(28, 9), never DOUBLE PRECISION.** A ledger's failure
-- mode is not a crash but a number that is quietly wrong, and binary floating point
-- supplies them: 0.1 + 0.2 is not 0.3, and a cost basis averaged repeatedly drifts.
-- All arithmetic happens in TypeScript against the `Decimal` type in `@fleece/shared`,
-- which reads and writes these columns as text so nothing is lost in either direction.
-- Nine decimal places covers what the instruments need — Alpaca quotes fractional
-- shares to nine, and crypto needs the room — and money is stored at the same scale
-- even though it is conceptually two, because the spare digits absorb the residue when
-- a cost basis is apportioned across a partial sale.
--
-- **Positions and transactions record total cost, never a unit price.** Adding to a
-- position is then addition and closing one out is subtraction, both exact. A unit
-- price would have to be divided out on every write and then fed into the next one,
-- which is how a cost basis drifts. Average price, premium and ROI are all projections
-- computed on read; see `derivations.ts`. The invariant this buys, per account and
-- symbol, holds exactly rather than approximately:
--
--   position.total_cost = sum(ledger_transaction.total_cost) + sum(ledger_transaction.profit)
--
-- Every transaction moves a position's basis by exactly `total_cost + profit`: an
-- opening trade adds what it cost and realises nothing, and a reduction removes a basis
-- of `-total_cost - profit`. So the position is the running sum of the log, and
-- `reconcileOrderFillProgress` and the integration suites can assert it rather than
-- assume it.
--
-- Dates are ISO `TEXT` rather than `DATE`: they are market calendar dates, and a DATE
-- column comes back through node-postgres as a JS Date at local midnight, which is the
-- previous day for anyone west of UTC. ISO text still compares and sorts correctly, and
-- round-trips exactly.

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
-- rather than being deleted, because its history and the transactions pointing at it
-- are still the record of what happened.
--
-- `asset_class` is NOT part of the primary key, deliberately. A symbol determines its
-- own asset class — an OCC option symbol, `BTC/USD` and `AAPL` cannot collide — so
-- keying on it would let one symbol exist twice under two classes, which is a split
-- position that no query would notice. It is stored rather than derived so that
-- "everything this account holds in options" is an index scan rather than a table scan
-- that parses OCC symbols.
--
-- `size` counts the instrument's own units: shares for equity, coins for crypto, and
-- **contracts** for an option. Two contracts read as 2. The dollars are in `total_cost`
-- regardless, which is what keeps an account holding both stock and options addable.
CREATE TABLE IF NOT EXISTS position (
  account_id  TEXT           NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol      TEXT           NOT NULL,
  asset_class TEXT           NOT NULL CHECK (asset_class IN ('equity', 'option', 'crypto')),
  -- 0 is flat, negative is short.
  size        NUMERIC(28, 9) NOT NULL,
  -- Dollars behind the position, signed the same way as `size`. 0 when flat.
  total_cost  NUMERIC(28, 9) NOT NULL,
  -- Units of the underlying per unit of `size`. 1 for anything but an option.
  multiplier  NUMERIC(28, 9) NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol)
);

CREATE INDEX IF NOT EXISTS position_account_asset_class_idx ON position (account_id, asset_class);

-- Realised profit to date. Kept alongside `position` rather than summed from
-- `ledger_transaction` on demand because it is read on the path that writes every
-- fill, and it is updated in the same transaction as the position that produced it.
--
-- With exact decimals it is now provably equal to that sum rather than approximately
-- equal to it, so it is a cache that cannot drift rather than one that might.
CREATE TABLE IF NOT EXISTS profit (
  account_id  TEXT           NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol      TEXT           NOT NULL,
  asset_class TEXT           NOT NULL CHECK (asset_class IN ('equity', 'option', 'crypto')),
  profit      NUMERIC(28, 9) NOT NULL,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol)
);

CREATE INDEX IF NOT EXISTS profit_account_asset_class_idx ON profit (account_id, asset_class);

-- The append-only trade log, and the source of truth everything else is reconciled
-- against.
--
-- Named `ledger_transaction` rather than `transaction` so that it never has to be
-- read twice in a file that also issues BEGIN and COMMIT.
--
-- `reference_id` is the broker order id and is deliberately not unique: an order that
-- fills in several pieces writes one row per fill.
--
-- `cumulative_size` and `cumulative_total_cost` are what make a position-history query
-- possible without a second table — each row records the position it left behind, so
-- the history is a projection of these columns.
--
-- `multiplier` records what was used to turn the broker's quoted premium into
-- `total_cost`, rather than leaving it to be assumed. An adjusted contract — one a
-- split or a merger has rewritten to deliver something other than 100 shares — is then
-- recoverable and findable instead of silently distorting every figure derived from it.
--
-- There is no `avg_price` and no `roi` column. Both are functions of columns already
-- here, and a stored copy could only ever disagree with them.
CREATE TABLE IF NOT EXISTS ledger_transaction (
  transaction_id        BIGSERIAL      PRIMARY KEY,
  reference_id          TEXT           NOT NULL,
  account_id            TEXT           NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol                TEXT           NOT NULL,
  asset_class           TEXT           NOT NULL CHECK (asset_class IN ('equity', 'option', 'crypto')),
  occurred_at           TIMESTAMPTZ    NOT NULL,
  -- Negative means sell. Counts contracts for an option.
  size                  NUMERIC(28, 9) NOT NULL,
  -- Dollars this transaction moved, signed the same way as `size`.
  total_cost            NUMERIC(28, 9) NOT NULL,
  multiplier            NUMERIC(28, 9) NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  -- NULL means the transaction realised nothing, which is a different statement from
  -- realising zero. A close at exactly the cost basis stores 0.
  profit                NUMERIC(28, 9),
  cumulative_size       NUMERIC(28, 9) NOT NULL,
  cumulative_total_cost NUMERIC(28, 9) NOT NULL,
  cumulative_profit     NUMERIC(28, 9) NOT NULL
);

-- `transaction_id` trails each index so that two fills sharing a timestamp still page
-- in a defined order; without it a keyset page can repeat or skip a row.
CREATE INDEX IF NOT EXISTS ledger_transaction_account_symbol_time_idx ON ledger_transaction (account_id, symbol, occurred_at, transaction_id);
CREATE INDEX IF NOT EXISTS ledger_transaction_account_time_idx ON ledger_transaction (account_id, occurred_at, transaction_id);
CREATE INDEX IF NOT EXISTS ledger_transaction_reference_idx ON ledger_transaction (reference_id, account_id, symbol);

-- How much of one broker order the ledger has actually booked, and for how much.
--
-- This is the idempotency state for applying a fill. Brokers report cumulative progress
-- rather than deltas — every event carries the total filled so far and the average price
-- of that total — so turning an event into a transaction means subtracting what is
-- already recorded, and a report that adds nothing must be a no-op. That is what makes
-- applying a fill safe against the websocket and the REST backfill reporting the same
-- fill, against a restart mid-order, and against two processes racing.
--
-- It was previously summed from `ledger_transaction` on every fill, which made drift
-- impossible because the counter and the record were the same thing. Storing it trades
-- that for a second thing that must agree, and it is safe under exactly one rule:
-- **it is written in the same database transaction as the row it counts, by the one
-- function that writes them.** The summed form survives as a reconciliation query.
--
-- Keyed by account and symbol as well as reference id, exactly as the old sum was
-- grouped, so a reference id that somehow reached two positions cannot merge them.
-- No foreign key to `broker_order`: a transfer writes its synthetic orders inside the
-- fill transaction and a history rebuild may have no broker order at all, and neither
-- should be blocked by a row that is not there yet.
CREATE TABLE IF NOT EXISTS order_fill_progress (
  reference_id       TEXT           NOT NULL,
  account_id         TEXT           NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol             TEXT           NOT NULL,
  -- Signed totals the ledger has booked, in ledger units.
  applied_size       NUMERIC(28, 9) NOT NULL DEFAULT 0,
  applied_total_cost NUMERIC(28, 9) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (reference_id, account_id, symbol)
);

CREATE TABLE IF NOT EXISTS dividend (
  account_id       TEXT           NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  symbol           TEXT           NOT NULL,
  ex_dividend_date TEXT           NOT NULL CHECK (ex_dividend_date ~ '^\d{4}-\d{2}-\d{2}$'),
  -- The position held going into the ex-dividend date; negative for a short.
  size             NUMERIC(28, 9) NOT NULL,
  amount_per_share NUMERIC(28, 9) NOT NULL,
  declaration_date TEXT           NOT NULL CHECK (declaration_date ~ '^\d{4}-\d{2}-\d{2}$'),
  record_date      TEXT           NOT NULL CHECK (record_date ~ '^\d{4}-\d{2}-\d{2}$'),
  pay_date         TEXT           NOT NULL CHECK (pay_date ~ '^\d{4}-\d{2}-\d{2}$'),
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol, ex_dividend_date)
);

CREATE INDEX IF NOT EXISTS dividend_account_symbol_idx ON dividend (account_id, symbol);

-- One order at one broker, tied to the virtual account it trades for.
--
-- **A leg is a row here, not a child table.** A leg of a spread, a bracket or an OTO is
-- a real order at the broker with its own id, instrument, status and fills, so it gets
-- its own row and names its parent in `parent_broker_order_id`.
--
-- That column has an index but **no foreign key**, and that is the important part. The
-- converter emits a composite parent before its legs, so the row it names normally
-- exists — but a leg reaching us without its parent, for any reason at all, must still
-- land. A foreign key turns "the parent row is missing" into "the leg is rejected", and
-- a rejected leg is a fill the ledger never learns about.
--
-- `symbol` is NULL only for a composite parent that trades no instrument of its own,
-- and that absence is load-bearing: it is what marks a row whose numbers mean something
-- different from every other row's. On a parent (`order_class = 'mleg' AND symbol IS
-- NULL`):
--
--   * `qty` counts **spreads**, not contracts;
--   * `limit_price` and `filled_avg_price` are the package's **signed net** — negative
--     for a credit received, positive for a debit paid — where everywhere else a price
--     is unsigned.
--
-- The parent is recorded rather than discarded because it is the id everything upstream
-- holds: what a placement returns, what a cancel names, what a tracking request claims.
-- It books no fill; its legs carry the real instruments at real prices. The net price is
-- kept here because it is what the spread was actually traded at and it exists nowhere
-- else — the legs price themselves at nothing.
--
-- `attribution` records **how** the account was decided, and replaces the previous
-- definition of an orphan — an order with no group — which disappeared with order
-- groups. An orphan is now `attribution = 'default'`: nobody claimed it, so it was
-- booked to a catch-all account rather than dropped, because the shares moved whether
-- or not a strategy asked for them.
--
-- **`account_id` and `attribution` are written once and never updated.** Nothing in the
-- data layer offers a way to change them, deliberately: every `ledger_transaction`,
-- `position`, `profit` row and `order_fill_progress` counter an order produces is keyed
-- by the account it was booked to, so moving the order alone strands all of them and
-- makes the next cumulative report book the whole fill again under the new account.
-- A mis-booked order is corrected by transferring the *position*, not by relabelling
-- the order.
--
-- `status` has no CHECK. A status this system has not caught up with must be recorded,
-- not rejected: a rejected row is a fill that never lands. The columns that do carry a
-- CHECK are the ones our own converter produces, where a violation means our code has
-- diverged from itself.
--
-- `filled_qty` and `filled_avg_price` are what the **broker** last reported, in the
-- broker's own units — contracts and a premium per share for an option. They are for
-- querying and display. What the **ledger** has booked is `order_fill_progress`, in
-- ledger units. The two are deliberately different numbers with different names so that
-- nothing accounts from the wrong one.
CREATE TABLE IF NOT EXISTS broker_order (
  broker_order_id        TEXT           PRIMARY KEY,
  parent_broker_order_id TEXT,
  account_id             TEXT           NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
  broker                 TEXT           NOT NULL CHECK (broker IN ('alpaca', 'traderq')),
  broker_account_id      TEXT           NOT NULL,
  attribution            TEXT           NOT NULL CHECK (attribution IN ('correlation', 'parent', 'tracking', 'internal', 'default')),

  symbol                 TEXT,
  asset_class            TEXT           NOT NULL CHECK (asset_class IN ('equity', 'option', 'crypto')),
  multiplier             NUMERIC(28, 9) NOT NULL DEFAULT 1 CHECK (multiplier > 0),

  status                 TEXT           NOT NULL,
  order_class            TEXT           NOT NULL CHECK (order_class IN ('regular', 'oco', 'oto', 'bracket', 'mleg')),
  order_type             TEXT           NOT NULL CHECK (order_type IN ('market', 'limit', 'stop', 'stop_limit')),
  side                   TEXT           CHECK (side IN ('buy', 'sell')),
  position_intent        TEXT           CHECK (position_intent IN ('buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close')),
  time_in_force          TEXT           NOT NULL CHECK (time_in_force IN ('day', 'gtc', 'opg', 'cls', 'ioc', 'fok')),
  extended_hours         BOOLEAN        NOT NULL DEFAULT false,

  -- Signed: negative for a sell. Counts contracts for an option.
  qty                    NUMERIC(28, 9) NOT NULL,
  -- A leg's share of its parent's quantity. Multi-leg legs only.
  ratio_qty              NUMERIC(28, 9),
  limit_price            NUMERIC(28, 9),
  stop_price             NUMERIC(28, 9),
  filled_qty             NUMERIC(28, 9) NOT NULL DEFAULT 0,
  filled_avg_price       NUMERIC(28, 9),

  submitted_at           TIMESTAMPTZ,
  filled_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),

  -- A leg cannot be its own parent, which is the one cycle a self-reference makes easy
  -- to write by accident.
  CONSTRAINT broker_order_parent_not_self CHECK (parent_broker_order_id IS DISTINCT FROM broker_order_id),
  -- Only a composite parent may trade no instrument.
  CONSTRAINT broker_order_symbol_present CHECK (symbol IS NOT NULL OR order_class = 'mleg')
);

-- One index per search property the list endpoint accepts, each paired with
-- created_at. This is what the "exactly one search property, plus a time window" rule
-- on that endpoint exists to enforce: every permitted query is an index range scan,
-- and every rejected one would be a table scan.
CREATE INDEX IF NOT EXISTS broker_order_parent_idx ON broker_order (parent_broker_order_id) WHERE parent_broker_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS broker_order_orphan_idx ON broker_order (created_at) WHERE attribution = 'default';
CREATE INDEX IF NOT EXISTS broker_order_symbol_created_idx ON broker_order (symbol, created_at);
CREATE INDEX IF NOT EXISTS broker_order_account_created_idx ON broker_order (account_id, created_at);
CREATE INDEX IF NOT EXISTS broker_order_broker_account_created_idx ON broker_order (broker_account_id, created_at);
CREATE INDEX IF NOT EXISTS broker_order_status_created_idx ON broker_order (status, created_at);
CREATE INDEX IF NOT EXISTS broker_order_asset_class_created_idx ON broker_order (asset_class, created_at);

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
