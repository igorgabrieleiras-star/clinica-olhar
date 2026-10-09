// Verificação pós-publicação contra os ENDEREÇOS REAIS (executada como serviço temporário no Railway).
// Usa registros de teste identificados ("Teste Automatizado") e remove tudo ao final, restaurando as configurações.
// Variáveis: SITE_URL, PANEL_URL, ADMIN_GATE_USER, ADMIN_GATE_PASSWORD, DATABASE_URL (dono do banco).
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { q, pool } from '../src/db.js';
import { createAdmin } from '../src/auth.js';
import { publicCandidateDates } from '../src/dates.js';

// Mantém o healthcheck da plataforma satisfeito enquanto o roteiro roda.
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(Number(process.env.PORT || 3000));

const SITE = process.env.SITE_URL.replace(/\/$/, '');
const PANEL = process.env.PANEL_URL.replace(/\/$/, '');
const GATE = 'Basic ' + Buffer.from(`${process.env.ADMIN_GATE_USER}:${process.env.ADMIN_GATE_PASSWORD}`).toString('base64');
const TEST_EMAIL = 'teste-automatizado@clinicaolhar.invalid';
const TEST_PHONE = '92999990001';
const TEST_NAME = 'Teste Automatizado';

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

let cookie = '';
async function call(base, method, path, { body, gate = base === PANEL, auth = true, headers = {}, redirect = 'manual' } = {}) {
  const h = { accept: 'application/json', 'x-olhar-csrf': '1', ...headers };
  if (gate) h.authorization = GATE;
  if (auth && cookie && base === PANEL) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect });
  const sc = res.headers.get('set-cookie');
  if (sc && base === PANEL) cookie = sc.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

const testDate = publicCandidateDates(new Date())[0].date;
let originalBooking = null;
let overrideExisted = false;

