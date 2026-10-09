// Cria (ou redefine) um administrador. Uso:
//   npm run create-admin -- email@clinica.com.br "Nome"
// A senha é pedida no terminal (não fica no histórico) e precisa ter 12+ caracteres com letras e números.
import { createInterface } from 'node:readline';
import { migrate } from '../src/migrate.js';
import { createAdmin, passwordProblem } from '../src/auth.js';
import { pool } from '../src/db.js';

const [email, name = 'Administrador'] = process.argv.slice(2);
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Uso: npm run create-admin -- email@clinica.com.br "Nome"');
  process.exit(1);
}

async function ask(question) {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

await migrate({ log: () => {} });
const password = await ask('Senha do administrador: ');
const problem = passwordProblem(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}
await createAdmin({ email, name, password, mustChange: false });
await pool.end();
console.log(`Administrador ${email} pronto. Acesse /admin.`);
