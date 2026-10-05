import pg from 'pg';
import { config } from '../config.js';

// Return timestamps as ISO strings and bigint counts as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const needsSsl = /sslmode=require/.test(config.DATABASE_URL) || /\.proxy\.rlwy\.net/.test(config.DATABASE_URL);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  // Every connection sees only our schema first; n8n tables live in public.
  options: `-c search_path=${config.DB_SCHEMA},public`,
});

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  return db.query<T>(text, params);
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
