import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, THURSDAY, person, pool, q } from './helpers.js';

const { createBooking, setStatus, rescheduleAppointment, parsePublicBooking, BookingError } = await import('../src/booking.js');
const { publicAvailability, dayAvailability, syncDate } = await import('../src/availability.js');
const { saveSection, getSettings } = await import('../src/settings.js');
const { sendConversion } = await import('../src/meta.js');
const { cleanName, cleanAge, cleanWhatsapp, ValidationError } = await import('../src/validate.js');
const { runRetention } = await import('../src/app.js');

before(resetDb);
after(() => pool.end());

const rejects = (p, code) => assert.rejects(p, (e) => e.code === code || (console.error(e), false));

test('1/13/14. Cadastro completo: grava paciente, agendamento, protocolo, UTMs e consentimentos', async () => {
  const b = await createBooking(person({ name: 'Mariana Silva', whatsapp: '92999999999', time: '09:30', marketing: true, attribution: { utm_source: 'facebook', utm_campaign: 'Exame Grátis Manaus', utm_content: 'Criativo 02', fbclid: 'abc' } }), { now: THURSDAY });
  assert.match(b.protocol, /^OLH-\d{6}$/);
  const { rows } = await q(`SELECT a.status, a.date, a.time, p.name, t.utm_campaign, t.utm_content, t.fbclid FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN attributions t ON t.appointment_id=a.id WHERE a.protocol=$1`, [b.protocol]);
  assert.deepEqual(rows[0], { status: 'NOVO', date: '2026-10-09', time: '09:30', name: 'Mariana Silva', utm_campaign: 'Exame Grátis Manaus', utm_content: 'Criativo 02', fbclid: 'abc' });
  const { rows: c } = await q(`SELECT purpose, granted FROM consents WHERE appointment_id=$1 ORDER BY purpose`, [b.id]);
  assert.deepEqual(Object.fromEntries(c.map((r) => [r.purpose, r.granted])), { agendamento: true, cookies_anuncios: false, exibir_primeiro_nome: false, mensagens_promocionais: true });
  const b2 = await createBooking(person(), { now: THURSDAY });
  assert.equal(Number(b2.protocol.slice(4)), Number(b.protocol.slice(4)) + 1);
});

test('2. Validação do nome (acentos aceitos, números e vazios recusados)', () => {
  assert.equal(cleanName('  joão   da  silva  '), 'joão da silva');
  assert.equal(cleanName("Maria D'Ávila Conceição"), "Maria D'Ávila Conceição");
  for (const bad of ['', 'a', '123', 'Ana 2', '<script>', 'x'.repeat(81)]) assert.throws(() => cleanName(bad), ValidationError);
});

test('3. Validação da idade e regras configuráveis', () => {
  assert.equal(cleanAge('42'), 42);
  assert.equal(cleanAge('0'), 0);
  for (const bad of ['', 'abc', '-3', '121', '4.5']) assert.throws(() => cleanAge(bad), ValidationError);
  assert.throws(() => cleanAge('15', { minor_rule: 'blocked' }), /maiores de 18/);
  assert.equal(cleanAge('15', { minor_rule: 'allowed' }), 15);
  assert.throws(() => cleanAge('30', { min_age: 35 }), /a partir de 35/);
  const settings = { booking: { minor_rule: 'guardian_required' }, privacy: {} };
  assert.throws(() => parsePublicBooking({ name: 'Lucas Lima', age: '12', whatsapp: '92988887777', consent_data: true, date: '2026-10-09', time: '08:00' }, settings), (e) => e.field === 'guardian_name');
  const ok = parsePublicBooking({ name: 'Lucas Lima', age: '12', guardian_name: 'Ana Lima', guardian_ack: true, whatsapp: '92988887777', consent_data: true, date: '2026-10-09', time: '08:00' }, settings);
  assert.equal(ok.guardian, 'Ana Lima');
});

test('4. Validação do WhatsApp (máscara, DDD, nono dígito)', () => {
  assert.equal(cleanWhatsapp('(92) 99999-9999'), '92999999999');
  assert.equal(cleanWhatsapp('+55 92 98765-4321'), '92987654321');
  assert.equal(cleanWhatsapp('(92) 3633-1234'), '9236331234');
  for (const bad of ['', '9299999', '(20) 99999-9999', '(92) 89999-9999', '00000000000', '999999999999999']) assert.throws(() => cleanWhatsapp(bad), ValidationError, bad);
  assert.throws(() => parsePublicBooking({ name: 'Ana Souza', age: '30', whatsapp: '92988887777', consent_data: false, date: '2026-10-09', time: '08:00' }, { booking: {}, privacy: {} }), (e) => e.field === 'consent_data');
});