try {
  console.log(`[smoke] site=${SITE} painel=${PANEL} data de teste=${testDate}`);

  // ---------- 1. Site público ----------
  const home = await call(SITE, 'GET', '/');
  check('Site: página abre (200)', home.status === 200, String(home.status));
  check('Site: oferta "100% grátis" e formulário presentes', /100%/.test(home.data) && /Como podemos te chamar\?/.test(home.data));
  check('Site: título SEO', /<title>Exame de Vista Grátis \| Clínica Olhar<\/title>/.test(home.data));
  check('Site: nenhum link de login/painel', !/\/admin|login|painel/i.test(home.data));
  check('Site: HTTPS forçado (HSTS)', /max-age=31536000/.test(home.headers.get('strict-transport-security') || ''));
  check('Site: CSP restritiva', /default-src 'self'/.test(home.headers.get('content-security-policy') || ''));
  for (const p of ['/admin', '/api/admin/me', '/assets/admin.js']) {
    const r = await call(SITE, 'GET', p, { gate: false });
    check(`Site: ${p} não existe`, r.status === 404, String(r.status));
  }
  const loginOnSite = await call(SITE, 'POST', '/api/admin/login', { body: { email: 'x@x.com', password: 'x' } });
  check('Site: login administrativo inexistente', loginOnSite.status === 404, String(loginOnSite.status));
  const mobile = await call(SITE, 'GET', '/', { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 350.0' } });
  check('Celular (Instagram/iPhone): página abre com viewport móvel', mobile.status === 200 && /name="viewport" content="width=device-width/.test(mobile.data));
  for (const a of (home.data.match(/\/assets\/site\.(css|js)\?v=[a-f0-9]+/g) || [])) {
    const r = await fetch(SITE + a);
    check(`Site: recurso ${a.split('?')[0]} carrega`, r.status === 200, String(r.status));
  }

  // ---------- 2. Proteção do painel ----------
  const noGate = await call(PANEL, 'GET', '/', { gate: false });
  check('Painel: sem a senha de acesso → 401', noGate.status === 401, String(noGate.status));
  const badGate = await call(PANEL, 'GET', '/', { gate: false, headers: { authorization: 'Basic ' + Buffer.from('clinicaolhar:errada').toString('base64') } });
  check('Painel: senha de acesso errada → 401', badGate.status === 401, String(badGate.status));
  const panelHome = await call(PANEL, 'GET', '/');
  check('Painel: com a senha de acesso → tela de login (200)', panelHome.status === 200 && /Painel \| Clínica Olhar/.test(panelHome.data), String(panelHome.status));
  check('Painel: não indexável', /noindex/.test(panelHome.headers.get('x-robots-tag') || ''));
  const apiNoLogin = await call(PANEL, 'GET', '/api/admin/appointments', { auth: false });
  check('Painel: dados exigem login (401)', apiNoLogin.status === 401, String(apiNoLogin.status));
  const wrongLogin = await call(PANEL, 'POST', '/api/admin/login', { body: { email: TEST_EMAIL, password: 'senha-errada-123' } });
  check('Painel: login com senha errada recusado', wrongLogin.status === 401, String(wrongLogin.status));
  const bookOnPanel = await call(PANEL, 'POST', '/api/bookings', { body: {} });
  check('Painel: não aceita agendamentos públicos (404)', bookOnPanel.status === 404, String(bookOnPanel.status));

  // ---------- 3. Banco: usuário restrito do site ----------
  const { rows: [priv] } = await q(`SELECT has_table_privilege('olhar_site','admins','SELECT') AS admins,
                                           has_table_privilege('olhar_site','appointments','DELETE') AS del,
                                           has_any_column_privilege('olhar_site','appointments','INSERT') AS ins`);
  check('Banco: site não lê administradores nem apaga agendamentos; pode criar agendamentos', !priv.admins && !priv.del && priv.ins);
  const { rows: st } = await q(`SELECT updated_at FROM service_status WHERE service = 'public'`);
  check('Banco: site público conectado e registrado', st.length === 1);

  // ---------- 4. Preparação temporária (admin de teste + 1 horário de teste) ----------
  const tmpPassword = 'Tmp' + randomBytes(12).toString('hex') + '9';
  await createAdmin({ email: TEST_EMAIL, name: 'Teste Automatizado', password: tmpPassword, mustChange: false });
  const login = await call(PANEL, 'POST', '/api/admin/login', { body: { email: TEST_EMAIL, password: tmpPassword } });
  check('Painel: login administrativo', login.status === 200, String(login.status));

  const settings = (await call(PANEL, 'GET', '/api/admin/settings')).data.settings;
  originalBooking = settings.booking;
  overrideExisted = (await q('SELECT 1 FROM date_overrides WHERE date = $1', [testDate])).rows.length > 0;
  if (overrideExisted) throw new Error('A data de teste já tem uma exceção configurada; teste interrompido para não alterar dados reais.');
  const ov = await call(PANEL, 'PUT', `/api/admin/date-overrides/${testDate}`, { body: { open_time: '06:00', close_time: '06:30', interval_minutes: 30, capacity: 2, reason: 'TESTE AUTOMATIZADO' } });
  check('Painel: horário de teste criado (06:00, 2 vagas)', ov.status === 200, String(ov.status));
  const open = await call(PANEL, 'PUT', '/api/admin/settings/booking', { body: { ...originalBooking, enabled: true } });
  check('Painel: agendamentos abertos temporariamente', open.status === 200, String(open.status));

  // ---------- 5. Fluxo do paciente no site ----------
  await new Promise((r) => setTimeout(r, 1500)); // aviso LISTEN/NOTIFY chega ao site
  const remainingOn = (a) => a.dates.find((x) => x.date === testDate)?.remaining ?? 0;
  let av = (await call(SITE, 'GET', '/api/availability')).data;
  const d = av.dates.find((x) => x.date === testDate);
  check('Site: data de teste oferecida (amanhã/sábado)', !!d && d.available, JSON.stringify(av.dates.map((x) => [x.date, x.kind, x.remaining])));
  check('Site: vagas da data de teste = 2 (reais, do banco)', remainingOn(av) === 2, String(remainingOn(av)));
  check('Site: horário 06:00 disponível', !!d?.times.find((t) => t.time === '06:00' && t.available));
  const page = await call(SITE, 'GET', '/');
  check('Site: selo do topo mostra o total real de vagas', new RegExp(`Restam <b>${av.total}</b> vaga`).test(page.data), `total=${av.total}`);

  const bookingBody = {
    name: TEST_NAME, age: 30, whatsapp: '(92) 99999-0001', date: testDate, time: '06:00',
    consent_data: true, consent_marketing: false, consent_social: false, ads_consent: false, elapsed_ms: 12000, website: '',
    idempotency_key: randomUUID(),
    attribution: { utm_source: 'teste', utm_medium: 'verificacao', utm_campaign: 'TESTE AUTOMATIZADO', landing_page: SITE + '/?utm_source=teste' },
  };
  const invalid = await call(SITE, 'POST', '/api/bookings', { body: { ...bookingBody, whatsapp: '123', idempotency_key: randomUUID() } });
  check('Site: WhatsApp inválido recusado pelo servidor', invalid.status === 422, String(invalid.status));
  const wrongDate = await call(SITE, 'POST', '/api/bookings', { body: { ...bookingBody, date: '2030-01-01', idempotency_key: randomUUID() } });
  check('Site: data fora da regra recusada pelo servidor', wrongDate.status === 422, String(wrongDate.status));
  const b = await call(SITE, 'POST', '/api/bookings', { body: bookingBody });
  check('Site: agendamento confirmado (201) com protocolo', b.status === 201 && /^OLH-\d{6}$/.test(b.data.booking?.protocol || ''), `${b.status} ${b.data.booking?.protocol || JSON.stringify(b.data)}`);
  const protocol = b.data.booking?.protocol;
  check('Site: confirmação com dados do paciente', b.data.booking?.name === TEST_NAME && b.data.booking?.time === '06:00' && b.data.booking?.whatsapp === '(92) 99999-0001');
  const replay = await call(SITE, 'POST', '/api/bookings', { body: bookingBody });
  check('Site: reenvio não duplica', replay.status === 200 && replay.data.booking?.protocol === protocol);

  const { rows: saved } = await q(`SELECT a.status, p.name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.protocol = $1`, [protocol]);
  check('Banco: agendamento gravado', saved.length === 1 && saved[0].name === TEST_NAME);
  av = (await call(SITE, 'GET', '/api/availability')).data;
  check('Site: vagas atualizadas (2 → 1)', remainingOn(av) === 1, String(remainingOn(av)));

  // ---------- 6. Painel enxerga o agendamento ----------
  const list = await call(PANEL, 'GET', '/api/admin/appointments?q=' + encodeURIComponent(protocol));
  const row = list.data.items?.[0];
  check('Painel: agendamento aparece na lista', row?.protocol === protocol && row?.name === TEST_NAME);
  check('Painel: origem do anúncio registrada', JSON.stringify(row || {}).includes('TESTE AUTOMATIZADO'));
  const ag = await call(PANEL, 'GET', `/api/admin/agenda?date=${testDate}`);
  const slot = ag.data.slots?.find((s) => s.time === '06:00');
  check('Painel: agenda mostra 1/2 vagas ocupadas', slot?.booked === 1 && slot?.capacity === 2 && slot.patients.length === 1);
  const dash = await call(PANEL, 'GET', '/api/admin/dashboard');
  check('Painel: dashboard responde', dash.status === 200 && typeof dash.data.counts?.total === 'number');

  // ---------- 7. Atualização de vagas pelo painel ----------
  await call(PANEL, 'PATCH', `/api/admin/slots/${slot.id}`, { body: { blocked: true } });
  av = (await call(SITE, 'GET', '/api/availability')).data;
  check('Painel → site: horário bloqueado some do site (vagas = 0)', remainingOn(av) === 0, String(remainingOn(av)));
  const blockedTry = await call(SITE, 'POST', '/api/bookings', { body: { ...bookingBody, name: 'Teste Automatizado Dois', whatsapp: '(92) 99999-0002', idempotency_key: randomUUID() } });
  check('Site: reserva em horário bloqueado recusada', blockedTry.status >= 400, String(blockedTry.status));
  await call(PANEL, 'PATCH', `/api/admin/slots/${slot.id}`, { body: { blocked: false, capacity: 3 } });
  av = (await call(SITE, 'GET', '/api/availability')).data;
  check('Painel → site: capacidade alterada para 3 (vagas = 2)', remainingOn(av) === 2, String(remainingOn(av)));
  const cancel = await call(PANEL, 'PATCH', `/api/admin/appointments/${row.id}`, { body: { status: 'CANCELADO' } });
  av = (await call(SITE, 'GET', '/api/availability')).data;
  check('Painel: cancelamento libera a vaga (vagas = 3)', cancel.status === 200 && remainingOn(av) === 3, String(remainingOn(av)));
} catch (err) {
  check('Execução do roteiro', false, err.stack || String(err));
} finally {
  // ---------- 8. Limpeza ----------
  try {
    if (originalBooking) await call(PANEL, 'PUT', '/api/admin/settings/booking', { body: originalBooking });
    if (!overrideExisted) {
      await q('DELETE FROM date_overrides WHERE date = $1', [testDate]);
    }
    const { rows: pats } = await q('SELECT id FROM patients WHERE whatsapp IN ($1, $2)', [TEST_PHONE, '92999990002']);
    const ids = pats.map((p) => p.id);
    if (ids.length) {
      await q('DELETE FROM appointments WHERE patient_id = ANY($1)', [ids]); // consentimentos, atribuição e eventos caem em cascata
      await q('DELETE FROM patients WHERE id = ANY($1)', [ids]);
    }
    if (!overrideExisted) await q(`DELETE FROM slots s WHERE s.date = $1 AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id)`, [testDate]);
    if (cookie) await call(PANEL, 'POST', '/api/admin/logout');
    await q('DELETE FROM admins WHERE email = $1', [TEST_EMAIL]); // sessões caem em cascata; auditoria é mantida
    const { rows: [left] } = await q(`SELECT (SELECT count(*) FROM patients WHERE whatsapp IN ($1,$2)) AS p,
                                             (SELECT count(*) FROM admins WHERE email = $3) AS a,
                                             (SELECT count(*) FROM date_overrides WHERE date = $4) AS o,
                                             (SELECT count(*) FROM slots WHERE date = $4) AS s`, [TEST_PHONE, '92999990002', TEST_EMAIL, testDate]);
    const after = (await call(SITE, 'GET', '/api/availability')).data;
    check('Limpeza: nenhum registro de teste restante', left.p === 0 && left.a === 0 && left.o === 0 && left.s === 0, JSON.stringify(left));
    check('Limpeza: configurações restauradas (agendamentos como estavam)', after.enabled === !!originalBooking?.enabled, `enabled=${after.enabled}`);
  } catch (err) {
    check('Limpeza', false, err.stack || String(err));
  }
  const ok = results.filter(Boolean).length;
  console.log(`\n[smoke] RESULTADO: ${ok}/${results.length} verificações passaram`);
  await pool.end().catch(() => {});
  // Fica ocioso para os logs permanecerem disponíveis até o serviço temporário ser removido.
}
