// Administradores: convites por link (uso único, 24 h) e senha exclusiva da área de Integrações.
// Tokens, senhas e códigos de recuperação nunca são gravados nem registrados em log: somente hashes.
import { randomBytes } from 'node:crypto';
import { q, tx } from './db.js';
import { hashPassword, verifyPassword, passwordProblem, tokenHash } from './auth.js';

export const ROLES = { principal: 'Administrador principal', admin: 'Administrador' };
export const INVITE_HOURS = 24;
export const INTEGRATIONS_IDLE_MINUTES = 10;
const UNLOCK_MAX_FAILED = 5;
const UNLOCK_LOCK_MINUTES = 15;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 160 ? e : null;
}
export function cleanAdminName(v) {
  const n = String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= 80 ? n : null;
}

// ---------------------------------------------------------------- Convites
export async function listAdmins() {
  const { rows: admins } = await q(
    `SELECT id, name, email, role, disabled_at IS NOT NULL AS disabled,
            to_char(last_login_at AT TIME ZONE 'America/Manaus', 'DD/MM/YYYY HH24:MI') AS last_login
       FROM admins ORDER BY (role = 'principal') DESC, created_at, id`,
  );
  const { rows: invites } = await q(
    `SELECT id, name, email, role, expires_at < now() AS expired,
            to_char(expires_at AT TIME ZONE 'America/Manaus', 'DD/MM/YYYY HH24:MI') AS expires
       FROM admin_invites
      WHERE used_at IS NULL AND revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.email = admin_invites.email)
      ORDER BY id DESC`,
  );
  return {
    admins: admins.map((a) => ({ ...a, status: a.disabled ? 'desativado' : 'ativo' })),
    invites: invites.map((i) => ({ ...i, status: i.expired ? 'convite_expirado' : 'convite_pendente' })),
  };
}

/** Cria (ou recria) o convite de um e-mail. Retorna o token em texto só nesta resposta. */
export async function createInvite({ email, name, role, createdBy }) {
  const token = randomBytes(32).toString('base64url');
  await tx(async (c) => {
    const { rows } = await c.query('SELECT 1 FROM admins WHERE email = $1', [email]);
    if (rows.length) { const e = new Error('Já existe um administrador com este e-mail.'); e.code = 'EXISTS'; throw e; }
    // Um convite válido por e-mail: os anteriores deixam de funcionar.
    await c.query('UPDATE admin_invites SET revoked_at = now() WHERE lower(email) = $1 AND used_at IS NULL AND revoked_at IS NULL', [email]);
    await c.query(
      `INSERT INTO admin_invites (email, name, role, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,$4, now() + interval '${INVITE_HOURS} hours', $5)`,
      [email, name, role, tokenHash(token), createdBy],
    );
  });
  return token;
}

export async function resendInvite(id, createdBy) {
  const { rows } = await q('SELECT email, name, role FROM admin_invites WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL', [id]);
  if (!rows[0]) return null;
  return { ...rows[0], token: await createInvite({ ...rows[0], createdBy }) };
}

export async function revokeInvite(id) {
  const { rowCount } = await q('UPDATE admin_invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL', [id]);
  return rowCount > 0;
}

async function validInvite(token, c = null) {
  if (typeof token !== 'string' || token.length < 30 || token.length > 100) return null;
  const db = c || { query: q };
  const { rows } = await db.query(
    `SELECT * FROM admin_invites WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()${c ? ' FOR UPDATE' : ''}`,
    [tokenHash(token)],
  );
  return rows[0] || null;
}

/** Dados do convite para a tela de ativação (não consome o convite). */
export async function inviteInfo(token) {
  const inv = await validInvite(token);
  return inv ? { email: inv.email, name: inv.name, role: inv.role, roleLabel: ROLES[inv.role] } : null;
}

/** Ativa a conta: confere o e-mail, define nome e senha próprios e invalida o convite (uso único). */
export async function acceptInvite({ token, email, name, password }) {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, field: 'password', error: problem };
  const cleanName = cleanAdminName(name);
  if (!cleanName) return { ok: false, field: 'name', error: 'Informe seu nome (2 a 80 caracteres).' };
  const hash = await hashPassword(password);
  return tx(async (c) => {
    const inv = await validInvite(token, c);
    if (!inv) return { ok: false, field: 'token', error: 'Este convite não é válido, já foi usado ou expirou. Peça um novo convite ao administrador principal.' };
    if (cleanEmail(email) !== inv.email) return { ok: false, field: 'email', error: 'O e-mail não corresponde ao convite.' };
    const { rows: exists } = await c.query('SELECT 1 FROM admins WHERE email = $1', [inv.email]);
    if (exists.length) return { ok: false, field: 'email', error: 'Este e-mail já tem acesso ao painel.' };
    const { rows } = await c.query(
      `INSERT INTO admins (email, name, password_hash, must_change_password, role, invited_by) VALUES ($1,$2,$3,false,$4,$5) RETURNING id`,
      [inv.email, cleanName, hash, inv.role, inv.created_by],
    );
    await c.query('UPDATE admin_invites SET used_at = now() WHERE id = $1', [inv.id]);
    await c.query(`INSERT INTO audit_log (admin_id, action, entity, entity_id, details) VALUES ($1, 'invite_accepted', 'admin', $2, $3)`, [rows[0].id, String(rows[0].id), JSON.stringify({ role: inv.role })]);
    return { ok: true, id: rows[0].id };
  });
}

