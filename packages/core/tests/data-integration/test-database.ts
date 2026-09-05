import { migrate } from '../../src/data/migrate';
import { createPool } from '../../src/data/pool';
import { Pool } from 'pg';
import path from 'node:path';

/**
 * These suites need a real PostgreSQL and skip themselves without one, which is why
 * they live apart from the rest: a directory listing says which tests always run.
 *
 * Point FLEECE_TEST_DATABASE_URL at a throwaway database — every table is truncated
 * between tests.
 */
export const TEST_DATABASE_URL = process.env.FLEECE_TEST_DATABASE_URL;

export const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe;

export function migrationsDir(): string {
  return path.resolve(__dirname, '..', '..', 'migrations');
}

/**
 * A pool with the whole schema to itself.
 *
 * Jest runs suites in parallel workers, so two integration suites sharing one database
 * truncate each other's rows mid-test — which fails intermittently and for a reason
 * that looks nothing like the cause. Each suite therefore names its own Postgres schema
 * and gets a `search_path` pointing only at it, so `migrate` builds a private copy of
 * every table and `truncateAll` empties only that copy.
 *
 * The `options` connection parameter is how libpq takes server settings, and
 * node-postgres passes it through: `-c search_path=<schema>`, percent-encoded because
 * it travels in a URL query string.
 */
export async function createTestPool(schema: string): Promise<Pool> {
  if (TEST_DATABASE_URL === undefined) {
    throw new Error('FLEECE_TEST_DATABASE_URL is not set');
  }
  const admin = createPool({ connectionString: TEST_DATABASE_URL, maxConnections: 1 });
  // Identifier, not a value, so it cannot be a bound parameter. The name is a constant
  // in the suite that asks for it, never anything a caller supplies.
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await admin.end();

  const separator = TEST_DATABASE_URL.includes('?') ? '&' : '?';
  const pool = createPool({ connectionString: `${TEST_DATABASE_URL}${separator}options=-c%20search_path%3D${schema}` });
  await migrate(pool, migrationsDir());
  return pool;
}

/**
 * `account` alone would be enough given the cascades, but naming every table means a
 * new one added without a cascade shows up as a leaking test rather than as a
 * mystery failure somewhere later.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE broker_order_record, broker_order, order_fill_progress, ledger_transaction, dividend, profit, position, account RESTART IDENTITY CASCADE');
}

export async function createAccount(pool: Pool, accountId: string, accountType: 'live' | 'paper' | 'mirror' = 'paper'): Promise<void> {
  await pool.query("INSERT INTO account (account_id, name, status, account_type) VALUES ($1, $2, 'active', $3)", [accountId, `account ${accountId}`, accountType]);
}

/**
 * A minimal `broker_order` row, for tests that need one to already exist rather than to
 * exercise the DAO that writes them.
 */
export async function createBrokerOrder(pool: Pool, brokerOrderId: string, accountId: string): Promise<void> {
  await pool.query(
    `INSERT INTO broker_order
       (broker_order_id, account_id, broker, broker_account_id, attribution, symbol, asset_class,
        status, order_class, order_type, side, time_in_force, qty)
     VALUES ($1, $2, 'alpaca', 'TEST-BROKER', 'correlation', 'AAPL', 'equity', 'new', 'regular', 'limit', 'buy', 'day', 1)`,
    [brokerOrderId, accountId],
  );
}
