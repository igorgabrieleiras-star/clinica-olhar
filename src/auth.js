import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const SESSION_COOKIE = 'olhar_admin';
export const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'A senha precisa ter pelo menos 12 caracteres.';
  if (pw.length > 200) return 'A senha é longa demais.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letras e números na senha.';
  return null;
}

const tokenHash = (t) => createHash('sha256').update(t).digest('hex');

// Hash fixo usado quando o e-mail não existe, para o tempo de resposta não revelar contas.
let dummyHash = null;

export async function login(email, password) {
  const normalized = String(email || '').trim().toLowerCase();
  const { rows } = await q('SELECT * FROM admins WHERE email = $1', [normalized]);
  const admin = rows[0];
  if (!admin) {
    dummyHash ||= await hashPassword('senha-inexistente-123');
    await verifyPassword(String(password || ''), dummyHash);
    return { ok: false, reason: 'invalid' };
  }
  if (admin.locked_until && new Date(admin.locked_until) > new Date()) return { ok: false, reason: 'locked' };
  const valid = await verifyPassword(String(password || ''), admin.password_hash);
  if (!valid) {
    const failed = admin.failed_attempts + 1;
    if (failed >= MAX_FAILED) {
      // Ao atingir o limite, a conta fica bloqueada por alguns minutos e o contador recomeça.
      await q(`UPDATE admins SET failed_attempts = 0, locked_until = now() + interval '${LOCK_MINUTES} minutes' WHERE id = $1`, [admin.id]);
      return { ok: false, reason: 'locked' };
    }
    await q('UPDATE admins SET failed_attempts = $2 WHERE id = $1', [admin.id, failed]);
    return { ok: false, reason: 'invalid' };
  }
  await q('UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [admin.id]);
  const token = randomBytes(32).toString('base64url');
  await q(`INSERT INTO admin_sessions (id, admin_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours')`, [tokenHash(token), admin.id]);
  await q('DELETE FROM admin_sessions WHERE expires_at < now()');
  return { ok: true, token, admin: publicAdmin(admin) };
}

export async function sessionAdmin(token) {
  if (!token || token.length > 100) return null;
  const { rows } = await q(
    `SELECT a.* FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id = $1 AND s.expires_at > now()`,
    [tokenHash(token)],
  );
  return rows[0] ? publicAdmin(rows[0]) : null;
}

export async function logout(token) {
  if (token) await q('DELETE FROM admin_sessions WHERE id = $1', [tokenHash(token)]);
}

export async function changePassword(adminId, current, next, keepToken) {
  const { rows } = await q('SELECT password_hash FROM admins WHERE id = $1', [adminId]);
  if (!rows[0] || !(await verifyPassword(String(current || ''), rows[0].password_hash))) return { ok: false, error: 'A senha atual está incorreta.' };
  const problem = passwordProblem(next);
  if (problem) return { ok: false, error: problem };
  if (next === current) return { ok: false, error: 'Escolha uma senha diferente da atual.' };
  await q('UPDATE admins SET password_hash = $2, must_change_password = false WHERE id = $1', [adminId, await hashPassword(next)]);
  // Encerra as outras sessões abertas.
  await q('DELETE FROM admin_sessions WHERE admin_id = $1 AND id <> $2', [adminId, tokenHash(keepToken || '')]);
  return { ok: true };
}

export async function createAdmin({ email, name, password, mustChange = true }) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const { rows } = await q(
    `INSERT INTO admins (email, name, password_hash, must_change_password) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = EXCLUDED.must_change_password,
       failed_attempts = 0, locked_until = NULL
     RETURNING id`,
    [String(email).trim().toLowerCase(), name || 'Administrador', await hashPassword(password), mustChange],
  );
  return rows[0].id;
}

function publicAdmin(a) {
  return { id: a.id, email: a.email, name: a.name, mustChangePassword: a.must_change_password };
}
