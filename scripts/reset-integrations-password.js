// Último recurso, quando o administrador principal perdeu a senha de Integrações E o código de recuperação.
// Precisa de acesso ao servidor/banco (ex.: terminal do Railway), o que comprova a posse da infraestrutura.
// Apaga apenas a senha de Integrações: no próximo acesso, o administrador principal cria uma nova.
//   npm run integrations:reset -- --confirmar
import { clearIntegrationPassword } from '../src/admins.js';
import { pool, q } from '../src/db.js';

if (!process.argv.includes('--confirmar')) {
  console.error('Uso: npm run integrations:reset -- --confirmar');
  process.exit(1);
}
await clearIntegrationPassword();
await q(`INSERT INTO audit_log (admin_id, action, entity) VALUES (NULL, 'integrations_password_cleared_cli', 'integrations')`);
console.log('Senha de Integrações removida. O administrador principal criará uma nova no próximo acesso à área.');
await pool.end();
