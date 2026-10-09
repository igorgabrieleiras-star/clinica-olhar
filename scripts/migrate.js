import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';

await migrate();
await pool.end();
console.log('[migrate] banco de dados atualizado.');
