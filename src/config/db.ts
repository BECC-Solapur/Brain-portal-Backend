import { Pool } from 'pg';
import env from './env';
import fs from 'fs';
import path from 'path';

const pool = new Pool({
  ...(process.env.SUPABASE_DATABASE_URL ? {
    connectionString: process.env.SUPABASE_DATABASE_URL,
    ssl: {
      rejectUnauthorized: true,
      ...(process.env.POSTGRES_SSL_CA_PATH ? { ca: fs.readFileSync(path.resolve(__dirname, '..', '..', process.env.POSTGRES_SSL_CA_PATH), 'utf8') } : {}),
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
  connectionTimeoutMillis: process.env.SUPABASE_DATABASE_URL ? 15000 : 2000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err.message);
  process.exit(-1);
});

pool.on('connect', () => {
  if (env.NODE_ENV !== 'production') {
    console.debug('[DB] New client connection acquired');
  }
});

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    if (env.NODE_ENV !== 'production') {
      const duration = Date.now() - start;
      console.debug(`[DB] ${duration}ms | ${res.rowCount} rows | ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
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
    const { rows } = await query('SELECT NOW() AS now');
    const target = process.env.SUPABASE_DATABASE_URL ? new URL(process.env.SUPABASE_DATABASE_URL) : undefined;
    console.log(`✅ Database connected: ${target ? `${target.hostname}:${target.port || '5432'}${target.pathname}` : `${env.db.host}:${env.db.port}/${env.db.database}`}`);
    console.log(`   Server time: ${rows[0].now}`);
  } catch (err: any) {
    console.error(`❌ Database connection failed: ${err.message}`);
    throw err;
  }
}

export default pool;
