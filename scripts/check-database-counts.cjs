require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const caPath = process.env.POSTGRES_SSL_CA_PATH;
const client = new Client({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: true, ...(caPath ? { ca: fs.readFileSync(path.resolve(__dirname, '..', caPath), 'utf8') } : {}) },
  connectionTimeoutMillis: 15000,
});
const quote = value => '"' + value.replaceAll('"', '""') + '"';
(async () => {
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL statement_timeout = 30000');
  const { rows: tables } = await client.query(`
    SELECT t.table_schema, t.table_name,
      (SELECT COUNT(*)::int FROM information_schema.columns c
       WHERE c.table_schema=t.table_schema AND c.table_name=t.table_name) AS columns
    FROM information_schema.tables t
    WHERE t.table_type='BASE TABLE'
      AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY t.table_schema, t.table_name
  `);
  const counts = [];
  for (const table of tables) {
    const { rows } = await client.query('SELECT COUNT(*) AS rows FROM ' + quote(table.table_schema) + '.' + quote(table.table_name));
    counts.push({ schema: table.table_schema, table: table.table_name, columns: table.columns, rows: rows[0].rows });
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), tables: counts }, null, 2));
})().catch(error => {
  console.error('Count failed: ' + (error.code || 'UNKNOWN') + ' ' + error.message);
  process.exitCode = 1;
}).finally(() => client.end());
