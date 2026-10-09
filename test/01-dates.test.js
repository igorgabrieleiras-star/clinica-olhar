import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicCandidateDates, todayISO, formatLongDate } from '../src/dates.js';

// Meio-dia em Manaus (16h UTC) de cada dia da semana de 05/10/2026 (segunda) a 11/10/2026 (domingo).
const at = (iso, hhmm = '12:00') => new Date(`${iso}T${hhmm}:00-04:00`);
const dates = (now) => publicCandidateDates(now).map((c) => `${c.kind}:${c.date}`);

test('5/6. Segunda: amanhã (terça) e sábado', () => {
  assert.deepEqual(dates(at('2026-10-05')), ['amanha:2026-10-06', 'sabado:2026-10-10']);
});
test('Terça: amanhã (quarta) e sábado', () => {
  assert.deepEqual(dates(at('2026-10-06')), ['amanha:2026-10-07', 'sabado:2026-10-10']);
});
test('Quarta: amanhã (quinta) e sábado', () => {
  assert.deepEqual(dates(at('2026-10-07')), ['amanha:2026-10-08', 'sabado:2026-10-10']);
});
test('Quinta: amanhã (sexta) e sábado — exemplo do briefing', () => {
  assert.deepEqual(dates(at('2026-10-08')), ['amanha:2026-10-09', 'sabado:2026-10-10']);
  assert.equal(formatLongDate('2026-10-09'), 'Sexta-feira, 09 de outubro');
  assert.equal(formatLongDate('2026-10-10'), 'Sábado, 10 de outubro');
});
test('7. Sexta: amanhã já é sábado → uma única opção, sem duplicar', () => {
  const r = publicCandidateDates(at('2026-10-09'));
  assert.equal(r.length, 1);
  assert.equal(r[0].date, '2026-10-10');
  assert.equal(r[0].isSaturday, true);
});
test('8. Sábado: amanhã (domingo) e o sábado seguinte', () => {
  assert.deepEqual(dates(at('2026-10-10')), ['amanha:2026-10-11', 'sabado:2026-10-17']);
});
test('8. Domingo: amanhã (segunda) e o próximo sábado', () => {
  assert.deepEqual(dates(at('2026-10-11')), ['amanha:2026-10-12', 'sabado:2026-10-17']);
});

test('9. Fuso de Manaus: 23:30 de quinta em Manaus já é sexta em UTC', () => {
  const now = new Date('2026-10-09T03:30:00Z'); // quinta 23:30 em Manaus
  assert.equal(todayISO(now), '2026-10-08');
  assert.deepEqual(dates(now), ['amanha:2026-10-09', 'sabado:2026-10-10']);
});
test('9. Fuso de Manaus: virada para sexta 00:00 muda as opções', () => {
  const now = new Date('2026-10-09T04:00:00Z'); // sexta 00:00 em Manaus
  assert.equal(todayISO(now), '2026-10-09');
  assert.deepEqual(dates(now), ['amanha:2026-10-10']);
});
test('Virada de mês e de ano', () => {
  assert.deepEqual(dates(at('2026-12-31')), ['amanha:2027-01-01', 'sabado:2027-01-02']);
  assert.deepEqual(dates(at('2027-02-26')), ['amanha:2027-02-27']); // sexta
});
test('Nunca oferece hoje nem datas passadas', () => {
  for (let i = 0; i < 400; i++) {
    const now = new Date(Date.UTC(2026, 0, 1, 15) + i * 86400000);
    const today = todayISO(now);
    for (const c of publicCandidateDates(now)) assert.ok(c.date > today, `${c.date} > ${today}`);
    const r = publicCandidateDates(now);
    assert.ok(r.length === 1 || r[0].date !== r[1].date);
  }
});
