import { Pool } from 'pg';
import env from './env';
import fs from 'fs';
import path from 'path';

const dbUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
const sslCaPath = process.env.POSTGRES_SSL_CA_PATH
  ? path.resolve(__dirname, '..', '..', process.env.POSTGRES_SSL_CA_PATH)
  : null;
const hasSslCa = Boolean(sslCaPath && fs.existsSync(sslCaPath));

const pool = new Pool({
  ...(dbUrl ? {
    connectionString: dbUrl,
    ssl: {
      rejectUnauthorized: hasSslCa,
      ...(hasSslCa && sslCaPath ? { ca: fs.readFileSync(sslCaPath, 'utf8') } : {}),
    },
  } : {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
  }),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: dbUrl ? 15000 : 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err.message);
  process.exit(-1);
});

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
  try {
    const res = await pool.query(text, params);
    return { rows: res.rows as T[], rowCount: res.rowCount || 0 };
  } catch (err: any) {
    console.error(`[DB] Query failed: ${err.message}`);
    console.error(`[DB] Query: ${text.slice(0, 200)}`);
    if (params) console.error(`[DB] Params:`, params);
    throw err;
  }
}

export async function tx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<void> {
  try {
    await query('SELECT NOW() AS now');
  } catch (err: any) {
    console.error(`❌ Database connection failed: ${err.message}`);
    throw err;
  }
}

export default pool;