async function activePrincipals(c, exceptId) {
  const { rows } = await c.query("SELECT count(*) AS n FROM admins WHERE role = 'principal' AND disabled_at IS NULL AND id <> $1", [exceptId]);
  return rows[0].n;
}

/** Altera nível ou status. Nunca deixa o sistema sem um administrador principal ativo. */
export async function updateAdmin(id, { role, disabled }, actorId) {
  if (id === actorId) return { ok: false, error: 'Você não pode alterar o seu próprio acesso.' };
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM admins WHERE id = $1 FOR UPDATE', [id]);
    const a = rows[0];
    if (!a) return { ok: false, status: 404, error: 'Administrador não encontrado.' };
    const losesPrincipal = a.role === 'principal' && !a.disabled_at && (role === 'admin' || disabled === true);
    if (losesPrincipal && (await activePrincipals(c, id)) === 0) return { ok: false, error: 'O sistema precisa de pelo menos um administrador principal ativo.' };
    if (role && role !== a.role) await c.query('UPDATE admins SET role = $2 WHERE id = $1', [id, role]);
    if (disabled === true && !a.disabled_at) {
      await c.query('UPDATE admins SET disabled_at = now() WHERE id = $1', [id]);
      await c.query('DELETE FROM admin_sessions WHERE admin_id = $1', [id]); // encerra as sessões abertas
    }
    if (disabled === false && a.disabled_at) await c.query('UPDATE admins SET disabled_at = NULL, failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);
    if (role && role !== a.role) await c.query('UPDATE admin_sessions SET integrations_until = NULL WHERE admin_id = $1', [id]);
    return { ok: true, email: a.email };
  });
}

export async function removeAdmin(id, actorId) {
  if (id === actorId) return { ok: false, error: 'Você não pode remover a sua própria conta.' };
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM admins WHERE id = $1 FOR UPDATE', [id]);
    const a = rows[0];
    if (!a) return { ok: false, status: 404, error: 'Administrador não encontrado.' };
    if (a.role === 'principal' && (await activePrincipals(c, id)) === 0) return { ok: false, error: 'Não é possível remover o último administrador principal.' };
    await c.query('DELETE FROM admins WHERE id = $1', [id]); // sessões saem junto (ON DELETE CASCADE); o histórico fica
    return { ok: true, email: a.email };
  });
}

// ---------------------------------------------------------------- Senha das Integrações
function recoveryCode() {
  // 4 grupos de 5 caracteres sem letras ambíguas (fácil de anotar), ~100 bits.
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += abc[b[i] % abc.length] + (i % 5 === 4 && i < 19 ? '-' : '');
  return s;
}
const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function integrationStatus(admin) {
  const { rows } = await q(`SELECT locked_until > now() AS locked, to_char(updated_at AT TIME ZONE 'America/Manaus', 'DD/MM/YYYY HH24:MI') AS updated FROM integration_security WHERE id = 1`);
  const until = admin.integrationsUntil ? new Date(admin.integrationsUntil) : null;
  return {
    configured: !!rows[0],
    locked: !!rows[0]?.locked,
    updated: rows[0]?.updated || null,
    unlocked: !!until && until > new Date(),
    idleMinutes: INTEGRATIONS_IDLE_MINUTES,
  };
}

