import { LoggerFactory } from '@fleece/shared';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const logger = LoggerFactory.getLogger('Migrator');

/** `migrations/` sits next to `dist/`, so resolve up out of whichever we are running from. */
export function defaultMigrationsDir(): string {
  return path.resolve(__dirname, '..', '..', 'migrations');
}

/** `001_initial.sql` — a numeric sequence, an underscore, then a descriptive name. */
const MIGRATION_FILENAME = /^(\d+)_[A-Za-z0-9_-]+\.sql$/;

interface MigrationFile {
  readonly file: string;
  readonly sequence: number;
}

/**
 * Migration files in the order they must be applied.
 *
 * Order is everything: a migration that adds a column runs against the table an
 * earlier one created, so applying them out of order either fails loudly or, worse,
 * succeeds into a schema that differs from everyone else's.
 *
 * Two things could silently get this wrong, so both are ruled out here rather than
 * left to convention:
 *
 * - `readdirSync` order is filesystem-dependent and not guaranteed by Node. It comes
 *   back sorted on APFS and effectively arbitrary on ext4, which is the difference
 *   between a developer's Mac and CI.
 * - A plain `.sort()` is lexicographic, so it only yields numeric order while every
 *   filename is zero-padded to the same width — `10_x.sql` sorts before `2_x.sql`.
 *   The sequence is parsed and compared as a number instead, so padding is cosmetic.
 */
export function listMigrationFiles(migrationsDir: string): ReadonlyArray<string> {
  const migrations: MigrationFile[] = [];
  const bySequence = new Map<number, string>();

  // withFileTypes so a directory that happens to end in .sql is skipped rather than
  // failing the name check.
  for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) {
      continue;
    }
    const file = entry.name;
    const match = MIGRATION_FILENAME.exec(file);
    if (match === null) {
      throw new Error(`Migration "${file}" is not named <sequence>_<name>.sql, for example 002_add_artifacts.sql. Rename it so its position in the order is unambiguous.`);
    }

    const sequence = Number(match[1]);
    // Two branches each adding an `002_` collide on merge, and which one ran first
    // would then depend on the filesystem. Fail rather than pick one.
    const existing = bySequence.get(sequence);
    if (existing !== undefined) {
      throw new Error(`Migrations "${existing}" and "${file}" share sequence number ${sequence}. Renumber one of them so the order is defined.`);
    }
    bySequence.set(sequence, file);
    migrations.push({ file, sequence });
  }

  return migrations.sort((left, right) => left.sequence - right.sequence).map((migration) => migration.file);
}

/**
 * Applies every `.sql` file in `migrationsDir` that has not been applied yet, in
 * filename order, each in its own transaction. Safe to run on every process start, by whichever of them starts first.
 */
export async function migrate(pool: Pool, migrationsDir: string = defaultMigrationsDir()): Promise<ReadonlyArray<string>> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');

  const applied = await pool.query<{ id: string }>('SELECT id FROM schema_migration');
  const appliedIds = new Set(applied.rows.map((row) => row.id));

  const files = listMigrationFiles(migrationsDir);

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (appliedIds.has(file)) {
      continue;
    }
    logger.info(`Applying migration ${file}.`);
    const sql = readFileSync(path.join(migrationsDir, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
      logger.info(`Applied migration ${file}.`);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Migration ${file} failed and was rolled back.`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  if (newlyApplied.length === 0) {
    logger.info(`Schema is up to date (${files.length} migrations already applied).`);
  }
  return newlyApplied;
}
