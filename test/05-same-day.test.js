// Agendamento para HOJE: antecedência mínima, teto do mesmo dia, expediente 09:00–17:00 (Manaus), bloqueios e concorrência.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { resetDb, pool, q, person } = await import('./helpers.js');
const { publicAvailability, dayAvailability } = await import('../src/availability.js');
const { createBooking, setStatus } = await import('../src/booking.js');
const { saveSection, getSettings } = await import('../src/settings.js');
const { activityWhen } = await import('../src/routes/public.js');

const at = (iso, hhmm) => new Date(`${iso}T${hhmm}:00-04:00`); // horário de Manaus
const QUI = '2026-10-08';
const todayOf = (pub) => pub.dates.find((d) => d.isToday);
const firstTime = (pub) => todayOf(pub)?.times[0]?.time;

async function setBooking(patch) {
  const s = await getSettings({ fresh: true });
  await saveSection('booking', { ...s.booking, ...patch });
}

before(async () => {
  await resetDb();
  // Expediente oficial: 09:00–17:00 todos os dias, intervalos de 30 min, 5 vagas por horário.
  await q(`UPDATE schedule_rules SET is_open = true, open_time = '09:00', close_time = '17:00', lunch_start = NULL, lunch_end = NULL, interval_minutes = 30, capacity = 5`);
  await setBooking({ today_enabled: true, tomorrow_enabled: true, saturday_enabled: true, min_lead_minutes: 60, same_day_cap: 3 });
});
after(async () => { await pool.end(); });

test('Padrões novos: agendamentos ativados para hoje, amanhã e sábado; 60 min; teto 3', async () => {
  const { DEFAULTS } = await import('../src/settings.js');
  const b = DEFAULTS.booking;
  assert.equal(b.enabled, true);
  assert.equal(b.today_enabled && b.tomorrow_enabled && b.saturday_enabled, true);
  assert.equal(b.min_lead_minutes, 60);
  assert.equal(b.same_day_cap, 3);
  const { rows } = await q('SELECT count(*) AS n FROM schedule_rules');
  assert.equal(rows[0].n, 7);
});

test('Acesso antes das 9h (08:15): hoje começa às 09:30 (09:00 tem menos de 1h)', async () => {
  const pub = await publicAvailability(at(QUI, '08:15'));
  assert.equal(firstTime(pub), '09:30');
  assert.equal(todayOf(pub).times.at(-1).time, '16:30');
});

test('Acesso às 10h: primeiro horário 11:00, com no máximo 3 vagas (teto do mesmo dia)', async () => {
  const pub = await publicAvailability(at(QUI, '10:00'));
  assert.equal(firstTime(pub), '11:00');
  assert.ok(todayOf(pub).times.every((t) => t.left <= 3));
  assert.deepEqual(pub.today.next.map((t) => t.time), ['11:00', '11:30', '12:00']);
  assert.equal(pub.today.next[0].left, 3);
  // Amanhã não tem teto do mesmo dia: 5 vagas por horário
  const fri = pub.dates.find((d) => d.date === '2026-10-09');
  assert.equal(fri.times[0].left, 5);
  assert.equal(fri.times[0].time, '09:00');
});

test('Acesso às 13h20: primeiro horário elegível é 14:30 (grade de 30 min)', async () => {
  const pub = await publicAvailability(at(QUI, '13:20'));
  assert.equal(firstTime(pub), '14:30');
  assert.ok(!todayOf(pub).times.some((t) => t.time < '14:20'));
});

test('Acesso perto das 17h (16:10): sem horários hoje → hoje oculto, amanhã e sábado continuam', async () => {
  const pub = await publicAvailability(at(QUI, '16:10'));
  assert.equal(todayOf(pub).available, false);
  assert.equal(todayOf(pub).times.length, 0);
  assert.equal(pub.today, null);
  assert.ok(pub.dates.find((d) => d.date === '2026-10-09').available);
  await assert.rejects(createBooking(person({ date: QUI, time: '16:30' }), { now: at(QUI, '16:10') }), (e) => e.code === 'SLOT_TOO_SOON');
});

