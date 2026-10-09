// Separação entre o site público e o painel privado: rotas, arquivos, camadas de acesso e permissões no banco.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import pg from 'pg';

process.env.FAKE_NOW = '2026-10-08T14:00:00Z'; // quinta-feira
const { resetDb, pool, q } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { createAdmin } = await import('../src/auth.js');
const { resetRateLimits } = await import('../src/http.js');
const { saveSection } = await import('../src/settings.js');
const { ipAllowed, verifyCfAccess, setCfCertsFetcher } = await import('../src/admin-gate.js');
const { createPublicRole } = await import('../src/db-roles.js');

const TEST_ROLE = 'olhar_site_test';
config.publicDbRole = TEST_ROLE;

let pub, adm, pubBase, admBase;
async function start(role) {
  const s = createApp({ role });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return [s, `http://127.0.0.1:${s.address().port}`];
}

before(async () => {
  await resetDb();
  await createAdmin({ email: 'admin@teste.com', name: 'Admin', password: 'SenhaForte12345', mustChange: false });
  const rules = [1, 2, 3, 4, 5, 6].map((d) => d);
  await q(`UPDATE schedule_rules SET is_open = true, open_time='08:00', close_time='10:00', lunch_start=NULL, lunch_end=NULL, interval_minutes=30, capacity=2 WHERE weekday = ANY($1)`, [rules]);
  [pub, pubBase] = await start('public');
  [adm, admBase] = await start('admin');
});
after(async () => { pub.close(); adm.close(); await pool.end(); });

