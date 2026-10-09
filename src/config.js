// Configuração lida das variáveis de ambiente. Nada sensível fica no código.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carrega um arquivo .env simples (apenas em desenvolvimento; em produção use as variáveis do provedor).
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

// Papel deste processo:
//   public → somente o site de agendamento (nenhuma rota administrativa existe neste processo)
//   admin  → somente o painel privado (servido na raiz do domínio interno)
//   all    → os dois juntos, apenas para desenvolvimento local (o painel fica em /admin)
const ROLES = ['public', 'admin', 'all'];
const role = (env.APP_ROLE || (isProd ? '' : 'all')).trim().toLowerCase();

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  isProd,
  role,
  servesPublic: role === 'public' || role === 'all',
  servesAdmin: role === 'admin' || role === 'all',
  // Endereço do site público (usado pelo painel nos links "Ver site" e na prévia da política).
  publicSiteUrl: (env.PUBLIC_SITE_URL || '').replace(/\/$/, ''),
  // Camadas extras do painel (opcionais, somam-se ao login):
  adminAllowedIps: list(env.ADMIN_ALLOWED_IPS),
  adminGateUser: env.ADMIN_GATE_USER || '',
  adminGatePassword: env.ADMIN_GATE_PASSWORD || '',
  // Cloudflare Access (controle de identidade na frente do painel). Ex.: clinicaolhar.cloudflareaccess.com
  cfAccessTeamDomain: (env.ADMIN_CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  cfAccessAud: env.ADMIN_CF_ACCESS_AUD || '',
  // Nome do usuário de banco restrito usado pelo site público (as permissões são reaplicadas a cada migração).
  publicDbRole: env.PUBLIC_DB_ROLE || 'olhar_site',
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || '',
  databaseSsl: env.DATABASE_SSL === 'true' || env.DATABASE_SSL === 'require',
  sessionSecret: env.SESSION_SECRET || '',
  appUrl: (env.APP_URL || '').replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
  metaCapiToken: env.META_CAPI_ACCESS_TOKEN || '',
  metaTestEventCode: env.META_TEST_EVENT_CODE || '',
  metaGraphVersion: env.META_GRAPH_VERSION || 'v21.0',
  adminEmail: env.ADMIN_EMAIL || '',
  adminInitialPassword: env.ADMIN_INITIAL_PASSWORD || '',
  timezone: 'America/Manaus',
  // Permite simular "agora" em testes automatizados. Ignorado em produção.
  fakeNow: !isProd && env.FAKE_NOW ? env.FAKE_NOW : '',
};

export function assertConfig() {
  const problems = [];
  if (!ROLES.includes(config.role)) problems.push(`APP_ROLE deve ser "public" ou "admin" (recebido: "${config.role || 'vazio'}").`);
  if (config.isProd && config.role === 'all') problems.push('APP_ROLE=all é só para desenvolvimento. Em produção publique dois serviços: APP_ROLE=public e APP_ROLE=admin.');
  if ((config.adminGateUser && !config.adminGatePassword) || (!config.adminGateUser && config.adminGatePassword)) problems.push('Defina ADMIN_GATE_USER e ADMIN_GATE_PASSWORD juntos.');
  if (config.adminGatePassword && config.adminGatePassword.length < 16) problems.push('ADMIN_GATE_PASSWORD deve ter pelo menos 16 caracteres.');
  if (!!config.cfAccessTeamDomain !== !!config.cfAccessAud) problems.push('Defina ADMIN_CF_ACCESS_TEAM_DOMAIN e ADMIN_CF_ACCESS_AUD juntos.');
  if (config.isProd && config.role === 'admin' && !config.adminAllowedIps.length && !config.adminGateUser && !config.cfAccessAud) {
    problems.push('Painel em produção sem camada extra de acesso. Configure pelo menos uma: Cloudflare Access (ADMIN_CF_ACCESS_TEAM_DOMAIN + ADMIN_CF_ACCESS_AUD), ADMIN_ALLOWED_IPS ou ADMIN_GATE_USER + ADMIN_GATE_PASSWORD.');
  }
  if (!config.databaseUrl) problems.push('DATABASE_URL não definida.');
  if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET deve ter pelo menos 32 caracteres.');
  if (config.isProd && !config.appUrl.startsWith('https://')) problems.push('APP_URL deve começar com https:// em produção.');
  if (problems.length) {
    console.error('Configuração inválida:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}

/** Data/hora atual (permite FAKE_NOW somente fora de produção, para testes). */
export function now() {
  return config.fakeNow ? new Date(config.fakeNow) : new Date();
}
