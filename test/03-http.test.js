// Testes de ponta a ponta na camada HTTP: site público, APIs e painel administrativo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.FAKE_NOW = '2026-10-08T14:00:00Z'; // quinta-feira, 10h em Manaus
const { resetDb, pool, q } = await import('./helpers.js');
const { createApp } = await import('../src/app.js');
const { createAdmin } = await import('../src/auth.js');
const { resetRateLimits } = await import('../src/http.js');
const { saveSection, getSettings } = await import('../src/settings.js');

let server, base, cookie = '';

before(async () => {
  await resetDb();
  await createAdmin({ email: 'admin@teste.com', name: 'Admin', password: 'SenhaInicial123', mustChange: true });
  server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function call(method, path, body, { csrf = true, headers = {} } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (cookie) h.cookie = cookie;
  if (csrf) h['x-olhar-csrf'] = '1';
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

const booking = (o = {}) => ({
  name: 'Mariana Silva', age: '42', whatsapp: '(92) 99999-9999', date: '2026-10-09', time: '09:30',
  consent_data: true, consent_marketing: false, consent_social: true, ads_consent: false, elapsed_ms: 25000,
  attribution: { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'Exame Grátis Manaus', utm_content: 'Criativo 02', utm_term: 'Público 35+', landing_page: 'https://exemplo/?utm_source=facebook' },
  ...o,
});

test('Página inicial: SEO, segurança e sem Pixel quando desativado', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.data, /<title>Exame de Vista Grátis \| Clínica Olhar<\/title>/);
  assert.match(r.data, /Solicite seu exame de vista gratuito na Clínica Olhar/);
  assert.match(r.data, /Restam <b>\d+<\/b> vagas disponíveis/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /facebook/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(!r.data.includes('fbevents'));
});

test('Proteção contra robôs: envio rápido demais ou campo invisível preenchido', async () => {
  assert.equal((await call('POST', '/api/bookings', booking({ elapsed_ms: 500 }))).data.code, 'SPAM_CHECK');
  assert.equal((await call('POST', '/api/bookings', booking({ website: 'http://spam' }))).data.code, 'SPAM_CHECK');
});

test('XSS e validação no servidor', async () => {
  const r = await call('POST', '/api/bookings', booking({ name: '<img src=x onerror=alert(1)>' }));
  assert.equal(r.status, 422);
  assert.equal(r.data.field, 'name');
  const r2 = await call('POST', '/api/bookings', booking({ date: '2026-10-13' }));
  assert.equal(r2.data.code, 'DATE_NOT_ALLOWED');
});

let protocol;
test('15. Agendamento pelo site devolve a confirmação completa', async () => {
  const r = await call('POST', '/api/bookings', booking({ idempotency_key: '9a3b0e7c-8c7e-4d9b-a0c1-3e3b5d2f1a00' }));
  assert.equal(r.status, 201);
  const b = r.data.booking;
  protocol = b.protocol;
  assert.equal(b.name, 'Mariana Silva');
  assert.equal(b.dateLabel, 'Sexta-feira, 09 de outubro');
  assert.equal(b.time, '09:30');
  assert.equal(b.whatsapp, '(92) 99999-9999');
  assert.match(b.protocol, /^OLH-\d{6}$/);
  assert.match(b.eventId, /^[0-9a-f-]{36}$/);
  const again = await call('POST', '/api/bookings', booking({ idempotency_key: '9a3b0e7c-8c7e-4d9b-a0c1-3e3b5d2f1a00' }));
  assert.equal(again.status, 200);
  assert.equal(again.data.booking.protocol, protocol);
  assert.equal(again.data.replay, true, 'reenvio não gera nova conversão');
});

test('Avisos de agendamento: só com a função ligada e com autorização do paciente', async () => {
  assert.deepEqual((await call('GET', '/api/activity')).data.items, []);
  const s = await getSettings({ fresh: true });
  await saveSection('social_proof', { ...s.social_proof, enabled: true });
  await call('POST', '/api/bookings', booking({ name: 'Roberto Alves', whatsapp: '92988880000', consent_social: false, time: '10:00' }));
  const items = (await call('GET', '/api/activity')).data.items;
  assert.deepEqual(items.map((i) => i.firstName), ['Mariana']);
});

test('Painel exige login; dados de pacientes não são públicos', async () => {
  cookie = '';
  assert.equal((await call('GET', '/api/admin/appointments')).status, 401);
  assert.equal((await call('GET', '/api/admin/appointments.csv')).status, 401);
  const bad = await call('POST', '/api/admin/login', { email: 'admin@teste.com', password: 'errada' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, 'E-mail ou senha incorretos.');
});

test('Primeiro acesso exige troca de senha; CSRF bloqueado', async () => {
  const r = await call('POST', '/api/admin/login', { email: 'ADMIN@teste.com', password: 'SenhaInicial123' });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('set-cookie').includes('HttpOnly'));
  assert.ok(r.headers.get('set-cookie').includes('SameSite=Strict'));
  assert.equal(r.data.admin.mustChangePassword, true);
  assert.equal((await call('GET', '/api/admin/dashboard')).data.code, 'MUST_CHANGE_PASSWORD');
  assert.equal((await call('POST', '/api/admin/password', { current: 'SenhaInicial123', next: 'NovaSenhaForte2026' }, { csrf: false })).status, 403);
  assert.equal((await call('POST', '/api/admin/password', { current: 'SenhaInicial123', next: 'curta1' })).status, 422);
  assert.equal((await call('POST', '/api/admin/password', { current: 'SenhaInicial123', next: 'NovaSenhaForte2026' })).status, 200);
});

test('16. Painel: agendamento aparece no dashboard, na lista e na agenda', async () => {
  const d = (await call('GET', '/api/admin/dashboard')).data;
  assert.equal(d.counts.total, 2);
  assert.equal(d.counts.tomorrow, 2);
  assert.equal(d.counts.saturday, 0);
  assert.equal(d.series.length, 30);
  const list = (await call('GET', '/api/admin/appointments?period=amanha&q=' + protocol)).data;
  assert.equal(list.total, 1);
  const row = list.items[0];
  assert.equal(row.name, 'Mariana Silva');
  assert.equal(row.origin, 'Facebook/Instagram Ads (paid_social)');
  assert.equal(row.attribution.campaign, 'Exame Grátis Manaus');
  assert.equal(row.attribution.content, 'Criativo 02');
  assert.equal((await call('GET', '/api/admin/appointments?q=99999')).data.total, 1, 'busca por WhatsApp');
  assert.equal((await call('GET', '/api/admin/appointments?q=mariana')).data.total, 1, 'busca por nome');
  const ag = (await call('GET', '/api/admin/agenda?date=2026-10-09')).data;
  const slot = ag.slots.find((s) => s.time === '09:30');
  assert.equal(`${slot.booked}/${slot.capacity}`, '1/5');
  assert.equal(slot.patients[0].protocol, protocol);
});

test('Status rápido, cancelamento pelo painel e liberação da vaga', async () => {
  const id = (await call('GET', '/api/admin/appointments?q=' + protocol)).data.items[0].id;
  assert.equal((await call('PATCH', `/api/admin/appointments/${id}`, { status: 'CONFIRMADO' })).status, 200);
  assert.equal((await call('PATCH', `/api/admin/appointments/${id}`, { status: 'INVALIDO' })).status, 422);
  await call('PATCH', `/api/admin/appointments/${id}`, { status: 'CANCELADO' });
  const ag = (await call('GET', '/api/admin/agenda?date=2026-10-09')).data;
  assert.equal(ag.slots.find((s) => s.time === '09:30').booked, 0);
  await call('PATCH', `/api/admin/appointments/${id}`, { status: 'NOVO' });
});

test('Exportação CSV com proteção contra fórmulas', async () => {
  await call('POST', '/api/bookings', booking({ name: 'Ana Costa', whatsapp: '92977776666', time: '10:30', attribution: { utm_campaign: '=HYPERLINK("x")' } }));
  const r = await call('GET', '/api/admin/appointments.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /agendamentos-2026-10-08\.csv/);
  assert.ok(r.data.includes(protocol));
  assert.ok(r.data.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(!r.data.includes(';=HYPERLINK'));
});

test('Agenda: bloquear horário e data, configurar vagas', async () => {
  const ag = (await call('GET', '/api/admin/agenda?date=2026-10-10')).data;
  const s = ag.slots.find((x) => x.time === '08:00');
  await call('PATCH', `/api/admin/slots/${s.id}`, { capacity: 2 });
  await call('PATCH', `/api/admin/slots/${s.id}`, { blocked: true });
  let pub = (await call('GET', '/api/availability')).data;
  assert.ok(!pub.dates[1].times.some((t) => t.time === '08:00'), 'horário bloqueado some do site');
  await call('PUT', '/api/admin/date-overrides/2026-10-10', { is_blocked: true, reason: 'Feriado' });
  pub = (await call('GET', '/api/availability')).data;
  assert.equal(pub.dates.find((d) => d.date === '2026-10-10').available, false);
  await call('DELETE', '/api/admin/date-overrides/2026-10-10');
  pub = (await call('GET', '/api/availability')).data;
  assert.equal(pub.dates.find((d) => d.date === '2026-10-10').available, true);
});

test('Configurações: validação e efeito no site', async () => {
  assert.equal((await call('PUT', '/api/admin/settings/meta', { pixel_enabled: true, pixel_id: 'abc' })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings/meta', { pixel_enabled: true, pixel_id: '1234567890', require_consent: true })).status, 200);
  assert.equal((await call('PUT', '/api/admin/settings/clinic', { name: 'Clínica Olhar', whatsapp: '(92) 98123-4567', address: 'Av. Exemplo, 100 — Centro, Manaus' })).status, 200);
  await new Promise((r) => setTimeout(r, 5100)); // cache de configurações (5 s)
  const home = await call('GET', '/');
  assert.match(home.headers.get('content-security-policy'), /connect\.facebook\.net/);
  assert.match(home.data, /"pixelId":"1234567890"/);
  assert.match(home.data, /Av\. Exemplo, 100/);
  resetRateLimits();
  const conf = await call('POST', '/api/bookings', booking({ name: 'Paulo Reis', whatsapp: '92966665555', time: '14:00' }));
  assert.equal(conf.data.booking.clinic.whatsapp, '92981234567');
});

test('Lista de espera', async () => {
  const r = await call('POST', '/api/waitlist', { name: 'Sônia Melo', whatsapp: '92955554444', consent_data: true });
  assert.equal(r.status, 201);
  const w = (await call('GET', '/api/admin/waitlist')).data.items;
  assert.equal(w[0].name, 'Sônia Melo');
});

test('LGPD: correção e exclusão de dados pelo painel', async () => {
  const row = (await call('GET', '/api/admin/appointments?q=Paulo')).data.items[0];
  assert.equal((await call('PATCH', `/api/admin/patients/${row.patientId}`, { name: 'Paulo Reis Neto', age: 51, whatsapp: '92966665555' })).status, 200);
  assert.equal((await call('POST', `/api/admin/patients/${row.patientId}/anonymize`)).status, 200);
  const after = (await call('GET', '/api/admin/appointments?q=' + row.protocol)).data.items[0];
  assert.equal(after.name, 'Dados excluídos');
  assert.equal(after.status, 'CANCELADO');
});

test('Bloqueio de login após tentativas erradas', async () => {
  resetRateLimits();
  const saved = cookie; cookie = '';
  for (let i = 0; i < 4; i++) await call('POST', '/api/admin/login', { email: 'admin@teste.com', password: 'x' + i });
  const fifth = await call('POST', '/api/admin/login', { email: 'admin@teste.com', password: 'x5' });
  assert.match(fifth.data.error, /bloqueado/);
  const right = await call('POST', '/api/admin/login', { email: 'admin@teste.com', password: 'NovaSenhaForte2026' });
  assert.equal(right.status, 401, 'mesmo com a senha certa durante o bloqueio');
  await q('UPDATE admins SET locked_until = NULL');
  cookie = saved;
});

test('Limite de requisições no agendamento', async () => {
  resetRateLimits();
  let last;
  for (let i = 0; i < 9; i++) last = await call('POST', '/api/bookings', booking({ name: 'Teste Limite', whatsapp: '92944443333', time: '15:00' }));
  assert.equal(last.status, 429);
  resetRateLimits();
});