async function call(base, method, path, { body, cookie, headers = {}, redirect = 'manual' } = {}) {
  const h = { accept: 'application/json', 'x-olhar-csrf': '1', ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}
async function adminLogin() {
  const r = await call(admBase, 'POST', '/api/admin/login', { body: { email: 'admin@teste.com', password: 'SenhaForte12345' } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('Site público: nenhuma rota, arquivo ou link administrativo existe', async () => {
  for (const p of ['/admin', '/admin/', '/api/admin/me', '/api/admin/appointments', '/api/admin/appointments.csv', '/assets/admin.js', '/assets/admin.css']) {
    const r = await call(pubBase, 'GET', p);
    assert.equal(r.status, 404, p);
  }
  assert.equal((await call(pubBase, 'POST', '/api/admin/login', { body: { email: 'admin@teste.com', password: 'SenhaForte12345' } })).status, 404);
  const home = await call(pubBase, 'GET', '/');
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.data, /admin|login|painel|área restrita|acesso (de|para) funcion/i);
  const robots = await call(pubBase, 'GET', '/robots.txt');
  assert.doesNotMatch(robots.data, /admin/i);
  assert.match(robots.data, /Disallow: \/api\//);
});

test('Painel: servido na raiz, sem o site público e sem indexação', async () => {
  const r = await call(admBase, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.data, /Painel \| Clínica Olhar/);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(r.data, /<meta name="robots" content="noindex/);
  for (const p of ['/privacidade', '/api/availability', '/assets/site.js', '/sitemap.xml']) {
    assert.equal((await call(admBase, 'GET', p)).status, 404, p);
  }
  assert.equal((await call(admBase, 'POST', '/api/bookings', { body: {} })).status, 404);
  assert.equal((await call(admBase, 'GET', '/robots.txt')).data, 'User-agent: *\nDisallow: /\n');
  const red = await call(admBase, 'GET', '/admin');
  assert.equal(red.status, 301);
  assert.equal(red.headers.get('location'), '/');
  // A API do painel exige login (camada de autorização no servidor).
  assert.equal((await call(admBase, 'GET', '/api/admin/appointments')).status, 401);
});

test('Integração: agendamento no site aparece no painel; bloqueio no painel some do site', async () => {
  resetRateLimits();
  await saveSection('booking', { enabled: true, waitlist_enabled: true, scarcity_threshold: 20, min_age: null, max_age: null, minor_rule: 'guardian_required' });
  const before = (await call(pubBase, 'GET', '/api/availability')).data;
  assert.ok(before.total > 0);
  const b = await call(pubBase, 'POST', '/api/bookings', {
    body: { name: 'Joana Prado', age: 50, whatsapp: '92988887777', date: '2026-10-09', time: '08:00', consent_data: true, elapsed_ms: 9000 },
  });
  assert.equal(b.status, 201);
  const cookie = await adminLogin();
  const list = await call(admBase, 'GET', '/api/admin/appointments?q=' + b.data.booking.protocol, { cookie });
  assert.equal(list.data.items[0].name, 'Joana Prado');

  const ag = await call(admBase, 'GET', '/api/admin/agenda?date=2026-10-09', { cookie });
  const slot = ag.data.slots.find((s) => s.time === '08:30');
  assert.equal((await call(admBase, 'PATCH', `/api/admin/slots/${slot.id}`, { cookie, body: { blocked: true } })).status, 200);
  const after = (await call(pubBase, 'GET', '/api/availability')).data;
  const fri = after.dates.find((d) => d.date === '2026-10-09');
  const t830 = fri.times.find((t) => t.time === '08:30');
  assert.ok(!t830 || t830.available === false, 'horário bloqueado não pode ser escolhido no site');
  assert.equal(after.total, before.total - 1 - 2);
});

test('Camada extra: lista de IPs permitidos', async () => {
  assert.ok(ipAllowed('10.1.2.3', ['10.0.0.0/8']));
  assert.ok(ipAllowed('::ffff:192.168.0.10', ['192.168.0.0/24']));
  assert.ok(!ipAllowed('192.168.1.10', ['192.168.0.0/24']));
  assert.ok(ipAllowed('2804:14c::1', ['2804:14c::/32']));
  assert.ok(!ipAllowed('2001:db8::1', ['2804:14c::/32']));
  assert.ok(ipAllowed('200.1.2.3', ['200.1.2.3']));

  config.adminAllowedIps = ['203.0.113.0/24'];
  try {
    assert.equal((await call(admBase, 'GET', '/')).status, 404);
    assert.equal((await call(admBase, 'POST', '/api/admin/login', { body: {} })).status, 404);
    assert.equal((await call(admBase, 'GET', '/healthz')).status, 200);
    config.adminAllowedIps = ['127.0.0.1'];
    assert.equal((await call(admBase, 'GET', '/')).status, 200);
  } finally { config.adminAllowedIps = []; }
});

test('Camada extra: senha de acesso (HTTP Basic) antes da tela de login', async () => {
  config.adminGateUser = 'clinica';
  config.adminGatePassword = 'porta-de-acesso-2026';
  try {
    const no = await call(admBase, 'GET', '/');
    assert.equal(no.status, 401);
    assert.match(no.headers.get('www-authenticate'), /Basic/);
    const bad = await call(admBase, 'GET', '/assets/admin.js', { headers: { authorization: 'Basic ' + Buffer.from('clinica:errada').toString('base64') } });
    assert.equal(bad.status, 401);
    const ok = await call(admBase, 'GET', '/', { headers: { authorization: 'Basic ' + Buffer.from('clinica:porta-de-acesso-2026').toString('base64') } });
    assert.equal(ok.status, 200);
    // O site público não é afetado.
    assert.equal((await call(pubBase, 'GET', '/')).status, 200);
  } finally { config.adminGateUser = ''; config.adminGatePassword = ''; }
});

test('Camada extra: Cloudflare Access (JWT RS256 validado no servidor)', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  setCfCertsFetcher(async () => [jwk]);
  const team = 'clinicaolhar.cloudflareaccess.com';
  const aud = 'aud-tag-123';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) => {
    const data = b64(header) + '.' + b64(payload);
    const s = createSign('RSA-SHA256'); s.update(data);
    return data + '.' + s.sign(privateKey).toString('base64url');
  };
  const nowS = Math.floor(Date.now() / 1000);
  const good = { aud: [aud], iss: `https://${team}`, email: 'gerente@clinicaolhar.com.br', exp: nowS + 600, iat: nowS };

  assert.deepEqual(await verifyCfAccess(sign(good), { team, aud }), { email: 'gerente@clinicaolhar.com.br' });
  assert.equal(await verifyCfAccess(sign({ ...good, aud: ['outro'] }), { team, aud }), null);
  assert.equal(await verifyCfAccess(sign({ ...good, exp: nowS - 10 }), { team, aud }), null);
  assert.equal(await verifyCfAccess(sign({ ...good, iss: 'https://atacante.cloudflareaccess.com' }), { team, aud }), null);
  const tampered = sign(good).split('.'); tampered[1] = b64({ ...good, email: 'intruso@x.com' });
  assert.equal(await verifyCfAccess(tampered.join('.'), { team, aud }), null);
  assert.equal(await verifyCfAccess(sign(good, { alg: 'none', kid: 'k1' }), { team, aud }), null);

  config.cfAccessTeamDomain = team; config.cfAccessAud = aud;
  try {
    assert.equal((await call(admBase, 'GET', '/')).status, 403);
    assert.equal((await call(admBase, 'GET', '/', { headers: { 'cf-access-jwt-assertion': sign({ ...good, aud: ['x'] }) } })).status, 403);
    assert.equal((await call(admBase, 'GET', '/', { headers: { 'cf-access-jwt-assertion': sign(good) } })).status, 200);
  } finally { config.cfAccessTeamDomain = ''; config.cfAccessAud = ''; }
});

test('Banco: usuário do site público tem apenas as permissões mínimas', async (t) => {
  const { rows: [me] } = await q('SELECT rolcreaterole OR rolsuper AS can FROM pg_roles WHERE rolname = current_user');
  if (!me.can) return t.skip('usuário de teste sem CREATEROLE');
  const client = await pool.connect();
  try { await createPublicRole(client, TEST_ROLE, 'senha-site-teste-123'); } finally { client.release(); }

  const url = new URL(process.env.DATABASE_URL);
  url.username = TEST_ROLE; url.password = 'senha-site-teste-123';
  const site = new pg.Pool({ connectionString: url.toString(), max: 2 });
  const denied = async (sql, params) => {
    await assert.rejects(site.query(sql, params), (e) => e.code === '42501', sql);
  };
  try {
    // Permitido (o que o site precisa)
    await site.query('SELECT key FROM settings');
    await site.query('SELECT id, capacity, blocked FROM slots LIMIT 1');
    await site.query('SELECT id, name, whatsapp FROM patients LIMIT 1');
    await site.query("SELECT nextval('protocol_seq')");
    await site.query(`INSERT INTO service_status (service, info) VALUES ('public', '{}') ON CONFLICT (service) DO UPDATE SET info = EXCLUDED.info`);
    await site.query("SELECT pg_notify('olhar_settings', 'x')");
    // Negado (dados e operações administrativas)
    await denied('SELECT * FROM admins');
    await denied('SELECT * FROM admin_sessions');
    await denied('SELECT * FROM audit_log');
    await denied('SELECT * FROM consents');
    await denied('SELECT * FROM attributions');
    await denied('SELECT notes FROM appointments');
    await denied('SELECT * FROM patients');
    await denied("UPDATE appointments SET status = 'CANCELADO'");
    await denied('DELETE FROM appointments');
    await denied('DELETE FROM patients');
    await denied('UPDATE slots SET capacity = 500');
    await denied("UPDATE settings SET value = '{}'::jsonb");
    await denied('UPDATE schedule_rules SET capacity = 500');
    await denied("INSERT INTO date_overrides (date, is_blocked) VALUES ('2030-01-01', true)");
    await denied('UPDATE patients SET whatsapp = $1', ['92900000000']);
    await denied('CREATE TABLE x (id int)');
    await denied('TRUNCATE appointments');
  } finally {
    await site.end();
  }
});
