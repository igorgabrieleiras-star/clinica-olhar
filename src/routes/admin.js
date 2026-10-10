import { q, tx } from '../db.js';
import { now, config } from '../config.js';
import { getSettings, saveSection, DEFAULTS } from '../settings.js';
import { dayAvailability, publicAvailability, syncDate, syncUpcoming, effectiveRule } from '../availability.js';
import { setStatus, rescheduleAppointment } from '../booking.js';
import { subscribeAppointments } from '../live.js';
import { publicRules, optionsFor } from '../availability.js';
import { nowTimeHM } from '../dates.js';
import { login, logout, sessionAdmin, changePassword, SESSION_COOKIE, SESSION_HOURS } from '../auth.js';
import { todayISO, addDays, publicCandidateDates, isISODate, formatLongDate, timeToMinutes } from '../dates.js';
import { cleanName, cleanAge, cleanWhatsapp, cleanTime, ValidationError, formatWhatsapp } from '../validate.js';
import { json, readJson, parseCookies, setCookie, clientIp, rateLimit, HttpError, send } from '../http.js';
import {
  ROLES, listAdmins, createInvite, resendInvite, revokeInvite, inviteInfo, acceptInvite, updateAdmin, removeAdmin,
  cleanEmail, cleanAdminName, integrationStatus, setupIntegrationPassword, checkIntegrationPassword, unlockSession,
  touchUnlock, lockSession, revokeIntegrationSessions, changeIntegrationPassword, resetIntegrationPassword, INVITE_HOURS,
} from '../admins.js';

const STATUSES = ['NOVO', 'CONFIRMADO', 'CONTATADO', 'COMPARECEU', 'NAO_COMPARECEU', 'CANCELADO'];

async function audit(adminId, action, entity, entityId, details) {
  await q('INSERT INTO audit_log (admin_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)', [
    adminId, action, entity, entityId === undefined ? null : String(entityId), details ? JSON.stringify(details) : null,
  ]);
}

/** Bloqueia requisições de outros sites: cabeçalho anti-CSRF obrigatório e origem própria. */
function checkCsrf(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-olhar-csrf'] !== '1') throw new HttpError(403, 'Requisição bloqueada.', 'CSRF');
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origem não permitida.', 'CSRF');
}

/**
 * Exige sessão válida (conta ativa). Toda autorização é decidida aqui, no servidor, a cada requisição.
 * principal: true → somente o administrador principal (administradores comuns recebem 403).
 */
async function requireAdmin(req, { allowPasswordChange = false, principal = false } = {}) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const admin = await sessionAdmin(token);
  if (!admin) throw new HttpError(401, 'Sua sessão expirou. Entre novamente.', 'UNAUTHENTICATED');
  checkCsrf(req);
  if (admin.mustChangePassword && !allowPasswordChange) throw new HttpError(403, 'Troque a senha inicial para continuar.', 'MUST_CHANGE_PASSWORD');
  if (principal && admin.role !== 'principal') throw new HttpError(403, 'Acesso negado. Esta área é exclusiva do administrador principal.', 'FORBIDDEN');
  admin.token = token;
  return admin;
}

/** Área de Integrações: administrador principal + senha exclusiva desbloqueada nesta sessão (expira após 10 min sem uso). */
async function requireIntegrations(req) {
  const admin = await requireAdmin(req, { principal: true });
  const st = await integrationStatus(admin);
  if (!st.configured) throw new HttpError(423, 'Crie a senha de Integrações para continuar.', 'INTEGRATIONS_SETUP');
  if (!(await touchUnlock(admin.sessionId))) throw new HttpError(423, 'Área protegida. Confirme sua senha de Integrações.', 'INTEGRATIONS_LOCKED');
  return admin;
}

/** Identificador numérico da URL; inválido → 404 (nunca chega ao banco). */
function idParam(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, 'Registro não encontrado.', 'NOT_FOUND');
  return n;
}

function meView(a) {
  return { id: a.id, email: a.email, name: a.name, role: a.role, roleLabel: ROLES[a.role], principal: a.role === 'principal', mustChangePassword: a.mustChangePassword };
}

function intOrNull(v, min, max, field) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(field, `Valor inválido em ${field}.`);
  return n;
}

function timeOrNull(v, field) {
  if (v === null || v === undefined || v === '') return null;
  try { return cleanTime(v); } catch { throw new ValidationError(field, 'Horário inválido.'); }
}

function validateHours(r, prefix = '') {
  if (r.open_time && r.close_time && timeToMinutes(r.close_time) <= timeToMinutes(r.open_time)) {
    throw new ValidationError(prefix + 'close_time', 'O encerramento precisa ser depois da abertura.');
  }
  if ((r.lunch_start === null) !== (r.lunch_end === null)) throw new ValidationError(prefix + 'lunch', 'Informe início e fim da pausa.');
  if (r.lunch_start && timeToMinutes(r.lunch_end) <= timeToMinutes(r.lunch_start)) throw new ValidationError(prefix + 'lunch', 'O fim da pausa precisa ser depois do início.');
}

// ---------- Período (sempre pela data do exame, no fuso de Manaus) ----------
/**
 * Converte o período escolhido no painel em um intervalo de datas do exame.
 *   hoje · amanha · sabado (o próximo sábado oferecido no site) · 7d (hoje e os 6 dias anteriores)
 *   mes (do dia 1 ao último dia do mês atual) · custom (de/até, no máximo 366 dias) · '' (todos)
 */
export function periodRange(period, params, n = now()) {
  const today = todayISO(n);
  if (period === 'hoje') return { from: today, to: today, single: true };
  if (period === 'amanha') { const d = addDays(today, 1); return { from: d, to: d, single: true }; }
  if (period === 'sabado') { const d = publicCandidateDates(n).find((c) => c.kinds.includes('sabado')).date; return { from: d, to: d, single: true }; }
  if (period === '7d') return { from: addDays(today, -6), to: today, single: false };
  if (period === 'mes') {
    const first = today.slice(0, 8) + '01';
    const [y, m] = today.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from: first, to: last, single: false };
  }
  if (period === 'custom') {
    let from = params.get('from'); let to = params.get('to');
    if (!isISODate(from || '')) from = null;
    if (!isISODate(to || '')) to = null;
    if (!from && !to) return null;
    from ||= to; to ||= from;
    if (from > to) [from, to] = [to, from];
    if (addDays(from, 366) < to) to = addDays(from, 366);
    return { from, to, single: from === to };
  }
  return null;
}

