// Funil interno: automático desde a entrada, anônimo (sem dados pessoais), uma vez por etapa e por sessão,
// origem da visita preservada e todo agendamento confirmado registrado — com ou sem cookies de anúncios.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.FAKE_NOW = '2026-10-08T14:00:00Z';
const { resetDb, pool, q } = await import('./helpers.js');
const { createApp } = await import('../src/app.js');
const { createAdmin } = await import('../src/auth.js');
const { stopAppointmentsListener } = await import('../src/live.js');

let server, base, cookie;
before(async () => {
  await resetDb();
  await q(`UPDATE schedule_rules SET is_open = true, open_time = '09:00', close_time = '12:00', lunch_start = NULL, lunch_end = NULL, interval_minutes = 30, capacity = 3`);
  await createAdmin({ email: 'p@teste.com', name: 'Igor', password: 'SenhaPrincipal123', mustChange: false });
  server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await post('/api/admin/login', { email: 'p@teste.com', password: 'SenhaPrincipal123' }, { 'x-olhar-csrf': '1' });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { stopAppointmentsListener(); server.closeAllConnections(); server.close(); await pool.end(); });

function post(path, body, headers = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
const fromAd = { utm_source: 'instagram', utm_medium: 'paid_social', utm_campaign: 'Exame Gratis Manaus', from_ad: true, referrer: 'https://l.instagram.com/?u=x' };

test('Entrada e etapas registradas sem clique, sem cookies e sem dados pessoais', async () => {
  const sid = randomUUID();
  for (const ev of ['landing', 'name_started', 'age_step', 'whatsapp_step', 'date_step', 'time_step']) {
    const r = await post('/api/funnel', { sid, event: ev, origin: { ...fromAd, name: 'Mariana', whatsapp: '92999999999' } }, { 'user-agent': 'Mozilla/5.0 (iPhone) Mobile' });
    assert.equal(r.status, 204, ev);
    assert.equal(r.headers.get('set-cookie'), null, 'nenhum cookie');
  }
  const { rows } = await q('SELECT * FROM funnel_events WHERE session_id = $1 ORDER BY id', [sid]);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].utm_campaign, 'Exame Gratis Manaus');
  assert.equal(rows[0].from_ad, true);
  assert.equal(rows[0].referrer_host, 'l.instagram.com', 'só o domínio de referência');
  assert.equal(rows[0].device, 'mobile');
  const raw = JSON.stringify(rows);
  assert.doesNotMatch(raw, /Mariana|92999999999/, 'nenhum dado pessoal gravado');
  assert.ok(!('fbclid' in rows[0]) && !('ip' in rows[0]));
});

test('Cada etapa conta uma vez por sessão; etapas desconhecidas e sessões inválidas são recusadas', async () => {
  const sid = randomUUID();
  await post('/api/funnel', { sid, event: 'landing' });
  await post('/api/funnel', { sid, event: 'landing' });
  const { rows } = await q("SELECT count(*)::int AS n FROM funnel_events WHERE session_id = $1", [sid]);
  assert.equal(rows[0].n, 1);
  assert.equal((await post('/api/funnel', { sid, event: 'booking_confirmed' })).status, 422, 'confirmação só pelo servidor');
  assert.equal((await post('/api/funnel', { sid, event: 'qualquer' })).status, 422);
  assert.equal((await post('/api/funnel', { sid: 'abc', event: 'landing' })).status, 422);
});

test('Agendamento confirmado sempre registrado e ligado à sessão e à origem (sem cookies de anúncios)', async () => {
  const sid = randomUUID();
  await post('/api/funnel', { sid, event: 'landing', origin: fromAd });
  const r = await post('/api/bookings', {
    name: 'Paciente Funil', age: '35', whatsapp: '(92) 98111-2233', date: '2026-10-09', time: '10:00',
    consent_data: true, ads_consent: false, elapsed_ms: 20000, funnel_sid: sid,
    attribution: { utm_source: 'instagram', utm_campaign: 'Exame Gratis Manaus', fbclid: 'IwAR123' },
  });
  assert.equal(r.status, 201);
  const { booking } = await r.json();
  await new Promise((ok) => setTimeout(ok, 200));
  const { rows } = await q("SELECT f.*, a.protocol FROM funnel_events f JOIN appointments a ON a.id = f.appointment_id WHERE f.session_id = $1 AND f.event = 'booking_confirmed'", [sid]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].protocol, booking.protocol);
  assert.equal(rows[0].from_ad, true);
  assert.equal(rows[0].utm_campaign, 'Exame Gratis Manaus');
  // Sem sessão do navegador (ex.: JavaScript de medição bloqueado): o agendamento ainda entra no funil
  const r2 = await post('/api/bookings', { name: 'Paciente Sem Sessao', age: '50', whatsapp: '(92) 98111-4455', date: '2026-10-09', time: '10:30', consent_data: true, elapsed_ms: 20000 });
  assert.equal(r2.status, 201);
  await new Promise((ok) => setTimeout(ok, 200));
  const { rows: all } = await q("SELECT count(*)::int AS n FROM funnel_events WHERE event = 'booking_confirmed'");
  assert.equal(all[0].n, 2);
});

test('Painel: funil do período com visitas, etapas, só anúncios e origem', async () => {
  const sid2 = randomUUID();
  await post('/api/funnel', { sid: sid2, event: 'landing', origin: { utm_source: 'google' } });
  // Os testes simulam "hoje" = 08/10 (FAKE_NOW); os registros recebem a hora real do banco.
  await q("UPDATE funnel_events SET created_at = '2026-10-08T14:00:00Z'");
  const res = await fetch(base + '/api/admin/appointments/overview?period=hoje', { headers: { cookie, accept: 'application/json' } });
  const d = await res.json();
  const by = Object.fromEntries(d.funnel.steps.map((s) => [s.event, s]));
  const { rows } = await q("SELECT count(DISTINCT session_id)::int AS n FROM funnel_events WHERE event = 'landing'");
  assert.equal(by.landing.n, rows[0].n);
  assert.equal(by.landing.ads, 2, 'visitas vindas de anúncios');
  assert.equal(by.booking_confirmed.n, 2);
  assert.ok(d.funnel.campaigns.some((c) => c.campaign === 'Exame Gratis Manaus' && c.bookings === 1));
  const future = await (await fetch(base + '/api/admin/appointments/overview?period=amanha', { headers: { cookie } })).json();
  assert.equal(future.funnel, null, 'datas futuras não têm visitas');
});