test('Regra de datas no servidor: recusa datas fora de amanhã/sábado e datas passadas', async () => {
  await rejects(createBooking(person({ date: '2026-10-12' }), { now: THURSDAY }), 'DATE_NOT_ALLOWED');
  await rejects(createBooking(person({ date: '2026-10-08' }), { now: THURSDAY }), 'DATE_NOT_ALLOWED');
  await rejects(createBooking(person({ date: '2026-10-07' }), { now: THURSDAY }), 'DATE_NOT_ALLOWED');
  // Sábado é aceito
  const b = await createBooking(person({ date: '2026-10-10', time: '08:00' }), { now: THURSDAY });
  assert.ok(b.protocol);
});

test('10/11. Horários reais e bloqueio de horário lotado', async () => {
  const day = await dayAvailability('2026-10-09');
  const slot = day.slots.find((s) => s.time === '10:00');
  assert.equal(slot.capacity, 5);
  for (let i = 0; i < 3; i++) await createBooking(person({ time: '10:00' }), { now: THURSDAY });
  let s = (await dayAvailability('2026-10-09')).slots.find((x) => x.time === '10:00');
  assert.equal(s.free, 2, 'três reservas em 10:00 deixam duas vagas');
  for (let i = 0; i < 2; i++) await createBooking(person({ time: '10:00' }), { now: THURSDAY });
  await rejects(createBooking(person({ time: '10:00' }), { now: THURSDAY }), 'SLOT_FULL');
  const pub = await publicAvailability(THURSDAY);
  const t = pub.dates[0].times.find((x) => x.time === '10:00');
  assert.equal(t.available, false, 'aparece como esgotado no site');
});

test('12. Reservas simultâneas não ultrapassam a capacidade', async () => {
  const before = (await dayAvailability('2026-10-09')).slots.find((x) => x.time === '13:00');
  assert.equal(before.free, 5);
  const attempts = Array.from({ length: 25 }, () => createBooking(person({ time: '13:00' }), { now: THURSDAY }).then(() => 'ok', (e) => e.code));
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r === 'ok').length, 5);
  assert.equal(results.filter((r) => r === 'SLOT_FULL').length, 20);
  const { rows } = await q(`SELECT count(*) AS n FROM appointments WHERE date='2026-10-09' AND time='13:00' AND status <> 'CANCELADO'`);
  assert.equal(rows[0].n, 5);
});

test('Limite diário configurado é respeitado mesmo com vagas nos horários', async () => {
  await q(`INSERT INTO date_overrides (date, daily_limit) VALUES ('2026-10-10', 3)`);
  const d0 = await dayAvailability('2026-10-10');
  assert.equal(d0.remaining, 2); // já existe 1 agendamento no sábado
  await createBooking(person({ date: '2026-10-10', time: '09:00' }), { now: THURSDAY });
  await createBooking(person({ date: '2026-10-10', time: '09:30' }), { now: THURSDAY });
  await rejects(createBooking(person({ date: '2026-10-10', time: '10:00' }), { now: THURSDAY }), 'SLOT_FULL');
  const pub = await publicAvailability(THURSDAY);
  assert.equal(pub.dates.find((d) => d.kind === 'sabado').available, false);
  await q(`DELETE FROM date_overrides WHERE date='2026-10-10'`);
});

test('17. Cancelamento libera a vaga; reativação exige vaga livre', async () => {
  const { rows } = await q(`SELECT id FROM appointments WHERE date='2026-10-09' AND time='13:00' AND status <> 'CANCELADO' LIMIT 1`);
  await rejects(createBooking(person({ time: '13:00' }), { now: THURSDAY }), 'SLOT_FULL');
  await setStatus(rows[0].id, 'CANCELADO');
  const s = (await dayAvailability('2026-10-09')).slots.find((x) => x.time === '13:00');
  assert.equal(s.free, 1);
  const b = await createBooking(person({ time: '13:00' }), { now: THURSDAY });
  assert.ok(b.protocol);
  await rejects(setStatus(rows[0].id, 'NOVO'), 'SLOT_FULL');
});

