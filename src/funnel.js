// Funil interno da Clínica Olhar (medição operacional própria, anônima e sem cookies).
// Guarda só: sessão aleatória da aba, etapa, origem da visita (UTM), se veio de anúncio, domínio de referência e tipo de
// aparelho. Nunca guarda nome, idade, WhatsApp, IP ou identificadores de clique (fbclid) — e não envia nada a terceiros.
import { randomUUID } from 'node:crypto';
import { q } from './db.js';

export const CLIENT_EVENTS = ['landing', 'name_started', 'age_step', 'whatsapp_step', 'date_step', 'time_step'];
export const FUNNEL_STEPS = [...CLIENT_EVENTS, 'booking_confirmed'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AD_SOURCE = /facebook|fb|instagram|ig|meta/i;

const clean = (v, max = 150) => {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, max);
  return s || null;
};
function refHost(ref) {
  try { return ref ? new URL(String(ref)).hostname.slice(0, 120) : null; } catch { return null; }
}

/** Normaliza a origem enviada pelo navegador ou gravada no agendamento. */
export function funnelOrigin(attr = {}) {
  const a = attr || {};
  return {
    utm_source: clean(a.utm_source), utm_medium: clean(a.utm_medium), utm_campaign: clean(a.utm_campaign, 200),
    utm_content: clean(a.utm_content, 200), utm_term: clean(a.utm_term, 200),
    from_ad: !!(a.fbclid || a.from_ad === true || AD_SOURCE.test(String(a.utm_source || ''))),
    referrer_host: refHost(a.referrer),
  };
}
export const deviceOf = (ua) => (/Mobi|Android|iPhone|iPad|iPod/i.test(String(ua || '')) ? 'mobile' : 'desktop');
export const validSession = (sid) => typeof sid === 'string' && UUID_RE.test(sid);

/** Registra uma etapa (uma vez por sessão). Retorna true se gravou. */
export async function recordFunnel({ sessionId, event, origin, device, appointmentId = null }, client = null) {
  if (!FUNNEL_STEPS.includes(event)) return false;
  const sid = validSession(sessionId) ? sessionId : randomUUID();
  const o = origin || funnelOrigin({});
  const db = client || { query: q };
  const { rowCount } = await db.query(
    `INSERT INTO funnel_events (session_id, event, utm_source, utm_medium, utm_campaign, utm_content, utm_term, from_ad, referrer_host, device, appointment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (session_id, event) DO NOTHING`,
    [sid, event, o.utm_source, o.utm_medium, o.utm_campaign, o.utm_content, o.utm_term, o.from_ad, o.referrer_host, device === 'mobile' ? 'mobile' : 'desktop', appointmentId],
  );
  return rowCount > 0;
}

/** Funil do período (sessões distintas por etapa), no total e só das visitas vindas de anúncios. */
export async function funnelReport(from, to) {
  const { rows } = await q(
    `SELECT event, count(DISTINCT session_id)::int AS n, count(DISTINCT session_id) FILTER (WHERE from_ad)::int AS ads
       FROM funnel_events WHERE (created_at AT TIME ZONE 'America/Manaus')::date BETWEEN $1 AND $2 GROUP BY event`,
    [from, to],
  );
  const by = Object.fromEntries(rows.map((r) => [r.event, r]));
  const steps = FUNNEL_STEPS.map((e) => ({ event: e, n: by[e]?.n || 0, ads: by[e]?.ads || 0 }));
  const { rows: campaigns } = await q(
    `SELECT coalesce(nullif(utm_campaign, ''), CASE WHEN from_ad THEN '(anúncio sem UTM)' ELSE '(sem campanha)' END) AS campaign,
            count(DISTINCT session_id) FILTER (WHERE event = 'landing')::int AS visits,
            count(DISTINCT session_id) FILTER (WHERE event = 'booking_confirmed')::int AS bookings
       FROM funnel_events WHERE (created_at AT TIME ZONE 'America/Manaus')::date BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 8`,
    [from, to],
  );
  const { rows: devices } = await q(
    `SELECT device, count(DISTINCT session_id)::int AS n FROM funnel_events
      WHERE event = 'landing' AND (created_at AT TIME ZONE 'America/Manaus')::date BETWEEN $1 AND $2 GROUP BY device`,
    [from, to],
  );
  return { steps, campaigns, devices: Object.fromEntries(devices.map((d) => [d.device, d.n])) };
}