/** Primeira configuração: só quando ainda não existe senha. Devolve o código de recuperação uma única vez. */
export async function setupIntegrationPassword(adminId, password) {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  const code = recoveryCode();
  const { rowCount } = await q(
    `INSERT INTO integration_security (id, password_hash, recovery_hash, created_by) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [await hashPassword(password), await hashPassword(normCode(code)), adminId],
  );
  if (!rowCount) return { ok: false, error: 'A senha de Integrações já foi criada. Use “Alterar senha”.' };
  return { ok: true, recoveryCode: code };
}

/** Confere a senha com limite de tentativas e bloqueio temporário. */
export async function checkIntegrationPassword(password) {
  const { rows } = await q('SELECT *, locked_until > now() AS locked FROM integration_security WHERE id = 1');
  const s = rows[0];
  if (!s) return { ok: false, reason: 'setup' };
  if (s.locked) return { ok: false, reason: 'locked' };
  if (await verifyPassword(String(password || ''), s.password_hash)) {
    if (s.failed_attempts) await q('UPDATE integration_security SET failed_attempts = 0, locked_until = NULL WHERE id = 1');
    return { ok: true };
  }
  const failed = s.failed_attempts + 1;
  if (failed >= UNLOCK_MAX_FAILED) {
    await q(`UPDATE integration_security SET failed_attempts = 0, locked_until = now() + interval '${UNLOCK_LOCK_MINUTES} minutes' WHERE id = 1`);
    return { ok: false, reason: 'locked' };
  }
  await q('UPDATE integration_security SET failed_attempts = $1 WHERE id = 1', [failed]);
  return { ok: false, reason: 'invalid', left: UNLOCK_MAX_FAILED - failed };
}

export async function unlockSession(sessionId) {
  await q(`UPDATE admin_sessions SET integrations_until = now() + interval '${INTEGRATIONS_IDLE_MINUTES} minutes' WHERE id = $1`, [sessionId]);
}
/** Renova o prazo a cada uso (expira após 10 minutos sem atividade). Retorna false se já expirou. */
export async function touchUnlock(sessionId) {
  const { rowCount } = await q(
    `UPDATE admin_sessions SET integrations_until = now() + interval '${INTEGRATIONS_IDLE_MINUTES} minutes'
      WHERE id = $1 AND integrations_until > now()`,
    [sessionId],
  );
  return rowCount > 0;
}
export async function lockSession(sessionId) {
  await q('UPDATE admin_sessions SET integrations_until = NULL WHERE id = $1', [sessionId]);
}
export async function revokeIntegrationSessions() {
  const { rowCount } = await q('UPDATE admin_sessions SET integrations_until = NULL WHERE integrations_until IS NOT NULL');
  return rowCount;
}

export async function changeIntegrationPassword(current, next) {
  const chk = await checkIntegrationPassword(current);
  if (!chk.ok) return { ok: false, reason: chk.reason, error: chk.reason === 'locked' ? 'Muitas tentativas. Aguarde 15 minutos.' : 'A senha atual de Integrações está incorreta.' };
  const problem = passwordProblem(next);
  if (problem) return { ok: false, error: problem };
  if (next === current) return { ok: false, error: 'Escolha uma senha diferente da atual.' };
  await q('UPDATE integration_security SET password_hash = $1, updated_at = now() WHERE id = 1', [await hashPassword(next)]);
  await revokeIntegrationSessions();
  return { ok: true };
}

/**
 * Recuperação: exige a senha da conta do administrador principal (autenticação recente, feita agora)
 * e o código de recuperação entregue na criação (segundo fator). Gera um novo código.
 */
export async function resetIntegrationPassword({ adminId, accountPassword, recoveryCode: code, next }) {
  const { rows: [a] } = await q('SELECT password_hash FROM admins WHERE id = $1', [adminId]);
  const { rows: [s] } = await q('SELECT *, locked_until > now() AS locked FROM integration_security WHERE id = 1');
  if (!s) return { ok: false, error: 'A senha de Integrações ainda não foi criada.' };
  if (s.locked) return { ok: false, error: 'Muitas tentativas. Aguarde 15 minutos.' };
  const accountOk = a && (await verifyPassword(String(accountPassword || ''), a.password_hash));
  const codeOk = await verifyPassword(normCode(code), s.recovery_hash);
  if (!accountOk || !codeOk) {
    const failed = s.failed_attempts + 1;
    if (failed >= UNLOCK_MAX_FAILED) await q(`UPDATE integration_security SET failed_attempts = 0, locked_until = now() + interval '${UNLOCK_LOCK_MINUTES} minutes' WHERE id = 1`);
    else await q('UPDATE integration_security SET failed_attempts = $1 WHERE id = 1', [failed]);
    return { ok: false, error: 'Senha da conta ou código de recuperação incorretos.' };
  }
  const problem = passwordProblem(next);
  if (problem) return { ok: false, error: problem };
  const newCode = recoveryCode();
  await q('UPDATE integration_security SET password_hash = $1, recovery_hash = $2, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = 1',
    [await hashPassword(next), await hashPassword(normCode(newCode))]);
  await revokeIntegrationSessions();
  return { ok: true, recoveryCode: newCode };
}

/** Último recurso (sem o código): apaga a senha para nova configuração. Só pelo terminal do servidor. */
export async function clearIntegrationPassword() {
  await q('DELETE FROM integration_security WHERE id = 1');
  await revokeIntegrationSessions();
}
