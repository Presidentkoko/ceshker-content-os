import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Migrations ship as .sql next to the source; the compiled build reads them from the source tree.
const dir = [path.join(here, 'migrations'), path.resolve(here, '../../../server/db/migrations')];

/**
 * Forward-only migrations. Each file runs once inside a transaction, guarded by
 * an advisory lock so two replicas starting together cannot race.
 */
export async function migrate(log = console.log) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${config.DB_SCHEMA}`);
    await client.query(`SET search_path TO ${config.DB_SCHEMA}, public`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));

    let folder = '';
    for (const d of dir) {
      try {
        await readdir(d);
        folder = d;
        break;
      } catch {}
    }
    if (!folder) throw new Error('Migrations folder not found');
    const files = (await readdir(folder)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(folder, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migration applied: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