// ---------- Filtros da lista de agendamentos ----------
const ORIGIN_SQL = {
  // Origem do agendamento: anúncios da Meta (UTM ou clique de anúncio), cadastro manual ou demais origens.
  meta: "(t.fbclid IS NOT NULL OR lower(coalesce(t.utm_source,'')) ~ '(facebook|fb|instagram|ig|meta)')",
  manual: "a.origin = 'admin'",
  outros: "(a.origin <> 'admin' AND t.fbclid IS NULL AND lower(coalesce(t.utm_source,'')) !~ '(facebook|fb|instagram|ig|meta)')",
};
function buildFilters(params) {
  const where = [];
  const values = [];
  const add = (sql, v) => { values.push(v); where.push(sql.replace('?', '$' + values.length)); };
  const period = params.get('period') || '';
  const field = params.get('field') === 'criacao' ? 'criacao' : 'exame';
  const createdDay = "(a.created_at AT TIME ZONE 'America/Manaus')::date";
  const range = periodRange(period, params);
  if (range) {
    const col = field === 'criacao' ? createdDay : 'a.date';
    add(`${col} >= ?`, range.from);
    add(`${col} <= ?`, range.to);
  }
  const status = params.get('status');
  if (status === 'AGUARDANDO') where.push("a.status IN ('NOVO','CONTATADO')");
  else if (status && STATUSES.includes(status)) add('a.status = ?', status);
  const time = params.get('time');
  if (time && /^\d{2}:\d{2}$/.test(time)) add('a.time = ?', time);
  const origin = params.get('origin');
  if (ORIGIN_SQL[origin]) where.push(ORIGIN_SQL[origin]);
  const campaign = (params.get('campaign') || '').trim().slice(0, 200);
  if (campaign) add('t.utm_campaign = ?', campaign);
  const term = (params.get('q') || '').trim().slice(0, 80);
  if (term) {
    const digits = term.replace(/\D/g, '');
    values.push('%' + term.replace(/[%_\\]/g, (c) => '\\' + c) + '%');
    const i = values.length;
    let cond = `(p.name ILIKE $${i} OR a.protocol ILIKE $${i}`;
    if (digits.length >= 4) { values.push('%' + digits + '%'); cond += ` OR p.whatsapp LIKE $${values.length}`; }
    where.push(cond + ')');
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', values };
}

const LIST_SQL = `
  SELECT a.id, a.protocol, a.date, a.time, a.status, a.origin, a.notes,
         to_char(a.created_at AT TIME ZONE 'America/Manaus', 'YYYY-MM-DD HH24:MI') AS created,
         p.id AS patient_id, p.name, p.age, p.whatsapp, p.guardian_name, p.anonymized_at IS NOT NULL AS anonymized,
         t.utm_source, t.utm_medium, t.utm_campaign, t.utm_content, t.utm_term, t.fbclid, t.referrer
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN attributions t ON t.appointment_id = a.id`;

/** Origem legível do agendamento, sem inventar quando não há dados. */
export function describeOrigin(r) {
  if (r.origin === 'admin') return 'Cadastro manual';
  const src = (r.utm_source || '').toLowerCase();
  const isMeta = /facebook|fb|instagram|ig|meta/.test(src) || !!r.fbclid;
  if (r.utm_source || r.utm_campaign) {
    const name = isMeta ? (/instagram|ig/.test(src) ? 'Instagram Ads' : 'Facebook/Instagram Ads') : r.utm_source;
    return name + (r.utm_medium ? ` (${r.utm_medium})` : '');
  }
  if (r.fbclid) return 'Facebook/Instagram (clique em anúncio)';
  if (r.referrer) {
    try { return 'Indicação: ' + new URL(r.referrer).hostname; } catch { /* ignora */ }
  }
  return 'Não identificada';
}

function rowView(r) {
  return {
    id: r.id, protocol: r.protocol, date: r.date, dateLabel: formatLongDate(r.date), time: r.time, status: r.status,
    created: r.created, notes: r.notes, patientId: r.patient_id, name: r.name, age: r.age, whatsapp: r.whatsapp,
    whatsappLabel: formatWhatsapp(r.whatsapp), guardian: r.guardian_name, anonymized: r.anonymized,
    origin: describeOrigin(r),
    attribution: { source: r.utm_source, medium: r.utm_medium, campaign: r.utm_campaign, content: r.utm_content, term: r.utm_term, referrer: r.referrer, fbclid: !!r.fbclid },
  };
}

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita injeção de fórmulas no Excel
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------- Saneamento das configurações ----------
function sanitizeSection(key, input) {
  const d = DEFAULTS[key];
  const i = input || {};
  const str = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const bool = (v) => v === true;
  switch (key) {
    case 'clinic': {
      let whatsapp = '';
      if (str(i.whatsapp)) whatsapp = cleanWhatsapp(i.whatsapp);
      const maps = str(i.maps_url, 500);
      if (maps && !/^https:\/\//.test(maps)) throw new ValidationError('maps_url', 'O link do mapa precisa começar com https://');
      return { name: str(i.name, 80) || d.name, whatsapp, address: str(i.address, 300), maps_url: maps, opening_hours_text: str(i.opening_hours_text, 200) };
    }
    case 'booking': {
      const minor = ['guardian_required', 'allowed', 'blocked'].includes(i.minor_rule) ? i.minor_rule : d.minor_rule;
      const min = intOrNull(i.min_age, 0, 120, 'min_age');
      const max = intOrNull(i.max_age, 0, 120, 'max_age');
      if (min !== null && max !== null && max < min) throw new ValidationError('max_age', 'A idade máxima precisa ser maior que a mínima.');
      return {
        enabled: bool(i.enabled),
        today_enabled: i.today_enabled === undefined ? d.today_enabled : bool(i.today_enabled),
        tomorrow_enabled: i.tomorrow_enabled === undefined ? d.tomorrow_enabled : bool(i.tomorrow_enabled),
        saturday_enabled: i.saturday_enabled === undefined ? d.saturday_enabled : bool(i.saturday_enabled),
        min_lead_minutes: i.min_lead_minutes === undefined ? d.min_lead_minutes : (intOrNull(i.min_lead_minutes, 0, 1440, 'min_lead_minutes') ?? 0),
        same_day_cap: i.same_day_cap === undefined ? d.same_day_cap : intOrNull(i.same_day_cap, 1, 500, 'same_day_cap'),
        waitlist_enabled: bool(i.waitlist_enabled),
        scarcity_threshold: intOrNull(i.scarcity_threshold, 0, 10000, 'scarcity_threshold') ?? 0,
        min_age: min,
        max_age: max,
        minor_rule: minor,
      };
    }
    case 'social_proof':
      return { enabled: bool(i.enabled), institutional: i.institutional === undefined ? d.institutional : bool(i.institutional), max_age_hours: intOrNull(i.max_age_hours, 1, 168, 'max_age_hours') ?? 48 };
    case 'meta': {
      const pixel = str(i.pixel_id, 30);
      if (pixel && !/^\d{6,20}$/.test(pixel)) throw new ValidationError('pixel_id', 'O ID do Pixel tem apenas números.');
      return { pixel_enabled: bool(i.pixel_enabled), pixel_id: pixel, capi_enabled: bool(i.capi_enabled), require_consent: i.require_consent !== false, schedule_event: bool(i.schedule_event) };
    }
    case 'privacy':
      return { retention_days: intOrNull(i.retention_days, 30, 3650, 'retention_days') ?? 365 };
    case 'content': {
      const paragraphs = Array.isArray(i.vision_paragraphs) ? i.vision_paragraphs.map((p) => str(p, 900)).filter(Boolean).slice(0, 6) : d.vision_paragraphs;
      return { vision_title: str(i.vision_title, 120) || d.vision_title, vision_paragraphs: paragraphs };
    }
    default:
      throw new HttpError(404, 'Seção desconhecida.', 'NOT_FOUND');
  }
}

/** Estado do site público (token da API de Conversões etc.). Em desenvolvimento (um só processo), usa a própria configuração. */
async function siteStatus() {
  if (config.role === 'all') {
    return { capiTokenConfigured: !!config.metaCapiToken, testEventCode: !!config.metaTestEventCode, appUrl: config.appUrl, seenAt: null, separate: false };
  }
  const { rows } = await q(`SELECT info, to_char(updated_at AT TIME ZONE 'America/Manaus', 'DD/MM/YYYY HH24:MI') AS at FROM service_status WHERE service = 'public'`);
  const info = rows[0]?.info || {};
  return { capiTokenConfigured: !!info.capiTokenConfigured, testEventCode: !!info.testEventCode, appUrl: info.appUrl || config.publicSiteUrl, seenAt: rows[0]?.at || null, separate: true };
}

export function registerAdmin(router) {
  // ----- Autenticação -----
  router.post('/api/admin/login', async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimit('login:' + ip, 10, 15 * 60 * 1000).ok) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    const result = await login(body.email, body.password);
    if (!result.ok) {
      await audit(null, 'login_failed', 'admin', null, { ip });
      const msg = result.reason === 'locked' ? 'Acesso bloqueado temporariamente após várias tentativas. Tente em 15 minutos.' : 'E-mail ou senha incorretos.';
      throw new HttpError(401, msg, 'LOGIN_FAILED');
    }
    await audit(result.admin.id, 'login', 'admin', result.admin.id);
    json(req, res, 200, { ok: true, admin: meView(result.admin) }, {
      'set-cookie': setCookie(SESSION_COOKIE, result.token, { maxAge: SESSION_HOURS * 3600 }),
    });
  });

  router.post('/api/admin/logout', async (req, res) => {
    await logout(parseCookies(req)[SESSION_COOKIE]);
    json(req, res, 200, { ok: true }, { 'set-cookie': setCookie(SESSION_COOKIE, '', { maxAge: 0 }) });
  });

  router.get('/api/admin/me', async (req, res) => {
    const admin = await requireAdmin(req, { allowPasswordChange: true });
    json(req, res, 200, { admin: meView(admin) });
  });

  // Nome exibido na saudação do painel (cada administrador edita o seu).
  router.patch('/api/admin/me', async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req, 2048);
    const name = cleanAdminName(body.name);
    if (!name) throw new ValidationError('name', 'Informe seu nome (2 a 80 caracteres).');
    await q('UPDATE admins SET name = $2 WHERE id = $1', [admin.id, name]);
    await audit(admin.id, 'profile_name_changed', 'admin', admin.id);
    json(req, res, 200, { ok: true, admin: meView({ ...admin, name }) });
  });

  router.post('/api/admin/password', async (req, res) => {
    const admin = await requireAdmin(req, { allowPasswordChange: true });
    const body = await readJson(req, 4096);
    const r = await changePassword(admin.id, body.current, body.next, admin.token);
    if (!r.ok) throw new HttpError(422, r.error, 'INVALID', 'next');
    await audit(admin.id, 'password_changed', 'admin', admin.id);
    json(req, res, 200, { ok: true });
  });

  // ----- Painel -----
  router.get('/api/admin/dashboard', async (req, res) => {
    await requireAdmin(req);
    const n = now();
    const today = todayISO(n);
    const cands = publicCandidateDates(n);
    const tomorrow = addDays(today, 1);
    const saturday = cands.find((c) => c.kinds.includes('sabado')).date;
    const { rows: [c] } = await q(
      `SELECT count(*) FILTER (WHERE status <> 'CANCELADO') AS total,
              count(*) FILTER (WHERE status <> 'CANCELADO' AND date = $1) AS today,
              count(*) FILTER (WHERE status <> 'CANCELADO' AND date = $2) AS tomorrow,
              count(*) FILTER (WHERE status <> 'CANCELADO' AND date = $3) AS saturday,
              count(*) FILTER (WHERE status = 'COMPARECEU') AS attended,
              count(*) FILTER (WHERE status = 'NAO_COMPARECEU') AS no_show,
              count(*) FILTER (WHERE status = 'CANCELADO') AS cancelled
         FROM appointments`,
      [today, tomorrow, saturday],
    );
    const { rows: series } = await q(
      `SELECT d::date::text AS day, count(a.id) AS n
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN appointments a ON (a.created_at AT TIME ZONE 'America/Manaus')::date = d::date
        GROUP BY d ORDER BY d`,
      [addDays(today, -29), today],
    );
    const { rows: byStatus } = await q(`SELECT status, count(*) AS n FROM appointments GROUP BY status`);
    const { rows: bySource } = await q(
      `SELECT coalesce(nullif(t.utm_campaign, ''), CASE WHEN t.fbclid IS NOT NULL THEN '(anúncio sem UTM)' ELSE '(não identificada)' END) AS campaign,
              count(*) AS n
         FROM appointments a LEFT JOIN attributions t ON t.appointment_id = a.id
        WHERE a.status <> 'CANCELADO' AND a.created_at > now() - interval '30 days'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    );
    const avail = await publicAvailability(n);
    const settings = await getSettings();
    json(req, res, 200, {
      today, tomorrow, saturday, tomorrowIsSaturday: tomorrow === saturday,
      labels: { today: formatLongDate(today), tomorrow: formatLongDate(tomorrow), saturday: formatLongDate(saturday) },
      counts: c, available: avail.total, availability: avail, series, byStatus, bySource,
      setup: {
        bookingEnabled: settings.booking.enabled,
        whatsappConfigured: !!settings.clinic.whatsapp,
        addressConfigured: !!settings.clinic.address,
      },
    });
  });

  // ----- Agendamentos: central de acompanhamento (indicadores, gráficos e resumo) -----
  // Definições (mutuamente exclusivas, pelo status atual de cada agendamento):
  //   aguardando = NOVO ou CONTATADO (paciente agendou; equipe ainda não confirmou)
  //   confirmados = CONFIRMADO · compareceram = COMPARECEU · nao_compareceram = NAO_COMPARECEU · cancelados = CANCELADO
  //   total = todos os agendamentos do período, exceto cancelados (cada agendamento conta uma única vez)
  router.get('/api/admin/appointments/overview', async (req, res) => {
    await requireAdmin(req);
    const params = new URL(req.url, 'http://x').searchParams;
    const n = now();
    const today = todayISO(n);
    const period = params.get('period') || 'hoje';
    const range = periodRange(period, params, n) || periodRange('hoje', params, n);

    const { rows: byStatus } = await q('SELECT status, count(*) AS n FROM appointments WHERE date BETWEEN $1 AND $2 GROUP BY status', [range.from, range.to]);
    const st = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
    const counts = {
      aguardando: (st.NOVO || 0) + (st.CONTATADO || 0),
      confirmados: st.CONFIRMADO || 0,
      compareceram: st.COMPARECEU || 0,
      nao_compareceram: st.NAO_COMPARECEU || 0,
      cancelados: st.CANCELADO || 0,
    };
    counts.total = counts.aguardando + counts.confirmados + counts.compareceram + counts.nao_compareceram;

    // Horários mais procurados: todos os horários da agenda no período (mesmo sem agendamentos) e os agendados.
    const { rows: hours } = await q(
      `SELECT t.time, count(a.id) FILTER (WHERE a.status <> 'CANCELADO') AS n
         FROM (SELECT time FROM slots WHERE date BETWEEN $1 AND $2 UNION SELECT time FROM appointments WHERE date BETWEEN $1 AND $2) t
         LEFT JOIN appointments a ON a.time = t.time AND a.date BETWEEN $1 AND $2
        GROUP BY t.time ORDER BY t.time`,
      [range.from, range.to],
    );
    const top = hours.reduce((best, h) => (h.n > 0 && (!best || h.n > best.n) ? h : best), null);

    // Vagas restantes: horários livres da agenda nas datas do período a partir de hoje
    // (hoje, só horários que ainda não começaram). Datas e horários bloqueados não contam.
    let remaining = 0;
    let remainingDays = 0;
    const start = range.from > today ? range.from : today;
    if (start <= range.to) {
      let d = start;
      for (let i = 0; d <= range.to && i < 62; i++, d = addDays(d, 1)) {
        const day = await dayAvailability(d, null, d === today ? { minTime: nowTimeHM(n) } : {});
        remaining += day.remaining;
        remainingDays++;
      }
    }

    // Evolução: agendamentos realizados por dia (data do cadastro), sem contar cancelados.
    const evoDays = [7, 15, 30].includes(Number(params.get('evo'))) ? Number(params.get('evo')) : 7;
    let evoFrom = addDays(today, -(evoDays - 1));
    let evoTo = today;
    if (params.get('evo') === 'custom' && isISODate(params.get('evo_from') || '') && isISODate(params.get('evo_to') || '')) {
      evoFrom = params.get('evo_from'); evoTo = params.get('evo_to');
      if (evoFrom > evoTo) [evoFrom, evoTo] = [evoTo, evoFrom];
      if (addDays(evoFrom, 92) < evoTo) evoFrom = addDays(evoTo, -92);
    }
    const { rows: evolution } = await q(
      `SELECT d::date::text AS day, count(a.id) FILTER (WHERE a.status <> 'CANCELADO') AS n
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN appointments a ON (a.created_at AT TIME ZONE 'America/Manaus')::date = d::date
        GROUP BY d ORDER BY d`,
      [evoFrom, evoTo],
    );
    const { rows: campaigns } = await q(
      `SELECT DISTINCT t.utm_campaign AS c FROM attributions t JOIN appointments a ON a.id = t.appointment_id
        WHERE t.utm_campaign IS NOT NULL AND t.utm_campaign <> '' AND a.created_at > now() - interval '180 days' ORDER BY 1 LIMIT 50`,
    );
    json(req, res, 200, {
      period, range, today, single: range.single,
      label: range.single ? formatLongDate(range.from) : `${range.from.split('-').reverse().join('/')} a ${range.to.split('-').reverse().join('/')}`,
      counts, remaining, remainingDays,
      hours, top,
      evolution: { from: evoFrom, to: evoTo, days: evolution },
      campaigns: campaigns.map((r) => r.c),
      updatedAt: nowTimeHM(n),
    });
  });

  // Aviso ao vivo (Server-Sent Events): o painel recarrega os números quando um agendamento entra ou muda.
  router.get('/api/admin/stream', async (req, res) => {
    const admin = await requireAdmin(req);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    res.write('retry: 5000\n\n: conectado\n\n');
    const unsubscribe = subscribeAppointments(() => res.write('event: appointments\ndata: changed\n\n'));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const recheck = setInterval(async () => {
      // Sessão encerrada ou conta desativada: o canal fecha.
      if (!(await sessionAdmin(admin.token).catch(() => null))) { res.write('event: logout\ndata: 1\n\n'); res.end(); }
    }, 60000);
    req.on('close', () => { clearInterval(ping); clearInterval(recheck); unsubscribe(); });
  });

  // ----- Agendamentos -----
  router.get('/api/admin/appointments', async (req, res) => {
    await requireAdmin(req);
    const params = new URL(req.url, 'http://x').searchParams;
    const { where, values } = buildFilters(params);
    const page = Math.max(1, Number(params.get('page')) || 1);
    const per = 50;
    const { rows: [{ total }] } = await q(`SELECT count(*) AS total FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN attributions t ON t.appointment_id = a.id ${where}`, values);
    const order = params.get('sort') === 'chrono' ? 'a.date ASC, a.time ASC, a.id ASC' : 'a.date DESC, a.time ASC, a.id DESC';
    const { rows } = await q(`${LIST_SQL} ${where} ORDER BY ${order} LIMIT ${per} OFFSET ${(page - 1) * per}`, values);
    json(req, res, 200, { total, page, pages: Math.max(1, Math.ceil(total / per)), items: rows.map(rowView) });
  });

  router.get('/api/admin/appointments.csv', async (req, res) => {
    const admin = await requireAdmin(req);
    const params = new URL(req.url, 'http://x').searchParams;
    const { where, values } = buildFilters(params);
    const { rows } = await q(`${LIST_SQL} ${where} ORDER BY a.date, a.time, a.id`, values);
    const header = ['Protocolo', 'Nome', 'Idade', 'Responsável', 'WhatsApp', 'Data do exame', 'Horário', 'Criado em', 'Status', 'Origem', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    const lines = [header.join(';')];
    for (const r of rows) {
      lines.push([r.protocol, r.name, r.age, r.guardian_name, formatWhatsapp(r.whatsapp), r.date.split('-').reverse().join('/'), r.time, r.created, r.status, describeOrigin(r), r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term].map(csvCell).join(';'));
    }
    await audit(admin.id, 'export_csv', 'appointments', null, { rows: rows.length });
    send(req, res, 200, '﻿' + lines.join('\r\n'), {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="agendamentos-${todayISO(now())}.csv"`,
      'cache-control': 'no-store',
    });
  });

  router.patch('/api/admin/appointments/:id', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    const id = Number(params.id);
    const body = await readJson(req);
    const out = {};
    if (body.status !== undefined) {
      out.status = await setStatus(id, body.status);
      await audit(admin.id, 'status', 'appointment', id, out.status);
    }
    if (body.notes !== undefined) {
      await q('UPDATE appointments SET notes = $2, updated_at = now() WHERE id = $1', [id, String(body.notes).slice(0, 1000)]);
      await audit(admin.id, 'notes', 'appointment', id);
    }
    json(req, res, 200, { ok: true, ...out });
  });

  router.post('/api/admin/appointments/:id/reschedule', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const r = await rescheduleAppointment(Number(params.id), body.date, body.time);
    await audit(admin.id, 'reschedule', 'appointment', params.id, r);
    json(req, res, 200, { ok: true, ...r });
  });

  // ----- Pacientes (correção e exclusão — LGPD) -----
  router.patch('/api/admin/patients/:id', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const name = cleanName(body.name);
    const age = cleanAge(body.age, {});
    const whatsapp = cleanWhatsapp(body.whatsapp);
    const guardian = body.guardian_name ? cleanName(body.guardian_name, 'guardian_name') : null;
    const { rowCount } = await q('UPDATE patients SET name=$2, age=$3, whatsapp=$4, guardian_name=$5, updated_at=now() WHERE id=$1 AND anonymized_at IS NULL', [Number(params.id), name, age, whatsapp, guardian]);
    if (!rowCount) throw new HttpError(404, 'Paciente não encontrado.', 'NOT_FOUND');
    await audit(admin.id, 'patient_corrected', 'patient', params.id);
    json(req, res, 200, { ok: true });
  });

  router.post('/api/admin/patients/:id/anonymize', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    const id = Number(params.id);
    await tx(async (c) => {
      const { rowCount } = await c.query(`UPDATE patients SET name='Dados excluídos', whatsapp='00000000000', guardian_name=NULL, anonymized_at=now(), updated_at=now() WHERE id=$1 AND anonymized_at IS NULL`, [id]);
      if (!rowCount) throw new HttpError(404, 'Paciente não encontrado ou já anonimizado.', 'NOT_FOUND');
      await c.query(`UPDATE appointments SET status = CASE WHEN status IN ('NOVO','CONFIRMADO','CONTATADO') AND date >= $2 THEN 'CANCELADO' ELSE status END,
                        cancelled_at = CASE WHEN status IN ('NOVO','CONFIRMADO','CONTATADO') AND date >= $2 THEN now() ELSE cancelled_at END,
                        notes = NULL, social_proof_ok = false, updated_at = now() WHERE patient_id = $1`, [id, todayISO(now())]);
      await c.query('UPDATE attributions SET fbclid = NULL, referrer = NULL, landing_page = NULL WHERE appointment_id IN (SELECT id FROM appointments WHERE patient_id = $1)', [id]);
    });
    await audit(admin.id, 'patient_anonymized', 'patient', id);
    json(req, res, 200, { ok: true });
  });

  // ----- Agenda -----
  router.get('/api/admin/agenda', async (req, res) => {
    await requireAdmin(req);
    const date = new URL(req.url, 'http://x').searchParams.get('date') || addDays(todayISO(now()), 1);
    if (!isISODate(date)) throw new ValidationError('date', 'Data inválida.');
    const day = await dayAvailability(date);
    const { rows: people } = await q(
      `SELECT a.id, a.slot_id, a.protocol, a.status, p.name, p.age, p.whatsapp FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.date = $1 AND a.status <> 'CANCELADO' ORDER BY a.time, a.id`,
      [date],
    );
    const bySlot = {};
    for (const p of people) (bySlot[p.slot_id] ||= []).push({ ...p, whatsappLabel: formatWhatsapp(p.whatsapp) });
    const { rule } = day;
    json(req, res, 200, {
      date, label: formatLongDate(date), open: day.open, reason: rule.reason || null, remaining: day.remaining, booked: day.booked,
      dailyLimit: rule.daily_limit ?? null,
      override: rule.override || null,
      slots: day.slots.map((s) => ({ ...s, patients: bySlot[s.id] || [] })),
    });
  });

  router.patch('/api/admin/slots/:id', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const capacity = intOrNull(body.capacity, 0, 500, 'capacity');
    const blocked = body.blocked === undefined ? null : body.blocked === true;
    const { rows } = await q(
      `UPDATE slots SET capacity = coalesce($2, capacity), blocked = coalesce($3, blocked), manual = true, updated_at = now() WHERE id = $1 RETURNING date, time, capacity, blocked`,
      [Number(params.id), capacity, blocked],
    );
    if (!rows[0]) throw new HttpError(404, 'Horário não encontrado.', 'NOT_FOUND');
    await audit(admin.id, 'slot_updated', 'slot', params.id, rows[0]);
    json(req, res, 200, { ok: true, slot: rows[0] });
  });

  router.post('/api/admin/slots', async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    if (!isISODate(body.date)) throw new ValidationError('date', 'Data inválida.');
    const time = cleanTime(body.time);
    const capacity = intOrNull(body.capacity, 0, 500, 'capacity') ?? 1;
    const { rows } = await q(
      `INSERT INTO slots (date, time, capacity, manual) VALUES ($1,$2,$3,true)
       ON CONFLICT (date, time) DO UPDATE SET capacity = EXCLUDED.capacity, blocked = false, manual = true, updated_at = now() RETURNING id`,
      [body.date, time, capacity],
    );
    await audit(admin.id, 'slot_added', 'slot', rows[0].id, { date: body.date, time, capacity });
    json(req, res, 201, { ok: true, id: rows[0].id });
  });

  router.post('/api/admin/slots/:id/reset', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    const { rows } = await q('UPDATE slots SET manual = false WHERE id = $1 RETURNING date', [Number(params.id)]);
    if (!rows[0]) throw new HttpError(404, 'Horário não encontrado.', 'NOT_FOUND');
    await syncDate(rows[0].date);
    await audit(admin.id, 'slot_reset', 'slot', params.id);
    json(req, res, 200, { ok: true });
  });

  router.get('/api/admin/schedule-rules', async (req, res) => {
    await requireAdmin(req);
    const { rows } = await q('SELECT weekday, is_open, open_time, close_time, lunch_start, lunch_end, interval_minutes, capacity, daily_limit FROM schedule_rules ORDER BY weekday');
    const { rows: overrides } = await q(`SELECT date, is_blocked, reason, open_time, close_time, lunch_start, lunch_end, interval_minutes, capacity, daily_limit FROM date_overrides WHERE date >= $1 ORDER BY date`, [todayISO(now())]);
    json(req, res, 200, { rules: rows, overrides: overrides.map((o) => ({ ...o, label: formatLongDate(o.date) })) });
  });

  router.put('/api/admin/schedule-rules', async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    if (!Array.isArray(body.rules) || body.rules.length !== 7) throw new ValidationError('rules', 'Envie as regras dos 7 dias.');
    const clean = body.rules.map((r) => {
      const weekday = intOrNull(r.weekday, 0, 6, 'weekday');
      const out = {
        weekday,
        is_open: r.is_open === true,
        open_time: timeOrNull(r.open_time, `rules.${weekday}.open_time`) || '08:00',
        close_time: timeOrNull(r.close_time, `rules.${weekday}.close_time`) || '17:00',
        lunch_start: timeOrNull(r.lunch_start, `rules.${weekday}.lunch_start`),
        lunch_end: timeOrNull(r.lunch_end, `rules.${weekday}.lunch_end`),
        interval_minutes: intOrNull(r.interval_minutes, 5, 240, 'interval_minutes') ?? 30,
        capacity: intOrNull(r.capacity, 0, 500, 'capacity') ?? 1,
        daily_limit: intOrNull(r.daily_limit, 0, 100000, 'daily_limit'),
      };
      validateHours(out, `rules.${weekday}.`);
      return out;
    });
    if (new Set(clean.map((r) => r.weekday)).size !== 7) throw new ValidationError('rules', 'Dias da semana repetidos.');
    await tx(async (c) => {
      for (const r of clean) {
        await c.query(
          `UPDATE schedule_rules SET is_open=$2, open_time=$3, close_time=$4, lunch_start=$5, lunch_end=$6, interval_minutes=$7, capacity=$8, daily_limit=$9, updated_at=now() WHERE weekday=$1`,
          [r.weekday, r.is_open, r.open_time, r.close_time, r.lunch_start, r.lunch_end, r.interval_minutes, r.capacity, r.daily_limit],
        );
      }
      await syncUpcoming(60, c, now());
    });
    await audit(admin.id, 'schedule_rules_updated', 'schedule_rules', null, clean);
    json(req, res, 200, { ok: true });
  });

  router.put('/api/admin/date-overrides/:date', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    const date = params.date;
    if (!isISODate(date)) throw new ValidationError('date', 'Data inválida.');
    const b = await readJson(req);
    const o = {
      is_blocked: b.is_blocked === true,
      reason: b.reason ? String(b.reason).slice(0, 120) : null,
      open_time: timeOrNull(b.open_time, 'open_time'),
      close_time: timeOrNull(b.close_time, 'close_time'),
      lunch_start: timeOrNull(b.lunch_start, 'lunch_start'),
      lunch_end: timeOrNull(b.lunch_end, 'lunch_end'),
      interval_minutes: intOrNull(b.interval_minutes, 5, 240, 'interval_minutes'),
      capacity: intOrNull(b.capacity, 0, 500, 'capacity'),
      daily_limit: intOrNull(b.daily_limit, 0, 100000, 'daily_limit'),
    };
    if (!o.is_blocked && (!!o.open_time !== !!o.close_time)) throw new ValidationError('open_time', 'Informe abertura e encerramento.');
    validateHours(o);
    await tx(async (c) => {
      await c.query(
        `INSERT INTO date_overrides (date, is_blocked, reason, open_time, close_time, lunch_start, lunch_end, interval_minutes, capacity, daily_limit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (date) DO UPDATE SET is_blocked=EXCLUDED.is_blocked, reason=EXCLUDED.reason, open_time=EXCLUDED.open_time, close_time=EXCLUDED.close_time,
           lunch_start=EXCLUDED.lunch_start, lunch_end=EXCLUDED.lunch_end, interval_minutes=EXCLUDED.interval_minutes, capacity=EXCLUDED.capacity,
           daily_limit=EXCLUDED.daily_limit, updated_at=now()`,
        [date, o.is_blocked, o.reason, o.open_time, o.close_time, o.lunch_start, o.lunch_end, o.interval_minutes, o.capacity, o.daily_limit],
      );
      const rule = await effectiveRule(date, c);
      const { rows } = await c.query('SELECT 1 FROM slots WHERE date = $1 LIMIT 1', [date]);
      if (rows.length || rule.open) await syncDate(date, c);
    });
    await audit(admin.id, 'date_override_saved', 'date', date, o);
    json(req, res, 200, { ok: true });
  });

  router.delete('/api/admin/date-overrides/:date', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    if (!isISODate(params.date)) throw new ValidationError('date', 'Data inválida.');
    await tx(async (c) => {
      await c.query('DELETE FROM date_overrides WHERE date = $1', [params.date]);
      await syncDate(params.date, c);
    });
    await audit(admin.id, 'date_override_removed', 'date', params.date);
    json(req, res, 200, { ok: true });
  });

  // ----- Configurações -----
  router.get('/api/admin/settings', async (req, res) => {
    await requireAdmin(req);
    const { meta: _integrations, ...settings } = await getSettings({ fresh: true }); // Meta Pixel/API ficam só na área protegida
    const { rows: logo } = await q("SELECT mime, updated_at FROM media WHERE key = 'logo'");
    json(req, res, 200, {
      settings,
      logo: logo[0] ? { mime: logo[0].mime, version: new Date(logo[0].updated_at).getTime() } : null,
    });
  });

  router.put('/api/admin/settings/:section', async (req, res, { params }) => {
    // Meta Pixel e API de Conversões: somente o administrador principal, com a área de Integrações desbloqueada.
    const admin = params.section === 'meta' ? await requireIntegrations(req) : await requireAdmin(req);
    const body = await readJson(req);
    const current = await getSettings({ fresh: true });
    // Agendamento: campos não enviados mantêm o valor atual (o painel pode salvar só parte das opções).
    let value = sanitizeSection(params.section, params.section === 'booking' ? { ...current.booking, ...body } : body);
    if (params.section === 'privacy') value = { ...current.privacy, ...value };
    await saveSection(params.section, value);
    await audit(admin.id, 'settings_updated', 'settings', params.section, value);
    json(req, res, 200, { ok: true, value });
  });

  router.post('/api/admin/logo', async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req, 700 * 1024);
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(body.mime)) throw new ValidationError('logo', 'Envie a logo em PNG, JPG ou WEBP.');
    const data = Buffer.from(String(body.data || ''), 'base64');
    if (!data.length || data.length > 400 * 1024) throw new ValidationError('logo', 'A imagem deve ter até 400 KB.');
    const magic = data.subarray(0, 12).toString('hex');
    const ok = (body.mime === 'image/png' && magic.startsWith('89504e47')) || (body.mime === 'image/jpeg' && magic.startsWith('ffd8ff')) || (body.mime === 'image/webp' && magic.slice(16, 24) === '57454250');
    if (!ok) throw new ValidationError('logo', 'O arquivo não corresponde ao formato informado.');
    await q(`INSERT INTO media (key, mime, data) VALUES ('logo',$1,$2) ON CONFLICT (key) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, [body.mime, data]);
    await audit(admin.id, 'logo_updated', 'media', 'logo');
    json(req, res, 200, { ok: true });
  });

  router.delete('/api/admin/logo', async (req, res) => {
    const admin = await requireAdmin(req);
    await q("DELETE FROM media WHERE key = 'logo'");
    await audit(admin.id, 'logo_removed', 'media', 'logo');
    json(req, res, 200, { ok: true });
  });

  // ----- Dúvidas frequentes -----
  router.get('/api/admin/faq', async (req, res) => {
    await requireAdmin(req);
    const { rows } = await q('SELECT id, question, answer, active FROM faq ORDER BY position, id');
    json(req, res, 200, { items: rows });
  });

  router.put('/api/admin/faq', async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req, 64 * 1024);
    if (!Array.isArray(body.items) || body.items.length > 30) throw new ValidationError('items', 'Lista de perguntas inválida.');
    const items = body.items.map((it) => ({
      question: String(it.question || '').trim().slice(0, 200),
      answer: String(it.answer || '').trim().slice(0, 2000),
      active: it.active !== false,
    })).filter((it) => it.question);
    await tx(async (c) => {
      await c.query('DELETE FROM faq');
      let pos = 0;
      for (const it of items) await c.query('INSERT INTO faq (position, question, answer, active) VALUES ($1,$2,$3,$4)', [pos++, it.question, it.answer, it.active]);
    });
    await audit(admin.id, 'faq_updated', 'faq', null, { count: items.length });
    json(req, res, 200, { ok: true });
  });

  // ----- Textos legais (com versão) -----
  router.get('/api/admin/legal', async (req, res) => {
    await requireAdmin(req);
    const { rows } = await q(`SELECT version, body, to_char(created_at AT TIME ZONE 'America/Manaus', 'DD/MM/YYYY HH24:MI') AS created FROM legal_texts WHERE kind='privacidade' ORDER BY id DESC`);
    json(req, res, 200, { current: rows[0], history: rows.map(({ version, created }) => ({ version, created })) });
  });

  router.put('/api/admin/legal', async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req, 64 * 1024);
    const text = String(body.body || '').trim();
    if (text.length < 200) throw new ValidationError('body', 'A política precisa ter pelo menos 200 caracteres.');
    const settings = await getSettings({ fresh: true });
    const { rows } = await q("SELECT count(*) AS n FROM legal_texts WHERE kind='privacidade'");
    const version = String(rows[0].n + 1);
    await tx(async (c) => {
      await c.query(`INSERT INTO legal_texts (kind, version, body) VALUES ('privacidade',$1,$2)`, [version, text]);
      await saveSection('privacy', { ...settings.privacy, current_version: version, consent_text_version: version }, c);
    });
    await audit(admin.id, 'privacy_policy_published', 'legal', version);
    json(req, res, 200, { ok: true, version });
  });

  // ----- Lista de espera -----
  router.get('/api/admin/waitlist', async (req, res) => {
    await requireAdmin(req);
    const { rows } = await q(`SELECT id, name, age, whatsapp, status, to_char(created_at AT TIME ZONE 'America/Manaus', 'DD/MM/YYYY HH24:MI') AS created
                                FROM waitlist WHERE anonymized_at IS NULL ORDER BY (status = 'AGUARDANDO') DESC, id DESC LIMIT 500`);
    json(req, res, 200, { items: rows.map((r) => ({ ...r, whatsappLabel: formatWhatsapp(r.whatsapp) })) });
  });

  router.patch('/api/admin/waitlist/:id', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    if (!['AGUARDANDO', 'CONTATADO', 'AGENDADO', 'DESCARTADO'].includes(body.status)) throw new ValidationError('status', 'Status inválido.');
    await q('UPDATE waitlist SET status=$2, updated_at=now() WHERE id=$1', [Number(params.id), body.status]);
    await audit(admin.id, 'waitlist_status', 'waitlist', params.id, { status: body.status });
    json(req, res, 200, { ok: true });
  });

  router.get('/api/admin/audit', async (req, res) => {
    await requireAdmin(req, { principal: true });
    const { rows } = await q(`SELECT l.action, l.entity, l.entity_id, to_char(l.created_at AT TIME ZONE 'America/Manaus', 'DD/MM/YYYY HH24:MI') AS at, a.email
                                FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT 200`);
    json(req, res, 200, { items: rows });
  });

  // ----- Gerenciar administradores (somente o administrador principal) -----
  router.get('/api/admin/admins', async (req, res) => {
    const admin = await requireAdmin(req, { principal: true });
    json(req, res, 200, { ...(await listAdmins()), me: admin.id, roles: ROLES, inviteHours: INVITE_HOURS, emailConfigured: false });
  });

  router.post('/api/admin/invites', async (req, res) => {
    const admin = await requireAdmin(req, { principal: true });
    const body = await readJson(req, 4096);
    const email = cleanEmail(body.email);
    if (!email) throw new ValidationError('email', 'Informe um e-mail válido.');
    const name = cleanAdminName(body.name);
    if (!name) throw new ValidationError('name', 'Informe o nome (2 a 80 caracteres).');
    if (!ROLES[body.role]) throw new ValidationError('role', 'Escolha o nível de acesso.');
    let token;
    try { token = await createInvite({ email, name, role: body.role, createdBy: admin.id }); } catch (e) {
      if (e.code === 'EXISTS') throw new ValidationError('email', e.message);
      throw e;
    }
    await audit(admin.id, 'invite_created', 'invite', email, { role: body.role }); // o token nunca vai para o log
    json(req, res, 201, { ok: true, token, hours: INVITE_HOURS, emailSent: false });
  });

  router.post('/api/admin/invites/:id/resend', async (req, res, { params }) => {
    const admin = await requireAdmin(req, { principal: true });
    const r = await resendInvite(idParam(params.id), admin.id);
    if (!r) throw new HttpError(404, 'Convite não encontrado.', 'NOT_FOUND');
    await audit(admin.id, 'invite_resent', 'invite', r.email);
    json(req, res, 200, { ok: true, token: r.token, hours: INVITE_HOURS, emailSent: false });
  });

  router.delete('/api/admin/invites/:id', async (req, res, { params }) => {
    const admin = await requireAdmin(req, { principal: true });
    if (!(await revokeInvite(idParam(params.id)))) throw new HttpError(404, 'Convite não encontrado.', 'NOT_FOUND');
    await audit(admin.id, 'invite_revoked', 'invite', params.id);
    json(req, res, 200, { ok: true });
  });

  router.patch('/api/admin/admins/:id', async (req, res, { params }) => {
    const admin = await requireAdmin(req, { principal: true });
    const body = await readJson(req, 2048);
    const role = body.role === undefined ? undefined : (ROLES[body.role] ? body.role : null);
    if (role === null) throw new ValidationError('role', 'Nível de acesso inválido.');
    const disabled = body.disabled === undefined ? undefined : body.disabled === true;
    const r = await updateAdmin(idParam(params.id), { role, disabled }, admin.id);
    if (!r.ok) throw new HttpError(r.status || 422, r.error, 'INVALID');
    await audit(admin.id, disabled === true ? 'admin_disabled' : disabled === false ? 'admin_enabled' : 'admin_role_changed', 'admin', params.id, { role, email: r.email });
    json(req, res, 200, { ok: true });
  });

  router.delete('/api/admin/admins/:id', async (req, res, { params }) => {
    const admin = await requireAdmin(req, { principal: true });
    const r = await removeAdmin(idParam(params.id), admin.id);
    if (!r.ok) throw new HttpError(r.status || 422, r.error, 'INVALID');
    await audit(admin.id, 'admin_removed', 'admin', params.id, { email: r.email });
    json(req, res, 200, { ok: true });
  });

  // ----- Ativação do convite (sem sessão; o token viaja só no corpo da requisição, nunca na URL do servidor) -----
  router.post('/api/admin/invites/check', async (req, res) => {
    checkCsrf(req);
    if (!rateLimit('invite:' + clientIp(req), 30, 15 * 60 * 1000).ok) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'RATE_LIMIT');
    const body = await readJson(req, 2048);
    const info = await inviteInfo(body.token);
    if (!info) throw new HttpError(404, 'Este convite não é válido, já foi usado ou expirou. Peça um novo convite ao administrador principal.', 'INVITE_INVALID');
    json(req, res, 200, { invite: info });
  });

  router.post('/api/admin/invites/accept', async (req, res) => {
    checkCsrf(req);
    if (!rateLimit('invite:' + clientIp(req), 30, 15 * 60 * 1000).ok) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    if (body.password !== body.confirm) throw new ValidationError('confirm', 'As senhas não conferem.');
    const r = await acceptInvite({ token: body.token, email: body.email, name: body.name, password: body.password });
    if (!r.ok) throw new HttpError(422, r.error, 'INVALID', r.field);
    json(req, res, 201, { ok: true });
  });

  // ----- Integrações (somente administrador principal + senha exclusiva) -----
  router.get('/api/admin/integrations/status', async (req, res) => {
    const admin = await requireAdmin(req, { principal: true });
    json(req, res, 200, await integrationStatus(admin));
  });

  router.post('/api/admin/integrations/setup', async (req, res) => {
    const admin = await requireAdmin(req, { principal: true });
    const body = await readJson(req, 2048);
    if (body.password !== body.confirm) throw new ValidationError('confirm', 'As senhas não conferem.');
    const r = await setupIntegrationPassword(admin.id, body.password);
    if (!r.ok) throw new HttpError(422, r.error, 'INVALID', 'password');
    await unlockSession(admin.sessionId);
    await audit(admin.id, 'integrations_password_created', 'integrations', null);
    json(req, res, 201, { ok: true, recoveryCode: r.recoveryCode });
  });

  router.post('/api/admin/integrations/unlock', async (req, res) => {
    const admin = await requireAdmin(req, { principal: true });
    if (!rateLimit('integrations:' + admin.id, 10, 15 * 60 * 1000).ok) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.', 'RATE_LIMIT');
    const body = await readJson(req, 2048);
    const r = await checkIntegrationPassword(body.password);
    if (!r.ok) {
      await audit(admin.id, r.reason === 'locked' ? 'integrations_unlock_blocked' : 'integrations_unlock_failed', 'integrations', null, { ip: clientIp(req) });
      if (r.reason === 'setup') throw new HttpError(423, 'Crie a senha de Integrações para continuar.', 'INTEGRATIONS_SETUP');
      if (r.reason === 'locked') throw new HttpError(429, 'Muitas tentativas. A área de Integrações foi bloqueada por 15 minutos.', 'LOCKED');
      throw new HttpError(401, 'Senha de Integrações incorreta.', 'INVALID_PASSWORD', 'password');
    }
    await unlockSession(admin.sessionId);
    await audit(admin.id, 'integrations_unlocked', 'integrations', null);
    json(req, res, 200, { ok: true });
  });

  router.post('/api/admin/integrations/lock', async (req, res) => {
    const admin = await requireAdmin(req, { principal: true });
    await lockSession(admin.sessionId);
    json(req, res, 200, { ok: true });
  });

  router.get('/api/admin/integrations', async (req, res) => {
    await requireIntegrations(req);
    const settings = await getSettings({ fresh: true });
    const { rows: metaLog } = await q(`SELECT m.event_name, m.status, left(m.response, 300) AS response, to_char(m.created_at AT TIME ZONE 'America/Manaus', 'DD/MM HH24:MI') AS at, a.protocol
                                         FROM meta_events m LEFT JOIN appointments a ON a.id = m.appointment_id ORDER BY m.id DESC LIMIT 10`);
    // Tokens nunca saem do servidor: o painel recebe só se estão configurados.
    json(req, res, 200, { meta: settings.meta, env: await siteStatus(), metaLog });
  });

  router.post('/api/admin/integrations/password', async (req, res) => {
    const admin = await requireIntegrations(req);
    const body = await readJson(req, 2048);
    if (body.next !== body.confirm) throw new ValidationError('confirm', 'As senhas não conferem.');
    const r = await changeIntegrationPassword(body.current, body.next);
    if (!r.ok) {
      await audit(admin.id, 'integrations_password_change_failed', 'integrations', null);
      throw new HttpError(422, r.error, 'INVALID', 'current');
    }
    await unlockSession(admin.sessionId); // as outras sessões foram bloqueadas; esta continua aberta
    await audit(admin.id, 'integrations_password_changed', 'integrations', null);
    json(req, res, 200, { ok: true });
  });

  router.post('/api/admin/integrations/revoke', async (req, res) => {
    const admin = await requireIntegrations(req);
    const n = await revokeIntegrationSessions();
    await audit(admin.id, 'integrations_sessions_revoked', 'integrations', null, { sessions: n });
    json(req, res, 200, { ok: true, sessions: n });
  });

  router.post('/api/admin/integrations/reset', async (req, res) => {
    const admin = await requireAdmin(req, { principal: true });
    if (!rateLimit('integrations-reset:' + admin.id, 5, 15 * 60 * 1000).ok) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.', 'RATE_LIMIT');
    const body = await readJson(req, 2048);
    if (body.next !== body.confirm) throw new ValidationError('confirm', 'As senhas não conferem.');
    const r = await resetIntegrationPassword({ adminId: admin.id, accountPassword: body.accountPassword, recoveryCode: body.recoveryCode, next: body.next });
    if (!r.ok) {
      await audit(admin.id, 'integrations_reset_failed', 'integrations', null, { ip: clientIp(req) });
      throw new HttpError(422, r.error, 'INVALID');
    }
    await unlockSession(admin.sessionId);
    await audit(admin.id, 'integrations_password_reset', 'integrations', null);
    json(req, res, 200, { ok: true, recoveryCode: r.recoveryCode });
  });
}
