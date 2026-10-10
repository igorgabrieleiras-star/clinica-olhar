// Central de agendamentos do painel: indicadores, horários mais procurados, evolução, situação, filtros,
// exportação e aviso ao vivo. Todos os números são conferidos diretamente com o banco.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.FAKE_NOW = '2026-10-08T14:00:00Z'; // quinta-feira, 10h em Manaus
const { resetDb, pool, q, person } = await import('./helpers.js');
const { createApp } = await import('../src/app.js');
const { createAdmin } = await import('../src/auth.js');
const { createBooking, setStatus } = await import('../src/booking.js');
const { dayAvailability } = await import('../src/availability.js');
const { periodRange } = await import('../src/routes/admin.js');
const { stopAppointmentsListener } = await import('../src/live.js');

const THU = '2026-10-08', FRI = '2026-10-09';
const NOW = new Date('2026-10-08T14:00:00Z');
let adm, base, cookie;

async function call(method, path, { body, ck = cookie } = {}) {
  const h = { accept: 'application/json', 'x-olhar-csrf': '1' };
  if (ck) h.cookie = ck;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}

const ids = {};
before(async () => {
  await resetDb();
  await q(`UPDATE schedule_rules SET is_open = true, open_time = '09:00', close_time = '12:00', lunch_start = NULL, lunch_end = NULL, interval_minutes = 30, capacity = 3`);
  await createAdmin({ email: 'principal@teste.com', name: 'Igor', password: 'SenhaPrincipal123', mustChange: false });
  adm = createApp({ role: 'admin' });
  await new Promise((r) => adm.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${adm.address().port}`;
  const r = await call('POST', '/api/admin/login', { body: { email: 'principal@teste.com', password: 'SenhaPrincipal123' }, ck: null });
  cookie = r.headers.get('set-cookie').split(';')[0];

  // Sexta: 11:00 (3 pacientes — horário mais procurado), 10:00 (2), 09:30 (1)
  const mk = async (time, extra = {}) => (await createBooking(person({ date: FRI, time, ...extra }), { now: NOW })).id;
  ids.a = await mk('11:00', { attribution: { utm_source: 'facebook', utm_campaign: 'Exame Gratis Manaus', fbclid: 'abc123' } });
  ids.b = await mk('11:00', { attribution: { utm_source: 'instagram', utm_campaign: 'Exame Gratis Manaus' } });
  ids.c = await mk('11:00');
  ids.d = await mk('10:00', { name: 'Mariana Conceição' });
  ids.e = await mk('10:00');
  ids.f = await mk('09:30');
  await setStatus(ids.a, 'CONFIRMADO');
  await setStatus(ids.b, 'CONTATADO');
  await setStatus(ids.d, 'COMPARECEU');
  await setStatus(ids.e, 'NAO_COMPARECEU');
  await setStatus(ids.f, 'CANCELADO');
});
after(async () => { stopAppointmentsListener(); adm.closeAllConnections(); adm.close(); await pool.end(); });

test('Períodos pela data do exame, no fuso de Manaus', () => {
  const p = new URLSearchParams();
  assert.deepEqual(periodRange('hoje', p, NOW), { from: THU, to: THU, single: true });
  assert.deepEqual(periodRange('amanha', p, NOW), { from: FRI, to: FRI, single: true });
  assert.deepEqual(periodRange('sabado', p, NOW), { from: '2026-10-10', to: '2026-10-10', single: true });
  assert.deepEqual(periodRange('7d', p, NOW), { from: '2026-10-02', to: THU, single: false });
  assert.deepEqual(periodRange('mes', p, NOW), { from: '2026-10-01', to: '2026-10-31', single: false });
  assert.deepEqual(periodRange('custom', new URLSearchParams('from=2026-10-12&to=2026-10-09'), NOW), { from: FRI, to: '2026-10-12', single: false });
  // 21h de quinta em Manaus = 01h de sexta em UTC: "hoje" continua sendo quinta
  assert.equal(periodRange('hoje', p, new Date('2026-10-09T01:00:00Z')).from, THU);
});

test('Indicadores: status mutuamente exclusivos, sem contar o mesmo agendamento duas vezes', async () => {
  const r = await call('GET', '/api/admin/appointments/overview?period=amanha');
  assert.equal(r.status, 200);
  const c = r.data.counts;
  const { rows } = await q('SELECT status, count(*)::int AS n FROM appointments WHERE date = $1 GROUP BY status', [FRI]);
  const db = Object.fromEntries(rows.map((x) => [x.status, x.n]));
  assert.equal(c.confirmados, db.CONFIRMADO);
  assert.equal(c.aguardando, (db.NOVO || 0) + (db.CONTATADO || 0), 'aguardando = agendado (NOVO) + contatado, ainda sem confirmação');
  assert.equal(c.compareceram, db.COMPARECEU);
  assert.equal(c.nao_compareceram, db.NAO_COMPARECEU);
  assert.equal(c.cancelados, db.CANCELADO);
  assert.deepEqual([c.total, c.confirmados, c.aguardando, c.compareceram, c.nao_compareceram, c.cancelados], [5, 1, 2, 1, 1, 1]);
  assert.equal(c.total + c.cancelados, Object.values(db).reduce((a, b) => a + b, 0), 'total + cancelados = todos os registros');
});

test('Vagas restantes: vagas reais da agenda (bate com o cálculo da agenda)', async () => {
  const fri = await call('GET', '/api/admin/appointments/overview?period=amanha');
  assert.equal(fri.data.remaining, (await dayAvailability(FRI)).remaining);
  assert.equal(fri.data.remaining, 6 * 3 - 5, '6 horários × 3 vagas − 5 ativos (cancelado libera a vaga)');
  // Hoje às 10h: só horários que ainda não começaram (10:00 a 11:30 → 4 × 3)
  const thu = await call('GET', '/api/admin/appointments/overview?period=hoje');
  assert.equal(thu.data.remaining, 12);
  // Período já encerrado: sem vagas a oferecer
  const past = await call('GET', '/api/admin/appointments/overview?period=custom&from=2026-10-01&to=2026-10-03');
  assert.equal(past.data.remainingDays, 0);
});

test('Horários mais procurados: agrupamento real, destaque do maior, cancelados fora', async () => {
  const r = await call('GET', '/api/admin/appointments/overview?period=amanha');
  const by = Object.fromEntries(r.data.hours.map((h) => [h.time, h.n]));
  assert.equal(by['11:00'], 3);
  assert.equal(by['10:00'], 2);
  assert.equal(by['09:30'], 0, 'o único agendamento das 09:30 foi cancelado');
  assert.equal(by['09:00'], 0, 'horários sem procura também aparecem');
  assert.deepEqual(r.data.top, { time: '11:00', n: 3 });
  const empty = await call('GET', '/api/admin/appointments/overview?period=hoje');
  assert.equal(empty.data.top, null);
});

test('Evolução: agendamentos realizados por dia (7, 15, 30 dias e personalizado)', async () => {
  for (const [evo, len] of [[7, 7], [15, 15], [30, 30]]) {
    const r = await call('GET', `/api/admin/appointments/overview?period=hoje&evo=${evo}`);
    assert.equal(r.data.evolution.days.length, len);
  }
  const r = await call('GET', '/api/admin/appointments/overview?period=hoje&evo=7');
  const total = r.data.evolution.days.reduce((a, d) => a + d.n, 0);
  const { rows } = await q("SELECT count(*)::int AS n FROM appointments WHERE status <> 'CANCELADO' AND (created_at AT TIME ZONE 'America/Manaus')::date BETWEEN $1 AND $2", [r.data.evolution.from, r.data.evolution.to]);
  assert.equal(total, rows[0].n);
  const c = await call('GET', '/api/admin/appointments/overview?period=hoje&evo=custom&evo_from=2026-09-01&evo_to=2026-09-10');
  assert.equal(c.data.evolution.days.length, 10);
});

test('Lista: ordem de atendimento, busca e filtros (status, horário, origem, campanha)', async () => {
  const list = async (qs) => (await call('GET', '/api/admin/appointments?period=amanha&sort=chrono&' + qs)).data;
  const all = await list('');
  assert.equal(all.total, 6);
  assert.deepEqual(all.items.map((i) => i.time), ['09:30', '10:00', '10:00', '11:00', '11:00', '11:00']);
  assert.equal((await list('status=AGUARDANDO')).total, 2);
  assert.equal((await list('status=CONFIRMADO')).total, 1);
  assert.equal((await list('time=10:00')).total, 2);
  assert.equal((await list('origin=meta')).total, 2);
  assert.equal((await list('origin=outros')).total, 4);
  assert.equal((await list('campaign=' + encodeURIComponent('Exame Gratis Manaus'))).total, 2);
  assert.equal((await list('q=Mariana')).items[0].name, 'Mariana Conceição');
  const proto = all.items[0].protocol;
  assert.equal((await list('q=' + proto)).total, 1);
  const csv = await call('GET', '/api/admin/appointments.csv?period=amanha&origin=meta');
  assert.equal(csv.status, 200);
  assert.equal(csv.data.trim().split('\n').length, 3, 'cabeçalho + 2 agendamentos filtrados');
});

test('Ações: confirmar, comparecimento, cancelar (libera vaga) — registradas na auditoria', async () => {
  const before = (await call('GET', '/api/admin/appointments/overview?period=amanha')).data;
  assert.equal((await call('PATCH', `/api/admin/appointments/${ids.c}`, { body: { status: 'CONFIRMADO' } })).status, 200);
  assert.equal((await call('PATCH', `/api/admin/appointments/${ids.c}`, { body: { status: 'COMPARECEU' } })).status, 200);
  assert.equal((await call('PATCH', `/api/admin/appointments/${ids.b}`, { body: { status: 'CANCELADO' } })).status, 200);
  const after = (await call('GET', '/api/admin/appointments/overview?period=amanha')).data;
  assert.equal(after.counts.aguardando, before.counts.aguardando - 2);
  assert.equal(after.counts.compareceram, before.counts.compareceram + 1);
  assert.equal(after.counts.cancelados, before.counts.cancelados + 1);
  assert.equal(after.remaining, before.remaining + 1, 'cancelamento libera a vaga');
  const { rows } = await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'status' AND entity_id IN ($1, $2)", [String(ids.b), String(ids.c)]);
  assert.equal(rows[0].n, 3);
});

test('Ao vivo: novo agendamento avisa o painel aberto (Server-Sent Events), sem dados de paciente', async () => {
  const ac = new AbortController();
  const res = await fetch(base + '/api/admin/stream', { headers: { cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const waitFor = async (re, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(buf)) return true;
      const r = await Promise.race([reader.read(), new Promise((ok) => setTimeout(() => ok({ timeout: true }), 500))]);
      if (r.value) buf += dec.decode(r.value);
    }
    return re.test(buf);
  };
  assert.ok(await waitFor(/conectado/));
  await new Promise((r) => setTimeout(r, 300)); // LISTEN ativo
  await createBooking(person({ date: FRI, time: '09:00', name: 'Teste Ao Vivo' }), { now: NOW });
  assert.ok(await waitFor(/event: appointments/), 'aviso recebido');
  assert.doesNotMatch(buf, /Teste Ao Vivo|929/, 'o aviso não carrega dados do paciente');
  ac.abort();
  // Sem login: nada
  assert.equal((await fetch(base + '/api/admin/stream')).status, 401);
});

test('Sem login: indicadores bloqueados', async () => {
  assert.equal((await call('GET', '/api/admin/appointments/overview?period=hoje', { ck: null })).status, 401);
});
