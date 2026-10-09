import { q } from './db.js';
import { weekdayOf, timeToMinutes, minutesToTime, publicCandidateDates, formatLongDate, todayISO, addDays, earliestTimeToday, nowTimeHM } from './dates.js';
import { getSettings } from './settings.js';

const runner = (client) => client || { query: q };

/** Regra efetiva de uma data: regra do dia da semana + exceção da data (se houver). */
export async function effectiveRule(date, client) {
  const db = runner(client);
  const [{ rows: r }, { rows: o }] = await Promise.all([
    db.query('SELECT * FROM schedule_rules WHERE weekday = $1', [weekdayOf(date)]),
    db.query('SELECT * FROM date_overrides WHERE date = $1', [date]),
  ]);
  const base = r[0] || { is_open: false };
  const ov = o[0];
  if (ov?.is_blocked) return { open: false, reason: ov.reason || 'Data bloqueada', override: ov };
  const pick = (k) => (ov && ov[k] !== null && ov[k] !== undefined ? ov[k] : base[k]);
  const customHours = ov && ov.open_time && ov.close_time;
  const open = customHours ? true : !!base.is_open;
  if (!open) return { open: false, reason: 'Sem atendimento neste dia', override: ov || null };
  return {
    open: true,
    open_time: pick('open_time'),
    close_time: pick('close_time'),
    lunch_start: customHours ? ov.lunch_start : base.lunch_start,
    lunch_end: customHours ? ov.lunch_end : base.lunch_end,
    interval_minutes: Number(pick('interval_minutes')),
    capacity: Number(pick('capacity')),
    daily_limit: pick('daily_limit') === null || pick('daily_limit') === undefined ? null : Number(pick('daily_limit')),
    override: ov || null,
  };
}

/** Horários gerados a partir de uma regra (abertura → encerramento, pulando o almoço). */
export function generateTimes(rule) {
  if (!rule?.open) return [];
  const start = timeToMinutes(rule.open_time);
  const end = timeToMinutes(rule.close_time);
  const step = rule.interval_minutes;
  const ls = rule.lunch_start ? timeToMinutes(rule.lunch_start) : null;
  const le = rule.lunch_end ? timeToMinutes(rule.lunch_end) : null;
  const out = [];
  for (let t = start; t < end; t += step) {
    if (ls !== null && t >= ls && t < le) continue;
    out.push(minutesToTime(t));
  }
  return out;
}

/** Cria os horários da data, se ainda não existirem. */
export async function ensureSlots(date, client) {
  const db = runner(client);
  const { rows } = await db.query('SELECT 1 FROM slots WHERE date = $1 LIMIT 1', [date]);
  if (rows.length) return;
  const rule = await effectiveRule(date, client);
  const times = generateTimes(rule);
  if (!times.length) return;
  await db.query(
    `INSERT INTO slots (date, time, capacity)
     SELECT $1::date, t::time, $2 FROM unnest($3::text[]) AS t
     ON CONFLICT (date, time) DO NOTHING`,
    [date, rule.capacity, times],
  );
}

/**
 * Reaplica as regras a uma data já materializada (após o administrador mudar horários).
 * Horários editados manualmente não são alterados. Horários com pacientes nunca são apagados.
 */
export async function syncDate(date, client) {
  const db = runner(client);
  const rule = await effectiveRule(date, client);
  const desired = new Set(generateTimes(rule));
  const { rows: existing } = await db.query(
    `SELECT s.id, s.time, s.manual,
            (SELECT count(*) FROM appointments a WHERE a.slot_id = s.id) AS any_appts
       FROM slots s WHERE s.date = $1`,
    [date],
  );
  const have = new Set();
  for (const s of existing) {
    have.add(s.time);
    if (s.manual) continue;
    if (desired.has(s.time)) {
      await db.query('UPDATE slots SET capacity = $2, blocked = false, updated_at = now() WHERE id = $1', [s.id, rule.capacity]);
    } else if (s.any_appts > 0) {
      await db.query('UPDATE slots SET blocked = true, updated_at = now() WHERE id = $1', [s.id]);
    } else {
      await db.query('DELETE FROM slots WHERE id = $1', [s.id]);
    }
  }
  const missing = [...desired].filter((t) => !have.has(t));
  if (missing.length) {
    await db.query(
      `INSERT INTO slots (date, time, capacity)
       SELECT $1::date, t::time, $2 FROM unnest($3::text[]) AS t ON CONFLICT (date, time) DO NOTHING`,
      [date, rule.capacity, missing],
    );
  }
}

/** Reaplica regras de hoje até N dias à frente (usado quando a agenda é alterada). */
export async function syncUpcoming(days = 60, client, now = new Date()) {
  const today = todayISO(now);
  const db = runner(client);
  const { rows } = await db.query('SELECT DISTINCT date FROM slots WHERE date >= $1', [today]);
  const dates = new Set(rows.map((r) => r.date));
  for (let i = 0; i <= days; i++) dates.add(addDays(today, i));
  for (const d of [...dates].sort()) {
    const { rows: has } = await db.query('SELECT 1 FROM slots WHERE date = $1 LIMIT 1', [d]);
    if (has.length) await syncDate(d, client);
  }
}

