// Login individual (sem senha extra compartilhada), níveis de acesso, convites e a área de Integrações protegida.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.FAKE_NOW = '2026-10-08T14:00:00Z';
const { resetDb, pool, q } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { createAdmin } = await import('../src/auth.js');
const { resetRateLimits } = await import('../src/http.js');

let adm, base;
const PRINCIPAL = { email: 'igor@clinica.com', password: 'SenhaPrincipal123' };
const INTEGR_PW = 'CofreDasIntegracoes2026';

before(async () => {
  await resetDb();
  config.adminGateUser = ''; config.adminGatePassword = ''; config.adminAllowedIps = []; config.cfAccessAud = '';
  await createAdmin({ email: PRINCIPAL.email, name: 'Igor Gabriel', password: PRINCIPAL.password, mustChange: false });
  adm = createApp({ role: 'admin' });
  await new Promise((r) => adm.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${adm.address().port}`;
});
after(async () => { adm.close(); await pool.end(); });

async function call(method, path, { body, cookie, headers = {} } = {}) {
  const h = { accept: 'application/json', 'x-olhar-csrf': '1', ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}
async function login(email, password) {
  const r = await call('POST', '/api/admin/login', { body: { email, password } });
  return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : r;
}
const tokenFromInvite = (r) => r.data.token;

let principalCookie, adminCookie, adminId;

test('Painel abre direto na tela de login (sem senha extra) e protege os dados', async () => {
  const home = await call('GET', '/', { headers: { accept: 'text/html' } });
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('www-authenticate'), null);
  assert.match(home.headers.get('x-robots-tag') || '', /noindex/);
  for (const p of ['/api/admin/appointments', '/api/admin/dashboard', '/api/admin/admins', '/api/admin/integrations', '/api/admin/settings']) {
    assert.equal((await call('GET', p)).status, 401, p);
  }
  principalCookie = await login(PRINCIPAL.email, PRINCIPAL.password);
  assert.equal(typeof principalCookie, 'string');
  const me = await call('GET', '/api/admin/me', { cookie: principalCookie });
  assert.equal(me.data.admin.role, 'principal');
  assert.equal(me.data.admin.name, 'Igor Gabriel');
});

test('Cookie de sessão HttpOnly e SameSite; CSRF bloqueado', async () => {
  const r = await call('POST', '/api/admin/login', { body: PRINCIPAL });
  const c = r.headers.get('set-cookie');
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/);
  const no = await fetch(base + '/api/admin/invites', { method: 'POST', headers: { cookie: principalCookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(no.status, 403);
});

test('Convite: link exclusivo, só o hash no banco, uso único e e-mail conferido', async () => {
  const bad = await call('POST', '/api/admin/invites', { cookie: principalCookie, body: { name: 'Ana', email: 'invalido', role: 'admin' } });
  assert.equal(bad.status, 422);
  const r = await call('POST', '/api/admin/invites', { cookie: principalCookie, body: { name: 'Ana Souza', email: 'Ana@Clinica.com', role: 'admin' } });
  assert.equal(r.status, 201);
  const token = tokenFromInvite(r);
  assert.ok(token.length >= 40);
  const { rows } = await q('SELECT token_hash, extract(epoch FROM expires_at - created_at)::int AS ttl FROM admin_invites WHERE email = $1', ['ana@clinica.com']);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].ttl, 24 * 3600);
  const { rows: logs } = await q("SELECT details::text AS d FROM audit_log WHERE action = 'invite_created'");
  assert.ok(!logs.some((l) => (l.d || '').includes(token)), 'o token não vai para o log');

  const list = await call('GET', '/api/admin/admins', { cookie: principalCookie });
  assert.equal(list.data.invites[0].status, 'convite_pendente');

  const info = await call('POST', '/api/admin/invites/check', { body: { token } });
  assert.equal(info.status, 200);
  assert.equal(info.data.invite.email, 'ana@clinica.com');

  const wrongEmail = await call('POST', '/api/admin/invites/accept', { body: { token, email: 'outra@clinica.com', name: 'Ana', password: 'SenhaDaAna12345', confirm: 'SenhaDaAna12345' } });
  assert.equal(wrongEmail.status, 422);
  const mismatch = await call('POST', '/api/admin/invites/accept', { body: { token, email: 'ana@clinica.com', name: 'Ana', password: 'SenhaDaAna12345', confirm: 'Outra12345678' } });
  assert.equal(mismatch.status, 422);
  const weak = await call('POST', '/api/admin/invites/accept', { body: { token, email: 'ana@clinica.com', name: 'Ana', password: 'curta', confirm: 'curta' } });
  assert.equal(weak.status, 422);
  const ok = await call('POST', '/api/admin/invites/accept', { body: { token, email: 'ANA@clinica.com', name: 'Ana Souza', password: 'SenhaDaAna12345', confirm: 'SenhaDaAna12345' } });
  assert.equal(ok.status, 201);
  const again = await call('POST', '/api/admin/invites/accept', { body: { token, email: 'ana@clinica.com', name: 'Ana', password: 'SenhaDaAna12345', confirm: 'SenhaDaAna12345' } });
  assert.equal(again.status, 422, 'convite é de uso único');
  assert.equal((await call('POST', '/api/admin/invites/check', { body: { token } })).status, 404);

  adminCookie = await login('ana@clinica.com', 'SenhaDaAna12345');
  assert.equal(typeof adminCookie, 'string', 'novo administrador entra com a própria senha');
  const me = await call('GET', '/api/admin/me', { cookie: adminCookie });
  assert.equal(me.data.admin.role, 'admin');
  assert.equal(me.data.admin.mustChangePassword, false);
  adminId = me.data.admin.id;
});

test('Convite expirado, revogado e reenviado', async () => {
  const r = await call('POST', '/api/admin/invites', { cookie: principalCookie, body: { name: 'Bruno', email: 'bruno@clinica.com', role: 'admin' } });
  const t1 = tokenFromInvite(r);
  await q("UPDATE admin_invites SET expires_at = now() - interval '1 minute' WHERE email = 'bruno@clinica.com'");
  assert.equal((await call('POST', '/api/admin/invites/check', { body: { token: t1 } })).status, 404, 'expirado');
  let list = await call('GET', '/api/admin/admins', { cookie: principalCookie });
  const inv = list.data.invites.find((i) => i.email === 'bruno@clinica.com');
  assert.equal(inv.status, 'convite_expirado');
  const re = await call('POST', `/api/admin/invites/${inv.id}/resend`, { cookie: principalCookie });
  assert.equal(re.status, 200);
  const t2 = re.data.token;
  assert.notEqual(t1, t2);
  assert.equal((await call('POST', '/api/admin/invites/check', { body: { token: t2 } })).status, 200);
  list = await call('GET', '/api/admin/admins', { cookie: principalCookie });
  const inv2 = list.data.invites.find((i) => i.email === 'bruno@clinica.com');
  assert.equal(inv2.status, 'convite_pendente');
  assert.equal((await call('DELETE', `/api/admin/invites/${inv2.id}`, { cookie: principalCookie })).status, 200);
  assert.equal((await call('POST', '/api/admin/invites/check', { body: { token: t2 } })).status, 404, 'revogado');
  // Convite para e-mail que já é administrador é recusado
  assert.equal((await call('POST', '/api/admin/invites', { cookie: principalCookie, body: { name: 'Ana', email: 'ana@clinica.com', role: 'admin' } })).status, 422);
});

test('Administrador comum: operação liberada; administradores, Integrações e registro negados no servidor', async () => {
  assert.equal((await call('GET', '/api/admin/dashboard', { cookie: adminCookie })).status, 200);
  assert.equal((await call('GET', '/api/admin/appointments', { cookie: adminCookie })).status, 200);
  const st = await call('GET', '/api/admin/settings', { cookie: adminCookie });
  assert.equal(st.status, 200);
  assert.equal(st.data.settings.meta, undefined, 'configurações do Pixel não aparecem fora da área protegida');
  assert.equal(st.data.metaLog, undefined);
  assert.equal(st.data.env, undefined);
  for (const [m, p, body] of [
    ['GET', '/api/admin/admins'], ['POST', '/api/admin/invites', { name: 'X', email: 'x@x.com', role: 'principal' }],
    ['PATCH', '/api/admin/admins/1', { role: 'admin' }], ['DELETE', '/api/admin/admins/1'],
    ['GET', '/api/admin/audit'], ['GET', '/api/admin/integrations'], ['GET', '/api/admin/integrations/status'],
    ['POST', '/api/admin/integrations/setup', { password: 'QualquerSenha12345', confirm: 'QualquerSenha12345' }],
    ['POST', '/api/admin/integrations/unlock', { password: INTEGR_PW }], ['POST', '/api/admin/integrations/reset', {}],
    ['PUT', '/api/admin/settings/meta', { pixel_enabled: true, pixel_id: '999999999' }],
  ]) {
    const r = await call(m, p, { cookie: adminCookie, body });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
});

test('Integrações: primeiro acesso exige criar a senha; sem senha padrão', async () => {
  const st = await call('GET', '/api/admin/integrations/status', { cookie: principalCookie });
  assert.equal(st.data.configured, false);
  const r = await call('GET', '/api/admin/integrations', { cookie: principalCookie });
  assert.equal(r.status, 423); assert.equal(r.data.code, 'INTEGRATIONS_SETUP');
  assert.equal((await call('PUT', '/api/admin/settings/meta', { cookie: principalCookie, body: { pixel_enabled: false } })).status, 423);
  assert.equal((await call('POST', '/api/admin/integrations/setup', { cookie: principalCookie, body: { password: 'curta1', confirm: 'curta1' } })).status, 422);
  const ok = await call('POST', '/api/admin/integrations/setup', { cookie: principalCookie, body: { password: INTEGR_PW, confirm: INTEGR_PW } });
  assert.equal(ok.status, 201);
  assert.match(ok.data.recoveryCode, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  globalThis.recovery = ok.data.recoveryCode;
  const { rows } = await q('SELECT password_hash, recovery_hash FROM integration_security');
  assert.ok(!rows[0].password_hash.includes(INTEGR_PW) && rows[0].password_hash.startsWith('scrypt$'));
  assert.equal((await call('POST', '/api/admin/integrations/setup', { cookie: principalCookie, body: { password: 'OutraSenha123456', confirm: 'OutraSenha123456' } })).status, 422, 'não recria');
  const d = await call('GET', '/api/admin/integrations', { cookie: principalCookie });
  assert.equal(d.status, 200, 'quem criou já fica desbloqueado nesta sessão');
  assert.ok('pixel_id' in d.data.meta);
  assert.equal(JSON.stringify(d.data).includes('ACCESS_TOKEN'), false);
  assert.equal(typeof d.data.env.capiTokenConfigured, 'boolean', 'só informa se o token está configurado');
});

test('Integrações: nova sessão começa bloqueada; desbloqueio com a senha; expira após inatividade e ao sair', async () => {
  const c2 = await login(PRINCIPAL.email, PRINCIPAL.password);
  const locked = await call('GET', '/api/admin/integrations', { cookie: c2 });
  assert.equal(locked.status, 423); assert.equal(locked.data.code, 'INTEGRATIONS_LOCKED');
  const wrong = await call('POST', '/api/admin/integrations/unlock', { cookie: c2, body: { password: 'senha-errada-123' } });
  assert.equal(wrong.status, 401);
  const ok = await call('POST', '/api/admin/integrations/unlock', { cookie: c2, body: { password: INTEGR_PW } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/admin/integrations', { cookie: c2 })).status, 200);
  const save = await call('PUT', '/api/admin/settings/meta', { cookie: c2, body: { pixel_enabled: true, pixel_id: '123456789012345', require_consent: true, capi_enabled: false } });
  assert.equal(save.status, 200);
  // Uso renova o prazo (10 min a partir da última ação)
  const { rows: [s1] } = await q("SELECT integrations_until - now() AS left FROM admin_sessions WHERE integrations_until IS NOT NULL ORDER BY integrations_until DESC LIMIT 1");
  assert.ok(s1.left.minutes >= 9);
  // Inatividade: prazo vencido → bloqueado de novo
  await q("UPDATE admin_sessions SET integrations_until = now() - interval '1 second' WHERE integrations_until IS NOT NULL");
  assert.equal((await call('GET', '/api/admin/integrations', { cookie: c2 })).status, 423);
  assert.equal((await call('PUT', '/api/admin/settings/meta', { cookie: c2, body: { pixel_enabled: false } })).status, 423);
  // Sair da conta: ao entrar de novo, começa bloqueado
  await call('POST', '/api/admin/integrations/unlock', { cookie: c2, body: { password: INTEGR_PW } });
  await call('POST', '/api/admin/logout', { cookie: c2 });
  assert.equal((await call('GET', '/api/admin/integrations', { cookie: c2 })).status, 401);
  const c3 = await login(PRINCIPAL.email, PRINCIPAL.password);
  assert.equal((await call('GET', '/api/admin/integrations', { cookie: c3 })).status, 423);
});

test('Integrações: administrador comum não entra nem sabendo a senha', async () => {
  const r = await call('POST', '/api/admin/integrations/unlock', { cookie: adminCookie, body: { password: INTEGR_PW } });
  assert.equal(r.status, 403);
  assert.equal((await call('GET', '/api/admin/integrations', { cookie: adminCookie })).status, 403);
});

test('Integrações: bloqueio temporário após tentativas excessivas', async () => {
  resetRateLimits();
  const c = await login(PRINCIPAL.email, PRINCIPAL.password);
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/api/admin/integrations/unlock', { cookie: c, body: { password: 'errada-' + i + '-xxxxx' } })).status, 401);
  assert.equal((await call('POST', '/api/admin/integrations/unlock', { cookie: c, body: { password: 'errada-final-xxxx' } })).status, 429);
  assert.equal((await call('POST', '/api/admin/integrations/unlock', { cookie: c, body: { password: INTEGR_PW } })).status, 429, 'nem a senha certa entra durante o bloqueio');
  const { rows } = await q("SELECT count(*) AS n FROM audit_log WHERE action IN ('integrations_unlock_failed','integrations_unlock_blocked')");
  assert.ok(rows[0].n >= 5, 'tentativas registradas');
  await q('UPDATE integration_security SET locked_until = NULL, failed_attempts = 0');
  resetRateLimits();
});

test('Integrações: alterar senha, revogar sessões e recuperar com senha da conta + código', async () => {
  const c = await login(PRINCIPAL.email, PRINCIPAL.password);
  await call('POST', '/api/admin/integrations/unlock', { cookie: c, body: { password: INTEGR_PW } });
  const other = await login(PRINCIPAL.email, PRINCIPAL.password);
  await call('POST', '/api/admin/integrations/unlock', { cookie: other, body: { password: INTEGR_PW } });
  const NEW = 'NovaSenhaIntegracoes99';
  assert.equal((await call('POST', '/api/admin/integrations/password', { cookie: c, body: { current: 'errada-123456', next: NEW, confirm: NEW } })).status, 422);
  assert.equal((await call('POST', '/api/admin/integrations/password', { cookie: c, body: { current: INTEGR_PW, next: NEW, confirm: NEW } })).status, 200);
  assert.equal((await call('GET', '/api/admin/integrations', { cookie: other })).status, 423, 'outras sessões bloqueadas após a troca');
  assert.equal((await call('GET', '/api/admin/integrations', { cookie: c })).status, 200);
  assert.equal((await call('POST', '/api/admin/integrations/revoke', { cookie: c })).status, 200);
  assert.equal((await call('GET', '/api/admin/integrations', { cookie: c })).status, 423, 'revogação inclui a própria sessão');

  // Recuperação: só com a senha da conta E o código de recuperação
  const FINAL = 'RecuperadaComCodigo2026';
  const noCode = await call('POST', '/api/admin/integrations/reset', { cookie: c, body: { accountPassword: PRINCIPAL.password, recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD', next: FINAL, confirm: FINAL } });
  assert.equal(noCode.status, 422);
  const noAccount = await call('POST', '/api/admin/integrations/reset', { cookie: c, body: { accountPassword: 'errada-123456', recoveryCode: globalThis.recovery, next: FINAL, confirm: FINAL } });
  assert.equal(noAccount.status, 422);
  await q('UPDATE integration_security SET failed_attempts = 0');
  const ok = await call('POST', '/api/admin/integrations/reset', { cookie: c, body: { accountPassword: PRINCIPAL.password, recoveryCode: globalThis.recovery.toLowerCase(), next: FINAL, confirm: FINAL } });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.data.recoveryCode, globalThis.recovery, 'novo código de recuperação');
  const reuse = await call('POST', '/api/admin/integrations/reset', { cookie: c, body: { accountPassword: PRINCIPAL.password, recoveryCode: globalThis.recovery, next: 'OutraMais123456', confirm: 'OutraMais123456' } });
  assert.equal(reuse.status, 422, 'código antigo deixa de valer');
  const c4 = await login(PRINCIPAL.email, PRINCIPAL.password);
  assert.equal((await call('POST', '/api/admin/integrations/unlock', { cookie: c4, body: { password: FINAL } })).status, 200);
});

test('Gerenciamento: alterar permissão, desativar (encerra sessões), reativar, remover; protege o último principal', async () => {
  // Não pode rebaixar/desativar/remover a si mesmo
  const meId = (await call('GET', '/api/admin/me', { cookie: principalCookie })).data.admin.id;
  assert.equal((await call('PATCH', `/api/admin/admins/${meId}`, { cookie: principalCookie, body: { role: 'admin' } })).status, 422);
  assert.equal((await call('DELETE', `/api/admin/admins/${meId}`, { cookie: principalCookie })).status, 422);

  // Desativar Ana: sessão encerrada e login recusado
  assert.equal((await call('PATCH', `/api/admin/admins/${adminId}`, { cookie: principalCookie, body: { disabled: true } })).status, 200);
  assert.equal((await call('GET', '/api/admin/dashboard', { cookie: adminCookie })).status, 401);
  const denied = await call('POST', '/api/admin/login', { body: { email: 'ana@clinica.com', password: 'SenhaDaAna12345' } });
  assert.equal(denied.status, 401);
  let list = await call('GET', '/api/admin/admins', { cookie: principalCookie });
  assert.equal(list.data.admins.find((a) => a.id === adminId).status, 'desativado');
  assert.equal((await call('PATCH', `/api/admin/admins/${adminId}`, { cookie: principalCookie, body: { disabled: false } })).status, 200);
  adminCookie = await login('ana@clinica.com', 'SenhaDaAna12345');
  assert.equal(typeof adminCookie, 'string');

  // Promover Ana a principal → ela pode gerenciar; o sistema nunca fica sem principal ativo
  assert.equal((await call('PATCH', `/api/admin/admins/${adminId}`, { cookie: principalCookie, body: { role: 'principal' } })).status, 200);
  assert.equal((await call('GET', '/api/admin/admins', { cookie: adminCookie })).status, 200);
  assert.equal((await call('PATCH', `/api/admin/admins/${meId}`, { cookie: adminCookie, body: { role: 'admin' } })).status, 200);
  assert.equal((await call('GET', '/api/admin/admins', { cookie: principalCookie })).status, 403, 'Igor agora é administrador comum');
  assert.equal((await call('DELETE', `/api/admin/admins/${adminId}`, { cookie: adminCookie })).status, 422, 'não remove a si mesma');
  const { updateAdmin, removeAdmin } = await import('../src/admins.js');
  assert.equal((await updateAdmin(adminId, { role: 'admin' }, meId)).ok, false, 'último principal não pode ser rebaixado');
  assert.equal((await removeAdmin(adminId, meId)).ok, false, 'último principal não pode ser removido');
  // Devolve o principal a Igor e remove Ana
  assert.equal((await call('PATCH', `/api/admin/admins/${meId}`, { cookie: adminCookie, body: { role: 'principal' } })).status, 200);
  principalCookie = await login(PRINCIPAL.email, PRINCIPAL.password);
  assert.equal((await call('DELETE', `/api/admin/admins/${adminId}`, { cookie: principalCookie })).status, 200);
  assert.equal((await call('GET', '/api/admin/me', { cookie: adminCookie })).status, 401);
  const { rows } = await q("SELECT count(*) AS n FROM audit_log WHERE action IN ('admin_disabled','admin_enabled','admin_role_changed','admin_removed')");
  assert.ok(rows[0].n >= 5, 'alterações registradas na auditoria');
});

test('Perfil: nome da saudação vem da conta', async () => {
  assert.equal((await call('PATCH', '/api/admin/me', { cookie: principalCookie, body: { name: 'x' } })).status, 422);
  const r = await call('PATCH', '/api/admin/me', { cookie: principalCookie, body: { name: 'Igor' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/admin/me', { cookie: principalCookie })).data.admin.name, 'Igor');
});
