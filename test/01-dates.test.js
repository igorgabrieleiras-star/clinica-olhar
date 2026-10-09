import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicCandidateDates, todayISO, formatLongDate, earliestTimeToday } from '../src/dates.js';

// Horário de Manaus (UTC-4) em cada dia da semana de 05/10/2026 (segunda) a 11/10/2026 (domingo).
const at = (iso, hhmm = '12:00') => new Date(`${iso}T${hhmm}:00-04:00`);
const opts = (now, flags) => publicCandidateDates(now, flags).map((c) => `${c.tag}:${c.date}`);

test('Segunda: HOJE, AMANHÃ (terça) e SÁBADO', () => {
  assert.deepEqual(opts(at('2026-10-05')), ['HOJE:2026-10-05', 'AMANHÃ:2026-10-06', 'SÁBADO:2026-10-10']);
});
test('Terça e quarta: hoje, amanhã e sábado', () => {
  assert.deepEqual(opts(at('2026-10-06')), ['HOJE:2026-10-06', 'AMANHÃ:2026-10-07', 'SÁBADO:2026-10-10']);
  assert.deepEqual(opts(at('2026-10-07')), ['HOJE:2026-10-07', 'AMANHÃ:2026-10-08', 'SÁBADO:2026-10-10']);
});
test('Quinta (exemplo do briefing): HOJE quinta, AMANHÃ sexta, SÁBADO', () => {
  assert.deepEqual(opts(at('2026-10-08')), ['HOJE:2026-10-08', 'AMANHÃ:2026-10-09', 'SÁBADO:2026-10-10']);
  assert.equal(formatLongDate('2026-10-09'), 'Sexta-feira, 09 de outubro');
});
test('Sexta: HOJE e AMANHÃ · SÁBADO numa única opção (sem data duplicada)', () => {
  const r = publicCandidateDates(at('2026-10-09'));
  assert.deepEqual(r.map((c) => [c.date, c.tag]), [['2026-10-09', 'HOJE'], ['2026-10-10', 'AMANHÃ · SÁBADO']]);
  assert.equal(new Set(r.map((c) => c.date)).size, r.length);
});
test('Sábado: HOJE (sábado), AMANHÃ (domingo) e PRÓXIMO SÁBADO (semana seguinte)', () => {
  assert.deepEqual(opts(at('2026-10-10')), ['HOJE:2026-10-10', 'AMANHÃ:2026-10-11', 'PRÓXIMO SÁBADO:2026-10-17']);
});
test('Domingo: HOJE, AMANHÃ (segunda) e o próximo sábado', () => {
  assert.deepEqual(opts(at('2026-10-11')), ['HOJE:2026-10-11', 'AMANHÃ:2026-10-12', 'SÁBADO:2026-10-17']);
});
test('Transição sexta → sábado à meia-noite de Manaus', () => {
  assert.deepEqual(opts(new Date('2026-10-10T03:59:00Z')), ['HOJE:2026-10-09', 'AMANHÃ · SÁBADO:2026-10-10']); // sexta 23:59
  assert.deepEqual(opts(new Date('2026-10-10T04:00:00Z')), ['HOJE:2026-10-10', 'AMANHÃ:2026-10-11', 'PRÓXIMO SÁBADO:2026-10-17']); // sábado 00:00
});
test('Transição sábado → domingo', () => {
  assert.deepEqual(opts(new Date('2026-10-11T04:00:00Z')), ['HOJE:2026-10-11', 'AMANHÃ:2026-10-12', 'SÁBADO:2026-10-17']);
});
test('Fuso de Manaus: 23:30 de quinta em Manaus já é sexta em UTC', () => {
  const now = new Date('2026-10-09T03:30:00Z');
  assert.equal(todayISO(now), '2026-10-08');
  assert.deepEqual(opts(now), ['HOJE:2026-10-08', 'AMANHÃ:2026-10-09', 'SÁBADO:2026-10-10']);
});
test('Virada de mês e de ano', () => {
  assert.deepEqual(opts(at('2026-10-30')), ['HOJE:2026-10-30', 'AMANHÃ · SÁBADO:2026-10-31']);
  assert.deepEqual(opts(at('2026-10-31')), ['HOJE:2026-10-31', 'AMANHÃ:2026-11-01', 'PRÓXIMO SÁBADO:2026-11-07']);
  assert.deepEqual(opts(at('2026-12-31')), ['HOJE:2026-12-31', 'AMANHÃ:2027-01-01', 'SÁBADO:2027-01-02']);
});
test('Opções desligadas no painel não aparecem', () => {
  assert.deepEqual(opts(at('2026-10-08'), { today: false }), ['AMANHÃ:2026-10-09', 'SÁBADO:2026-10-10']);
  assert.deepEqual(opts(at('2026-10-08'), { saturday: false }), ['HOJE:2026-10-08', 'AMANHÃ:2026-10-09']);
  assert.deepEqual(opts(at('2026-10-09'), { tomorrow: false }), ['HOJE:2026-10-09', 'SÁBADO:2026-10-10']);
  assert.deepEqual(opts(at('2026-10-08'), { today: false, tomorrow: false, saturday: false }), []);
});
test('Nunca oferece datas passadas', () => {
  for (let d = 1; d <= 28; d++) {
    const now = at(`2026-02-${String(d).padStart(2, '0')}`);
    for (const c of publicCandidateDates(now)) assert.ok(c.date >= todayISO(now));
  }
});
test('Antecedência mínima: agora + 60 minutos (relógio do servidor)', () => {
  assert.equal(earliestTimeToday(at('2026-10-08', '08:15')), '09:15'); // antes das 9h
  assert.equal(earliestTimeToday(at('2026-10-08', '10:00')), '11:00'); // 10h → 11:00 em diante
  assert.equal(earliestTimeToday(at('2026-10-08', '13:20')), '14:20'); // 13h20 → 14:30 na grade de 30 min
  assert.equal(earliestTimeToday(at('2026-10-08', '16:10')), '17:10'); // perto das 17h → nada hoje
  assert.equal(earliestTimeToday(at('2026-10-08', '23:30')), null);
  assert.equal(earliestTimeToday(at('2026-10-08', '10:00'), 90), '11:30');
});
