import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicCandidateDates, nextSaturdayISO, todayISO, formatLongDate, earliestTimeToday, addDays } from '../src/dates.js';

// Horário de Manaus (UTC-4). Semana de referência: 05/10/2026 (segunda) a 11/10/2026 (domingo).
const at = (iso, hhmm = '12:00') => new Date(`${iso}T${hhmm}:00-04:00`);
const dates = (now, flags) => publicCandidateDates(now, flags).map((c) => c.date);
const range = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) if (new Date(d + 'T12:00:00Z').getUTCDay() !== 0) out.push(d); return out; };

test('Segunda: segunda a sábado desta semana + segunda a sábado da próxima (12 datas)', () => {
  assert.deepEqual(dates(at('2026-10-12')), range('2026-10-12', '2026-10-24'));
  assert.equal(dates(at('2026-10-12')).length, 12);
});
test('Quarta: quarta a sábado + próxima semana completa (segunda e terça que passaram ficam de fora)', () => {
  assert.deepEqual(dates(at('2026-10-14')), ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', ...range('2026-10-19', '2026-10-24')]);
});
test('Sábado: o próprio sábado + segunda a sábado da próxima semana', () => {
  assert.deepEqual(dates(at('2026-10-17')), ['2026-10-17', ...range('2026-10-19', '2026-10-24')]);
});
test('Domingo: nunca o domingo; segunda a sábado que começa amanhã + a semana seguinte', () => {
  assert.deepEqual(dates(at('2026-10-11')), range('2026-10-12', '2026-10-24'));
  assert.deepEqual(dates(at('2026-10-18')), range('2026-10-19', '2026-10-31'));
});
test('Domingo nunca aparece em nenhum dia do ano', () => {
  for (let d = '2026-01-01'; d <= '2027-01-10'; d = addDays(d, 1)) {
    const c = publicCandidateDates(at(d));
    assert.ok(c.every((x) => new Date(x.date + 'T12:00:00Z').getUTCDay() !== 0), d);
    assert.ok(c.every((x) => x.date >= d), 'sem datas passadas ' + d);
    assert.ok(c.length >= 7 && c.length <= 12, d + ' ' + c.length);
  }
});
test('Renovação automática: sábado → domingo → segunda avança a janela uma semana', () => {
  assert.deepEqual(dates(new Date('2026-10-18T03:59:00Z')), ['2026-10-17', ...range('2026-10-19', '2026-10-24')]); // sáb 23:59 Manaus
  assert.deepEqual(dates(new Date('2026-10-18T04:00:00Z')), range('2026-10-19', '2026-10-31')); // dom 00:00 Manaus
  assert.deepEqual(dates(at('2026-10-19')), range('2026-10-19', '2026-10-31'));
});
test('Semana 1 e semana 2 identificadas; HOJE e AMANHÃ marcados', () => {
  const c = publicCandidateDates(at('2026-10-16')); // sexta
  assert.deepEqual(c.map((x) => [x.date, x.week, x.tag]).slice(0, 3), [['2026-10-16', 1, 'HOJE'], ['2026-10-17', 1, 'AMANHÃ'], ['2026-10-19', 2, 'SEGUNDA']]);
  assert.equal(c.at(-1).tag, 'SÁBADO');
});
test('Virada de mês e de ano', () => {
  assert.deepEqual(dates(at('2026-10-28')), ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', ...range('2026-11-02', '2026-11-07')]);
  assert.deepEqual(dates(at('2026-12-30')), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', ...range('2027-01-04', '2027-01-09')]);
  assert.deepEqual(dates(at('2027-01-03')), range('2027-01-04', '2027-01-16')); // domingo no início do ano
});
test('Fuso de Manaus: 23:30 de quinta em Manaus já é sexta em UTC', () => {
  const now = new Date('2026-10-16T03:30:00Z');
  assert.equal(todayISO(now), '2026-10-15');
  assert.equal(dates(now)[0], '2026-10-15');
});
test('Mesmo dia desligado no painel tira só o dia de hoje', () => {
  assert.deepEqual(dates(at('2026-10-14'), { today: false }), ['2026-10-15', '2026-10-16', '2026-10-17', ...range('2026-10-19', '2026-10-24')]);
});
test('Próximo sábado (filtros do painel): no sábado, o da semana seguinte', () => {
  assert.equal(nextSaturdayISO(at('2026-10-14')), '2026-10-17');
  assert.equal(nextSaturdayISO(at('2026-10-17')), '2026-10-24');
  assert.equal(formatLongDate('2026-10-09'), 'Sexta-feira, 09 de outubro');
});
test('Antecedência mínima: agora + 60 minutos (relógio do servidor)', () => {
  assert.equal(earliestTimeToday(at('2026-10-08', '08:15')), '09:15'); // antes das 9h
  assert.equal(earliestTimeToday(at('2026-10-08', '10:00')), '11:00'); // 10h → 11:00 em diante
  assert.equal(earliestTimeToday(at('2026-10-08', '13:20')), '14:20'); // 13h20 → 14:30 na grade de 30 min
  assert.equal(earliestTimeToday(at('2026-10-08', '16:10')), '17:10'); // perto das 17h → nada hoje
  assert.equal(earliestTimeToday(at('2026-10-08', '23:30')), null);
  assert.equal(earliestTimeToday(at('2026-10-08', '10:00'), 90), '11:30');
});