test('Acesso após o encerramento (18:30): hoje indisponível', async () => {
  const pub = await publicAvailability(at(QUI, '18:30'));
  assert.equal(todayOf(pub).available, false);
  assert.equal(pub.today, null);
  assert.ok(pub.total > 0);
});

test('Antecedência mínima validada no servidor na confirmação (cliente que demorou)', async () => {
  // Abriu às 10:00 e viu 11:00; confirma às 10:30 → recusado.
  const seen = await publicAvailability(at(QUI, '10:00'));
  assert.ok(todayOf(seen).times.find((t) => t.time === '11:00').available);
  await assert.rejects(createBooking(person({ date: QUI, time: '11:00' }), { now: at(QUI, '10:30') }), (e) => e.code === 'SLOT_TOO_SOON' && /não está mais disponível/.test(e.message));
  const later = await publicAvailability(at(QUI, '10:30'));
  assert.equal(firstTime(later), '11:30', 'a lista atualizada já não mostra 11:00');
  // Exatamente 60 minutos é permitido
  const ok = await createBooking(person({ date: QUI, time: '11:30' }), { now: at(QUI, '10:30') });
  assert.ok(ok.protocol);
});

test('Antecedência configurável (90 min)', async () => {
  await setBooking({ min_lead_minutes: 90 });
  assert.equal(firstTime(await publicAvailability(at(QUI, '10:00'))), '11:30');
  await setBooking({ min_lead_minutes: 60 });
});

test('Teto do mesmo dia: 3 por horário hoje, nunca acima da capacidade real', async () => {
  const now = at(QUI, '10:00');
  for (let i = 0; i < 3; i++) await createBooking(person({ date: QUI, time: '15:00' }), { now });
  await assert.rejects(createBooking(person({ date: QUI, time: '15:00' }), { now }), (e) => e.code === 'SLOT_FULL');
  let t = todayOf(await publicAvailability(now)).times.find((x) => x.time === '15:00');
  assert.equal(t.available, false);
  // Capacidade real menor que o teto: vale a capacidade
  await q(`UPDATE slots SET capacity = 1, manual = true WHERE date = $1 AND time = '16:00'`, [QUI]);
  t = todayOf(await publicAvailability(now)).times.find((x) => x.time === '16:00');
  assert.equal(t.left, 1, 'ÚLTIMA VAGA para este horário');
  // Sem teto extra: vale a capacidade total (5)
  await setBooking({ same_day_cap: null });
  t = todayOf(await publicAvailability(now)).times.find((x) => x.time === '15:00');
  assert.equal(t.left, 2);
  await setBooking({ same_day_cap: 3 });
});

test('Reservas simultâneas para hoje respeitam o teto (20 tentativas → 3 confirmadas)', async () => {
  const now = at(QUI, '10:00');
  const results = await Promise.all(Array.from({ length: 20 }, () => createBooking(person({ date: QUI, time: '14:00' }), { now }).then(() => 'ok', (e) => e.code)));
  assert.equal(results.filter((r) => r === 'ok').length, 3);
  assert.equal(results.filter((r) => r === 'SLOT_FULL').length, 17);
});

test('Cancelamento libera vaga de hoje', async () => {
  const now = at(QUI, '10:00');
  const { rows } = await q(`SELECT id FROM appointments WHERE date = $1 AND time = '14:00' LIMIT 1`, [QUI]);
  await setStatus(rows[0].id, 'CANCELADO');
  const t = todayOf(await publicAvailability(now)).times.find((x) => x.time === '14:00');
  assert.equal(t.left, 1);
});

