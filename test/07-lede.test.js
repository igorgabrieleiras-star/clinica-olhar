// Texto principal dinâmico: exatamente as datas que o cliente pode escolher no calendário, uma palavra por data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { resetDb, pool, q } = await import('./helpers.js');
const { publicAvailability } = await import('../src/availability.js');
const { dayWords, ledeHtml } = await import('../src/views.js');
const { saveSection, getSettings } = await import('../src/settings.js');

const at = (iso, hhmm = '10:00') => new Date(`${iso}T${hhmm}:00-04:00`); // horário de Manaus
const words = async (iso, hhmm) => dayWords(await publicAvailability(at(iso, hhmm)));

before(async () => {
  await resetDb();
  await q(`UPDATE schedule_rules SET is_open = true, open_time = '09:00', close_time = '17:00', lunch_start = NULL, lunch_end = NULL, interval_minutes = 30, capacity = 5`);
  const s = await getSettings({ fresh: true });
  await saveSection('booking', { ...s.booking, enabled: true, today_enabled: true, tomorrow_enabled: true, saturday_enabled: true, min_lead_minutes: 60 });
});
after(async () => { await pool.end(); });

test('Segunda a quinta: hoje, amanhã ou sábado', async () => {
  for (const d of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) assert.equal(await words(d), 'hoje, amanhã ou sábado', d);
});

test('Sexta: hoje ou amanhã (amanhã já é sábado — sem repetir a data)', async () => {
  assert.equal(await words('2026-10-09'), 'hoje ou amanhã');
});

test('Sábado: hoje, amanhã ou o próximo sábado; com domingo desativado, hoje ou o próximo sábado', async () => {
  assert.equal(await words('2026-10-10'), 'hoje, amanhã ou o próximo sábado');
  await q(`UPDATE schedule_rules SET is_open = false WHERE weekday = 0`);
  assert.equal(await words('2026-10-10'), 'hoje ou o próximo sábado');
});

test('Domingo: hoje, amanhã ou sábado; com domingo desativado, amanhã ou sábado', async () => {
  await q(`UPDATE schedule_rules SET is_open = true WHERE weekday = 0`);
  assert.equal(await words('2026-10-11'), 'hoje, amanhã ou sábado');
  await q(`UPDATE schedule_rules SET is_open = false WHERE weekday = 0`);
  assert.equal(await words('2026-10-11'), 'amanhã ou sábado');
  await q(`UPDATE schedule_rules SET is_open = true WHERE weekday = 0`);
});

test('Datas bloqueadas ou sem horários não aparecem; uma só data: "para hoje", "para amanhã", "para sábado"', async () => {
  // Quinta às 16:30: hoje já não tem horário com 1 h de antecedência
  assert.equal(await words('2026-10-08', '16:30'), 'amanhã ou sábado');
  await q(`INSERT INTO date_overrides (date, is_blocked, reason) VALUES ('2026-10-09', true, 'Teste')`);
  assert.equal(await words('2026-10-08', '16:30'), 'sábado');
  assert.match(ledeHtml(await publicAvailability(at('2026-10-08', '16:30'))), /para <b>sábado<\/b>\.$/);
  await q(`INSERT INTO date_overrides (date, is_blocked, reason) VALUES ('2026-10-10', true, 'Teste')`);
  assert.equal(await words('2026-10-08', '10:00'), 'hoje');
  await q(`DELETE FROM date_overrides`);
});

test('Sem vagas: não anuncia disponibilidade', async () => {
  for (const d of ['2026-10-08', '2026-10-09', '2026-10-10']) await q(`INSERT INTO date_overrides (date, is_blocked, reason) VALUES ($1, true, 'Teste')`, [d]);
  const av = await publicAvailability(at('2026-10-08'));
  assert.equal(av.total, 0);
  const html = ledeHtml(av);
  assert.doesNotMatch(html, /escolha seu horário para/);
  assert.match(html, /vagas foram preenchidas|não há horários/);
  await q(`DELETE FROM date_overrides`);
});
