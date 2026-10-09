import { readdirSync } from 'node:fs';
import path from 'node:path';
import { config, assertConfig, ROOT } from './src/config.js';
import { pool, q } from './src/db.js';
import { migrate } from './src/migrate.js';
import { createApp, runRetention } from './src/app.js';
import { createAdmin } from './src/auth.js';
import { listenForSettingsChanges } from './src/settings.js';
import { createPublicRole } from './src/db-roles.js';

assertConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (config.servesAdmin) {
  // O serviço do painel é o dono do esquema: aplica migrações e mantém as permissões do usuário do site.
  await migrate();

  // Opcional: cria/atualiza automaticamente o usuário restrito do site público (evita passo manual na implantação).
  if (process.env.PUBLIC_DB_PASSWORD) {
    if (process.env.PUBLIC_DB_PASSWORD.length < 20) {
      console.error('[banco] PUBLIC_DB_PASSWORD deve ter pelo menos 20 caracteres.');
      process.exit(1);
    }
    const c = await pool.connect();
    try {
      await createPublicRole(c, config.publicDbRole, process.env.PUBLIC_DB_PASSWORD);
      console.log(`[banco] usuário restrito "${config.publicDbRole}" do site público pronto.`);
    } catch (err) {
      console.error(`[banco] não foi possível criar o usuário "${config.publicDbRole}" (${err.message}). Crie-o com: npm run db:public-user`);
    } finally {
      c.release();
    }
  }

  // Primeiro acesso: cria o administrador a partir das variáveis de ambiente, somente se ainda não houver nenhum.
  const { rows } = await q('SELECT count(*) AS n FROM admins');
  if (rows[0].n === 0) {
    if (config.adminEmail && config.adminInitialPassword) {
      await createAdmin({ email: config.adminEmail, name: 'Administrador', password: config.adminInitialPassword, mustChange: true });
      console.log(`[admin] administrador inicial criado para ${config.adminEmail}. A troca de senha será exigida no primeiro acesso.`);
    } else {
      console.warn('[admin] nenhum administrador cadastrado. Defina ADMIN_EMAIL e ADMIN_INITIAL_PASSWORD ou rode: npm run create-admin');
    }
  }
} else {
  // Site público: não altera o esquema. Aguarda o painel aplicar as migrações (ordem de implantação livre).
  const expected = readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'));
  for (let attempt = 1; ; attempt++) {
    try {
      const { rows } = await q('SELECT id FROM schema_migrations');
      const done = new Set(rows.map((r) => r.id));
      if (expected.every((f) => done.has(f))) break;
      console.log('[site] aguardando o serviço do painel aplicar as migrações do banco...');
    } catch (err) {
      console.log(`[site] banco ainda não preparado (${err.code || err.message}). Nova tentativa em 5 s...`);
    }
    if (attempt >= 60) { console.error('[site] o banco não ficou pronto em 5 minutos. Verifique o serviço do painel.'); process.exit(1); }
    await sleep(5000);
  }

  // Menor privilégio: o site público não deve conseguir ler dados administrativos.
  const { rows: [p] } = await q(`SELECT current_user AS u, has_table_privilege(current_user, 'admins', 'SELECT') AS admins,
                                        has_table_privilege(current_user, 'appointments', 'DELETE') AS del`);
  if (p.admins || p.del) {
    const msg = `[site] o usuário de banco "${p.u}" tem permissões administrativas. Use um usuário restrito (npm run db:public-user).`;
    if (config.isProd && process.env.ALLOW_PRIVILEGED_PUBLIC_DB !== 'true') { console.error(msg); process.exit(1); }
    console.warn(msg + ' (permitido fora de produção)');
  } else {
    console.log(`[site] conectado ao banco com o usuário restrito "${p.u}".`);
  }
}

if (config.servesPublic && !config.servesAdmin) {
  // Alterações feitas no painel chegam ao site público na hora (PostgreSQL LISTEN/NOTIFY).
  listenForSettingsChanges();
  // Informa ao painel o estado deste serviço, sem expor segredos.
  await q(
    `INSERT INTO service_status (service, info, updated_at) VALUES ('public', $1, now())
     ON CONFLICT (service) DO UPDATE SET info = EXCLUDED.info, updated_at = now()`,
    [JSON.stringify({ capiTokenConfigured: !!config.metaCapiToken, testEventCode: !!config.metaTestEventCode, appUrl: config.appUrl })],
  ).catch((e) => console.error('[site] não foi possível registrar o estado do serviço:', e.message));
}

const server = createApp();
server.listen(config.port, () => console.log(`[olhar] serviço "${config.role}" ouvindo na porta ${config.port}`));

let retention;
if (config.servesAdmin) {
  // Rotina de retenção (LGPD) roda só no serviço do painel, que tem permissão para anonimizar.
  runRetention().catch((e) => console.error('[retenção]', e.message));
  retention = setInterval(() => runRetention().catch((e) => console.error('[retenção]', e.message)), 6 * 60 * 60 * 1000);
  retention.unref();
}

function shutdown(signal) {
  console.log(`[olhar] ${signal} recebido, encerrando...`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
