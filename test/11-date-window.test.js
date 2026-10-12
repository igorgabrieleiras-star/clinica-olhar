// Painel → Disponibilidade de datas: janela de 2 semanas (seg–sáb), retirar e reativar UMA data específica, persistente.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.FAKE_NOW = '2026-10-14T14:00:00Z'; // quarta-feira, 10h em Manaus
const { resetDb, pool, q } = await import('./helpers.js');
const { createApp } = await import('../src/app.js');
const { createAdmin } = await import('../src/auth.js');
const { stopAppointmentsListener } = await import('../src/live.js');
const { publicAvailability } = await import('../src/availability.js');

let server, base, cookie;
const call = (method, path, body) => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', accept: 'application/json', 'x-olhar-csrf': '1', cookie }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

before(async () => {
  await resetDb();
  await q(`UPDATE schedule_rules SET is_open = (weekday <> 0), open_time = '09:00', close_time = '17:00', lunch_start = NULL, lunch_end = NULL, interval_minutes = 30, capacity = 5`);
  await createAdmin({ email: 'p@teste.com', name: 'Igor', password: 'SenhaPrincipal123', mustChange: false });
  server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-olhar-csrf': '1' }, body: JSON.stringify({ email: 'p@teste.com', password: 'SenhaPrincipal123' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { stopAppointmentsListener(); server.closeAllConnections(); server.close(); await pool.end(); });

test('Painel lista as datas da janela: quarta a sábado + segunda a sábado da próxima semana', async () => {
  const d = (await call('GET', '/api/admin/date-window')).data;
  assert.deepEqual(d.days.map((x) => x.date), ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  assert.deepEqual([...new Set(d.days.map((x) => x.week))], [1, 2]);
  assert.ok(d.days.every((x) => x.active));
  assert.equal(d.days[0].isToday, true);
});

test('Retirar 21/10 tira só essa quarta; as outras quartas continuam; reativar devolve a data', async () => {
  assert.equal((await call('PUT', '/api/admin/date-overrides/2026-10-21', { is_blocked: true, reason: 'Desativada no painel' })).status, 200);
  let w = (await call('GET', '/api/admin/date-window')).data.days;
  assert.equal(w.find((x) => x.date === '2026-10-21').active, false);
  assert.equal(w.find((x) => x.date === '2026-10-21').status, 'desativada');
  assert.equal(w.find((x) => x.date === '2026-10-14').active, true, 'a outra quarta continua');
  let pub = await publicAvailability(new Date(process.env.FAKE_NOW));
  assert.equal(pub.dates.find((x) => x.date === '2026-10-21').available, false);
  assert.equal(pub.dates.find((x) => x.date === '2026-10-14').available, true);
  // Persistente: está no banco (sobrevive a reinício/deploy)
  const { rows } = await q(`SELECT is_blocked FROM date_overrides WHERE date = '2026-10-21'`);
  assert.equal(rows[0].is_blocked, true);
  // Reativar
  assert.equal((await call('DELETE', '/api/admin/date-overrides/2026-10-21')).status, 200);
  w = (await call('GET', '/api/admin/date-window')).data.days;
  assert.equal(w.find((x) => x.date === '2026-10-21').active, true);
  pub = await publicAvailability(new Date(process.env.FAKE_NOW));
  assert.equal(pub.dates.find((x) => x.date === '2026-10-21').available, true);
  const audit = await q(`SELECT action FROM audit_log WHERE entity_id = '2026-10-21' ORDER BY id`);
  assert.deepEqual(audit.rows.map((r) => r.action), ['date_override_saved', 'date_override_removed'], 'histórico mantido na auditoria');
});

test('Data lotada aparece como lotada no painel e desabilitada no site', async () => {
  await publicAvailability(new Date(process.env.FAKE_NOW));
  await q(`UPDATE slots SET capacity = 0, manual = true WHERE date = '2026-10-23'`);
  const w = (await call('GET', '/api/admin/date-window')).data.days;
  assert.equal(w.find((x) => x.date === '2026-10-23').status, 'lotada');
  const pub = await publicAvailability(new Date(process.env.FAKE_NOW));
  assert.equal(pub.dates.find((x) => x.date === '2026-10-23').available, false);
});

test('Sem login: lista de datas bloqueada', async () => {
  const r = await fetch(base + '/api/admin/date-window', { headers: { accept: 'application/json' } });
  assert.equal(r.status, 401);
});