test('Agendamento duplicado do mesmo paciente na mesma data é bloqueado', async () => {
  const p = person({ name: 'Carlos Pereira', time: '14:00' });
  await createBooking(p, { now: THURSDAY });
  await rejects(createBooking({ ...p, time: '14:30' }, { now: THURSDAY }), 'DUPLICATE');
  await rejects(createBooking({ ...p, name: 'carlos pereira', time: '15:00' }, { now: THURSDAY }), 'DUPLICATE');
  // Mesmo WhatsApp para outra pessoa (agendar para um familiar) é permitido
  const other = await createBooking({ ...p, name: 'Helena Pereira', time: '14:00' }, { now: THURSDAY });
  assert.ok(other.protocol);
});

test('Reenvio com a mesma chave não duplica (rede instável)', async () => {
  const key = '0b6e7f39-3f2a-4e7d-9c51-55c4f3f7a1aa';
  const p = person({ time: '15:30', idempotencyKey: key });
  const [a, b] = await Promise.all([createBooking(p, { now: THURSDAY }), createBooking(p, { now: THURSDAY })]);
  assert.equal(a.protocol, b.protocol);
  assert.ok(a.replay || b.replay);
  const { rows } = await q('SELECT count(*) AS n FROM appointments WHERE idempotency_key=$1', [key]);
  assert.equal(rows[0].n, 1);
});

test('Datas bloqueadas pelo administrador não aparecem e não aceitam reservas', async () => {
  await q(`INSERT INTO date_overrides (date, is_blocked, reason) VALUES ('2026-10-09', true, 'Feriado')`);
  const pub = await publicAvailability(THURSDAY);
  assert.equal(pub.dates.find((d) => d.date === '2026-10-09').available, false);
  assert.equal(pub.dates.find((d) => d.date === '2026-10-10').available, true);
  await rejects(createBooking(person({ time: '08:30' }), { now: THURSDAY }), 'DATE_UNAVAILABLE');
  await q(`DELETE FROM date_overrides WHERE date='2026-10-09'`);
});

test('Domingo fechado por padrão: no sábado só aparece o sábado seguinte', async () => {
  const saturday = new Date('2026-10-10T15:00:00Z');
  const pub = await publicAvailability(saturday);
  assert.deepEqual(pub.dates.filter((d) => d.available).map((d) => d.date), ['2026-10-17']);
});

test('9. Contador de vagas = soma das vagas reais das datas oferecidas', async () => {
  const pub = await publicAvailability(THURSDAY);
  const fri = await dayAvailability('2026-10-09');
  const sat = await dayAvailability('2026-10-10');
  assert.equal(pub.total, fri.remaining + sat.remaining);
  assert.equal(pub.total, fri.slots.reduce((n, s) => n + s.free, 0) + sat.slots.reduce((n, s) => n + s.free, 0));
});

test('Sem vagas: as duas datas lotadas → total 0 e nenhuma data disponível', async () => {
  await q(`UPDATE slots SET blocked = true, manual = true WHERE date IN ('2026-10-09','2026-10-10')`);
  const pub = await publicAvailability(THURSDAY);
  assert.equal(pub.total, 0);
  assert.equal(pub.dates.some((d) => d.available), false);
  await rejects(createBooking(person({ time: '08:30' }), { now: THURSDAY }), 'SLOT_UNAVAILABLE');
  await q(`UPDATE slots SET blocked = false, manual = false WHERE date IN ('2026-10-09','2026-10-10')`);
});

test('Agendamento fechado no painel → site não aceita reservas', async () => {
  const s = await getSettings({ fresh: true });
  await saveSection('booking', { ...s.booking, enabled: false });
  const pub = await publicAvailability(THURSDAY);
  assert.equal(pub.total, 0);
  await rejects(createBooking(person({ time: '08:30' }), { now: THURSDAY }), 'BOOKING_CLOSED');
  await saveSection('booking', { ...s.booking, enabled: true });
});

test('Remarcação pelo administrador (qualquer data com horários) respeita capacidade', async () => {
  const b = await createBooking(person({ time: '08:30' }), { now: THURSDAY });
  const r = await rescheduleAppointment(b.id, '2026-10-20', '09:00');
  assert.deepEqual(r.to, { date: '2026-10-20', time: '09:00' });
  const { rows } = await q('SELECT a.date, a.time, s.date AS sdate FROM appointments a JOIN slots s ON s.id=a.slot_id WHERE a.id=$1', [b.id]);
  assert.equal(rows[0].sdate, '2026-10-20');
  const s = (await dayAvailability('2026-10-09')).slots.find((x) => x.time === '08:30');
  assert.equal(s.booked, 0, 'a vaga original foi liberada');
  await q(`UPDATE slots SET capacity = 1, manual = true WHERE date='2026-10-20' AND time='09:30'`);
  const other = await createBooking(person({ time: '15:00' }), { now: THURSDAY });
  await rescheduleAppointment(other.id, '2026-10-20', '09:30');
  await rejects(rescheduleAppointment(b.id, '2026-10-20', '09:30'), 'SLOT_FULL');
});

