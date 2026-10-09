import pg from 'pg';
import { config } from './config.js';

// DATE e TIME chegam como texto para evitar deslocamentos de fuso horário.
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'
pg.types.setTypeParser(1083, (v) => v.slice(0, 5)); // time -> 'HH:MM'
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10)); // bigint (contagens e ids)

const connection = {
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
};

/** Conexão avulsa (usada para escutar avisos LISTEN/NOTIFY entre os serviços). */
export function newClient() {
  return new pg.Client(connection);
}

export const pool = new pg.Pool({
  ...connection,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => console.error('[db] erro em conexão ociosa:', err.message));

export function q(text, params) {
  return pool.query(text, params);
}

/** Executa fn dentro de uma transação. Faz ROLLBACK em qualquer erro. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