test('Opções do painel: desligar HOJE, AMANHÃ ou SÁBADO', async () => {
  const now = at(QUI, '10:00');
  await setBooking({ today_enabled: false });
  let pub = await publicAvailability(now);
  assert.ok(!pub.dates.some((d) => d.isToday));
  await assert.rejects(createBooking(person({ date: QUI, time: '15:30' }), { now }), (e) => e.code === 'DATE_NOT_ALLOWED');
  await setBooking({ today_enabled: true, saturday_enabled: false });
  pub = await publicAvailability(now);
  assert.deepEqual(pub.dates.map((d) => d.date), [QUI, '2026-10-09']);
  await assert.rejects(createBooking(person({ date: '2026-10-10', time: '10:00' }), { now }), (e) => e.code === 'DATE_NOT_ALLOWED');
  await setBooking({ saturday_enabled: true });
});

test('Sábado → domingo: domingo bloqueado pelo painel não aceita agendamentos', async () => {
  const sab = at('2026-10-10', '10:00');
  let pub = await publicAvailability(sab);
  assert.deepEqual(pub.dates.map((d) => [d.date, d.tag]), [['2026-10-10', 'HOJE'], ['2026-10-11', 'AMANHÃ'], ['2026-10-17', 'PRÓXIMO SÁBADO']]);
  assert.ok(pub.dates.every((d) => d.available));
  await q(`INSERT INTO date_overrides (date, is_blocked, reason) VALUES ('2026-10-11', true, 'Domingo sem atendimento')`);
  pub = await publicAvailability(sab);
  assert.equal(pub.dates.find((d) => d.date === '2026-10-11').available, false);
  await assert.rejects(createBooking(person({ date: '2026-10-11', time: '10:00' }), { now: sab }), (e) => e.code === 'DATE_UNAVAILABLE');
  // Bloqueio prevalece também sobre HOJE
  await q(`INSERT INTO date_overrides (date, is_blocked, reason) VALUES ('2026-10-10', true, 'Feriado')`);
  pub = await publicAvailability(sab);
  assert.equal(pub.today, null);
  await q(`DELETE FROM date_overrides WHERE date IN ('2026-10-10','2026-10-11')`);
});

test('Sexta → sábado: sem data duplicada; virada de mês', async () => {
  let pub = await publicAvailability(at('2026-10-09', '10:00'));
  assert.deepEqual(pub.dates.map((d) => [d.date, d.tag]), [['2026-10-09', 'HOJE'], ['2026-10-10', 'AMANHÃ · SÁBADO']]);
  pub = await publicAvailability(at('2026-10-31', '12:00'));
  assert.deepEqual(pub.dates.map((d) => d.date), ['2026-10-31', '2026-11-01', '2026-11-07']);
});

test('Horário bloqueado no painel some de hoje; horário lotado aparece esgotado', async () => {
  const now = at(QUI, '10:00');
  await q(`UPDATE slots SET blocked = true, manual = true WHERE date = $1 AND time = '12:00'`, [QUI]);
  const day = todayOf(await publicAvailability(now));
  assert.ok(!day.times.some((t) => t.time === '12:00'));
  assert.equal(day.times.find((t) => t.time === '15:00').available, false);
});

test('Contador do topo = soma real (hoje elegível + amanhã + sábado)', async () => {
  const now = at(QUI, '10:00');
  const pub = await publicAvailability(now);
  const parts = await Promise.all([
    dayAvailability(QUI, null, { minTime: '11:00', sameDayCap: 3 }),
    dayAvailability('2026-10-09'),
    dayAvailability('2026-10-10'),
  ]);
  assert.equal(pub.total, parts.reduce((n, d) => n + d.remaining, 0));
});

test('Avisos: texto com dia relativo e hora, sem dados além do primeiro nome', () => {
  assert.equal(activityWhen('2026-10-08', '15:00', '2026-10-08'), 'para hoje, às 15h');
  assert.equal(activityWhen('2026-10-09', '11:30', '2026-10-08'), 'para amanhã, às 11h30');
  assert.equal(activityWhen('2026-10-10', '09:00', '2026-10-08'), 'para sábado, às 9h');
  assert.equal(activityWhen('2026-10-15', '16:00', '2026-10-08'), 'para quinta-feira, às 16h');
});
