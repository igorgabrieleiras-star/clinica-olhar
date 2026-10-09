import { q, tx } from '../db.js';
import { now, config } from '../config.js';
import { getSettings, saveSection, DEFAULTS } from '../settings.js';
import { dayAvailability, publicAvailability, syncDate, syncUpcoming, effectiveRule } from '../availability.js';
import { setStatus, rescheduleAppointment } from '../booking.js';
import { login, logout, sessionAdmin, changePassword, SESSION_COOKIE, SESSION_HOURS } from '../auth.js';
import { todayISO, addDays, publicCandidateDates, isISODate, formatLongDate, timeToMinutes } from '../dates.js';
import { cleanName, cleanAge, cleanWhatsapp, cleanTime, ValidationError, formatWhatsapp } from '../validate.js';
import { json, readJson, parseCookies, setCookie, clientIp, rateLimit, HttpError, send } from '../http.js';

const STATUSES = ['NOVO', 'CONFIRMADO', 'CONTATADO', 'COMPARECEU', 'NAO_COMPARECEU', 'CANCELADO'];

async function audit(adminId, action, entity, entityId, details) {
  await q('INSERT INTO audit_log (admin_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)', [
    adminId, action, entity, entityId === undefined ? null : String(entityId), details ? JSON.stringify(details) : null,
  ]);
}

/** Exige sessão válida; para métodos que alteram dados, exige também o cabeçalho anti-CSRF e origem própria. */
async function requireAdmin(req, { allowPasswordChange = false } = {}) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const admin = await sessionAdmin(token);
  if (!admin) throw new HttpError(401, 'Sua sessão expirou. Entre novamente.', 'UNAUTHENTICATED');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['x-olhar-csrf'] !== '1') throw new HttpError(403, 'Requisição bloqueada.', 'CSRF');
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origem não permitida.', 'CSRF');
  }
  if (admin.mustChangePassword && !allowPasswordChange) throw new HttpError(403, 'Troque a senha inicial para continuar.', 'MUST_CHANGE_PASSWORD');
  admin.token = token;
  return admin;
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

// ---------- Filtros da lista de agendamentos ----------
function buildFilters(params) {
  const where = [];
  const values = [];
  const add = (sql, v) => { values.push(v); where.push(sql.replace('?', '$' + values.length)); };
  const today = todayISO(now());
  const period = params.get('period') || '';
  const field = params.get('field') === 'criacao' ? 'criacao' : 'exame';
  const createdDay = "(a.created_at AT TIME ZONE 'America/Manaus')::date";
  if (period === 'hoje') add('a.date = ?', today);
  else if (period === 'amanha') add('a.date = ?', addDays(today, 1));
  else if (period === 'sabado') add('a.date = ?', publicCandidateDates(now()).find((c) => c.kinds.includes('sabado')).date);
  else if (period === '7d') add(`${createdDay} >= ?`, addDays(today, -6));
  else if (period === 'mes') add(`${createdDay} >= ?`, today.slice(0, 8) + '01');
  else if (period === 'custom') {
    const col = field === 'criacao' ? createdDay : 'a.date';
    const from = params.get('from');
    const to = params.get('to');
    if (from && isISODate(from)) add(`${col} >= ?`, from);
    if (to && isISODate(to)) add(`${col} <= ?`, to);
  }
  const status = params.get('status');
  if (status && STATUSES.includes(status)) add('a.status = ?', status);
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
      return { enabled: bool(i.enabled), max_age_hours: intOrNull(i.max_age_hours, 1, 168, 'max_age_hours') ?? 48 };
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
      const msg = result.reason === 'locked' ? 'Acesso bloqueado temporariamente após várias tentativas. Tente em 15 minutos.' : 'E-mail ou senha incorretos.';
      throw new HttpError(401, msg, 'LOGIN_FAILED');
    }
    await audit(result.admin.id, 'login', 'admin', result.admin.id);
    json(req, res, 200, { ok: true, admin: result.admin }, {
      'set-cookie': setCookie(SESSION_COOKIE, result.token, { maxAge: SESSION_HOURS * 3600 }),
    });
  });

  router.post('/api/admin/logout', async (req, res) => {
    await logout(parseCookies(req)[SESSION_COOKIE]);
    json(req, res, 200, { ok: true }, { 'set-cookie': setCookie(SESSION_COOKIE, '', { maxAge: 0 }) });
  });

  router.get('/api/admin/me', async (req, res) => {
    const admin = await requireAdmin(req, { allowPasswordChange: true });
    json(req, res, 200, { admin: { id: admin.id, email: admin.email, name: admin.name, mustChangePassword: admin.mustChangePassword } });
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

  // ----- Agendamentos -----
  router.get('/api/admin/appointments', async (req, res) => {
    await requireAdmin(req);
    const params = new URL(req.url, 'http://x').searchParams;
    const { where, values } = buildFilters(params);
    const page = Math.max(1, Number(params.get('page')) || 1);
    const per = 50;
    const { rows: [{ total }] } = await q(`SELECT count(*) AS total FROM appointments a JOIN patients p ON p.id = a.patient_id ${where}`, values);
    const { rows } = await q(`${LIST_SQL} ${where} ORDER BY a.date DESC, a.time ASC, a.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, values);
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
    const settings = await getSettings({ fresh: true });
    const { rows: logo } = await q("SELECT mime, updated_at FROM media WHERE key = 'logo'");
    const { rows: metaLog } = await q(`SELECT m.event_name, m.status, left(m.response, 300) AS response, to_char(m.created_at AT TIME ZONE 'America/Manaus', 'DD/MM HH24:MI') AS at, a.protocol
                                         FROM meta_events m LEFT JOIN appointments a ON a.id = m.appointment_id ORDER BY m.id DESC LIMIT 10`);
    json(req, res, 200, {
      settings,
      env: await siteStatus(),
      logo: logo[0] ? { mime: logo[0].mime, version: new Date(logo[0].updated_at).getTime() } : null,
      metaLog,
    });
  });

  router.put('/api/admin/settings/:section', async (req, res, { params }) => {
    const admin = await requireAdmin(req);
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
    await requireAdmin(req);
    const { rows } = await q(`SELECT l.action, l.entity, l.entity_id, to_char(l.created_at AT TIME ZONE 'America/Manaus', 'DD/MM/YYYY HH24:MI') AS at, a.email
                                FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT 200`);
    json(req, res, 200, { items: rows });
  });
}
