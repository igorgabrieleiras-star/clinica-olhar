// Cria (ou atualiza) o usuário de banco RESTRITO usado pelo site público e aplica as permissões mínimas.
// Rode com a conexão do dono do banco (a mesma do painel):
//   DATABASE_URL=postgres://dono:senha@host/db npm run db:public-user
// Opcional: PUBLIC_DB_ROLE (padrão olhar_site) e PUBLIC_DB_PASSWORD (gerada automaticamente se ausente).
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createPublicRole } from '../src/db-roles.js';

const role = config.publicDbRole;
const password = process.env.PUBLIC_DB_PASSWORD || randomBytes(24).toString('base64url');

await migrate({ log: () => {} });
const client = await pool.connect();
try {
  await createPublicRole(client, role, password);
} finally {
  client.release();
  await pool.end();
}

const url = new URL(config.databaseUrl);
url.username = role;
url.password = password;
console.log(`\nUsuário "${role}" pronto, com permissões mínimas para o site público.`);
console.log('Use esta conexão como DATABASE_URL do serviço do SITE PÚBLICO (guarde em local seguro):\n');
console.log('  ' + url.toString() + '\n');
