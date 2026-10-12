// Texto principal e avisos: frase geral (sem listar datas), só quando há vagas reais na janela de 2 semanas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { resetDb, pool, q } = await import('./helpers.js');
const { publicAvailability } = await import('../src/availability.js');
const { ledeHtml } = await import('../src/views.js');
const { saveSection, getSettings } = await import('../src/settings.js');

const at = (iso, hhmm = '10:00') => new Date(`${iso}T${hhmm}:00-04:00`); // horário de Manaus

before(async () => {
  await resetDb();
  await q(`UPDATE schedule_rules SET is_open = true, open_time = '09:00', close_time = '17:00', lunch_start = NULL, lunch_end = NULL, interval_minutes = 30, capacity = 5`);
  const s = await getSettings({ fresh: true });
  await saveSection('booking', { ...s.booking, enabled: true, today_enabled: true, min_lead_minutes: 60 });
});
after(async () => { await pool.end(); });

test('Com vagas: frase geral, sem "amanhã ou sábado" e sem listar datas', async () => {
  for (const d of ['2026-10-12', '2026-10-14', '2026-10-17', '2026-10-18']) {
    const html = ledeHtml(await publicAvailability(at(d)));
    assert.equal(html, 'Faça seu cadastro e escolha uma das <b>datas e horários disponíveis</b>.', d);
    assert.doesNotMatch(html, /amanhã|sábado/);
  }
});

test('Sem vagas em nenhuma data da janela: não anuncia disponibilidade', async () => {
  const av0 = await publicAvailability(at('2026-10-14'));
  for (const d of av0.dates) await q(`INSERT INTO date_overrides (date, is_blocked, reason) VALUES ($1, true, 'Teste')`, [d.date]);
  const av = await publicAvailability(at('2026-10-14'));
  assert.equal(av.total, 0);
  assert.ok(av.dates.every((d) => !d.available));
  const html = ledeHtml(av);
  assert.doesNotMatch(html, /datas e horários disponíveis/);
  assert.match(html, /vagas foram preenchidas|não há horários/);
  await q(`DELETE FROM date_overrides`);
});

test('Data lotada fica desabilitada; parcialmente ocupada continua com os horários livres', async () => {
  const now = at('2026-10-14');
  await publicAvailability(now); // materializa os horários da janela
  await q(`UPDATE slots SET capacity = 0, manual = true WHERE date = '2026-10-20'`);
  await q(`UPDATE slots SET capacity = 0, manual = true WHERE date = '2026-10-21' AND time < '16:00'`);
  const av = await publicAvailability(now);
  assert.equal(av.dates.find((d) => d.date === '2026-10-20').available, false);
  const part = av.dates.find((d) => d.date === '2026-10-21');
  assert.equal(part.available, true);
  assert.deepEqual(part.times.filter((t) => t.available).map((t) => t.time), ['16:00', '16:30']);
});