/**
 * Ocupação de uma data: cada horário com capacidade, ocupação e vagas livres.
 * Opções (usadas no fluxo público para HOJE):
 *   minTime    — horários antes deste (agora + antecedência mínima) não são elegíveis;
 *   sameDayCap — teto adicional de pacientes por horário no mesmo dia (nunca acima da capacidade real).
 */
export async function dayAvailability(date, client, { minTime = null, sameDayCap = null } = {}) {
  const db = runner(client);
  const rule = await effectiveRule(date, client);
  if (rule.open) await ensureSlots(date, client);
  const { rows } = await db.query(
    `SELECT s.id, s.time, s.capacity, s.blocked, s.manual,
            count(a.id) FILTER (WHERE a.status <> 'CANCELADO') AS booked
       FROM slots s
       LEFT JOIN appointments a ON a.slot_id = s.id
      WHERE s.date = $1
      GROUP BY s.id
      ORDER BY s.time`,
    [date],
  );
  const totalBooked = rows.reduce((n, r) => n + r.booked, 0);
  const dayLeft = rule.open && rule.daily_limit !== null ? Math.max(0, rule.daily_limit - totalBooked) : Infinity;
  const cap = sameDayCap === null || sameDayCap === undefined ? null : Number(sameDayCap);
  const slots = rows.map((r) => {
    const eligible = !minTime || r.time >= minTime;
    const limit = cap === null ? r.capacity : Math.min(r.capacity, cap);
    const free = !rule.open || r.blocked || !eligible ? 0 : Math.max(0, limit - r.booked);
    return { id: r.id, time: r.time, capacity: r.capacity, booked: r.booked, blocked: r.blocked, manual: r.manual, eligible, free };
  });
  const slotFree = slots.reduce((n, s) => n + s.free, 0);
  const remaining = rule.open ? Math.min(slotFree, dayLeft) : 0;
  if (remaining === 0) for (const s of slots) s.free = 0;
  else if (dayLeft !== Infinity) for (const s of slots) s.free = Math.min(s.free, dayLeft);
  return { date, rule, open: rule.open, slots, booked: totalBooked, remaining };
}

/** Regras do fluxo público lidas das configurações (com os padrões). */
export function publicRules(settings) {
  const b = settings.booking;
  return {
    flags: { today: b.today_enabled !== false, tomorrow: b.tomorrow_enabled !== false, saturday: b.saturday_enabled !== false },
    leadMinutes: Number.isFinite(Number(b.min_lead_minutes)) ? Number(b.min_lead_minutes) : 60,
    sameDayCap: b.same_day_cap === null || b.same_day_cap === undefined || b.same_day_cap === '' ? null : Number(b.same_day_cap),
  };
}

/** Opções de disponibilidade para uma data candidata (HOJE recebe antecedência mínima e teto do mesmo dia). */
export function optionsFor(candidate, rules, now) {
  if (!candidate.isToday) return {};
  const minTime = earliestTimeToday(now, rules.leadMinutes);
  return { minTime: minTime || '24:00', sameDayCap: rules.sameDayCap };
}

/** O que o visitante vê: hoje (horários futuros), amanhã e o próximo sábado, com vagas reais. */
export async function publicAvailability(now = new Date()) {
  const settings = await getSettings();
  const enabled = !!settings.booking.enabled;
  const rules = publicRules(settings);
  const candidates = publicCandidateDates(now, rules.flags);
  const dates = [];
  for (const c of candidates) {
    const day = enabled ? await dayAvailability(c.date, null, optionsFor(c, rules, now)) : { open: false, remaining: 0, slots: [] };
    const times = day.slots
      // Hoje: horários que já passaram ou sem a antecedência mínima nem aparecem.
      .filter((s) => !s.blocked && s.eligible !== false)
      .map((s) => ({ time: s.time, available: s.free > 0, left: s.free, period: timeToMinutes(s.time) < 12 * 60 ? 'manha' : 'tarde' }));
    dates.push({
      date: c.date,
      kind: c.kind,
      kinds: c.kinds,
      tag: c.tag,
      isToday: c.isToday,
      isSaturday: c.isSaturday,
      label: formatLongDate(c.date),
      remaining: day.remaining,
      available: day.remaining > 0,
      times,
    });
  }
  const total = dates.reduce((n, d) => n + d.remaining, 0);
  const todayEntry = dates.find((d) => d.isToday && d.available);
  return {
    enabled,
    now: { date: todayISO(now), time: nowTimeHM(now) },
    leadTime: rules.leadMinutes, // minutos de antecedência mínima para hoje
    dates,
    total,
    scarce: total > 0 && total <= Number(settings.booking.scarcity_threshold || 0),
    today: todayEntry ? { date: todayEntry.date, next: todayEntry.times.filter((t) => t.available).slice(0, 3).map((t) => ({ time: t.time, left: t.left })) } : null,
    waitlist: !!settings.booking.waitlist_enabled,
  };
}
