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

export async function createTestPool(): Promise<Pool> {
  if (TEST_DATABASE_URL === undefined) {
    throw new Error('FLEECE_TEST_DATABASE_URL is not set');
  }
  const pool = createPool({ connectionString: TEST_DATABASE_URL });
  await migrate(pool, migrationsDir());
  return pool;
}

/**
 * `account` alone would be enough given the cascades, but naming every table means a
 * new one added without a cascade shows up as a leaking test rather than as a
 * mystery failure somewhere later.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE broker_order_record, broker_order, order_group, ledger_transaction, dividend, profit, position, account RESTART IDENTITY CASCADE');
}

export async function createAccount(pool: Pool, accountId: string, accountType: 'live' | 'paper' | 'mirror' = 'paper'): Promise<void> {
  await pool.query("INSERT INTO account (account_id, name, status, account_type) VALUES ($1, $2, 'active', $3)", [accountId, `account ${accountId}`, accountType]);
}

export async function createOrderGroup(pool: Pool, groupId: string, accountId: string): Promise<void> {
  await pool.query("INSERT INTO order_group (group_id, correlation_id, correlation_type, status, account_id) VALUES ($1, $1, 'test', 'open', $2)", [groupId, accountId]);
}