test('Mudança nas regras reaplica a agenda sem apagar horários com pacientes', async () => {
  await q(`UPDATE schedule_rules SET open_time='09:00', close_time='12:00', lunch_start=NULL, lunch_end=NULL, capacity=3 WHERE weekday=5`);
  await syncDate('2026-10-09');
  const d = await dayAvailability('2026-10-09');
  const s0800 = d.slots.find((s) => s.time === '08:00');
  assert.ok(s0800?.blocked, '08:00 tinha paciente: fica bloqueado, não apagado');
  assert.ok(d.slots.find((s) => s.time === '11:30'), 'novo horário criado');
  assert.equal(d.slots.find((s) => s.time === '11:30').capacity, 3);
  assert.ok(!d.slots.find((s) => s.time === '14:30'), 'horário sem paciente removido');
});

test('19. API de Conversões: envia Lead uma única vez, com dados em hash e sem idade/saúde', async () => {
  const s = await getSettings({ fresh: true });
  await saveSection('meta', { ...s.meta, capi_enabled: true, pixel_id: '123456789012345', pixel_enabled: true });
  const { config } = await import('../src/config.js');
  config.metaCapiToken = 'TEST_TOKEN';
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, text: async () => '{"events_received":1}' }; };
  const b = await createBooking(person({ name: 'Joana Prado', time: '09:00', date: '2026-10-10' }), { now: THURSDAY });
  const noConsent = await sendConversion(b, { adsConsent: false }, { fetchImpl });
  assert.equal(noConsent.skipped, 'no_consent');
  await sendConversion(b, { adsConsent: true, ip: '200.1.2.3', userAgent: 'test', fbclid: 'XYZ' }, { fetchImpl });
  await sendConversion(b, { adsConsent: true }, { fetchImpl });
  assert.equal(calls.length, 1, 'Lead enviado uma vez');
  const ev = calls[0].body.data[0];
  assert.equal(ev.event_name, 'Lead');
  assert.equal(ev.event_id, b.eventId);
  assert.match(ev.user_data.ph[0], /^[a-f0-9]{64}$/);
  assert.match(ev.user_data.fbc, /^fb\.1\.\d+\.XYZ$/);
  const raw = JSON.stringify(calls[0].body);
  assert.ok(!raw.includes('92') || !raw.includes(b.whatsapp), 'telefone não vai em texto puro');
  assert.deepEqual(Object.keys(ev.user_data).sort(), ['client_ip_address', 'client_user_agent', 'country', 'external_id', 'fbc', 'fn', 'ph']);
  assert.ok(!/idade|exame|sa[uú]de|"age"/i.test(raw), 'sem idade ou dados de saúde');
  assert.ok(!('custom_data' in ev));
  config.metaCapiToken = '';
});

test('LGPD: retenção anonimiza dados antigos', async () => {
  const s = await getSettings({ fresh: true });
  await saveSection('privacy', { ...s.privacy, retention_days: 30 });
  const old = await createBooking(person({ name: 'Antigo Paciente', time: '10:30', date: '2026-10-10' }), { now: THURSDAY });
  await q(`UPDATE appointments SET date = '2025-01-10' WHERE id=$1`, [old.id]);
  await q(`UPDATE patients SET created_at = now() - interval '400 days' WHERE id=$1`, [old.patientId]);
  const r = await runRetention();
  assert.ok(r.patients >= 1);
  const { rows } = await q('SELECT name, whatsapp, anonymized_at FROM patients WHERE id=$1', [old.patientId]);
  assert.equal(rows[0].name, 'Dados excluídos');
  assert.equal(rows[0].whatsapp, '00000000000');
  const { rows: recent } = await q(`SELECT count(*) AS n FROM patients WHERE anonymized_at IS NOT NULL AND id <> $1`, [old.patientId]);
  assert.equal(recent[0].n, 0, 'pacientes recentes não são afetados');
});

test('BookingError tem status HTTP adequado', () => {
  assert.equal(new BookingError('X', 'y').status, 409);
});
