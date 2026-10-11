import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../config.js';

/** FPT_ITT.1: the connection to a separate database server is protected with TLS when configured. */
function ssl(): pg.PoolConfig['ssl'] {
  if (config.DATABASE_SSL === 'disable') return undefined;
  return {
    rejectUnauthorized: config.DATABASE_SSL === 'verify-full',
    ca: config.DATABASE_SSL_CA_FILE ? readFileSync(config.DATABASE_SSL_CA_FILE, 'utf8') : undefined,
    minVersion: 'TLSv1.2',
  };
}

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, ssl: ssl() });

export type Db = pg.Pool | pg.PoolClient;

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const rows = await query<T>(sql, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
