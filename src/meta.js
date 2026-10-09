// API de Conversões da Meta. Envia apenas dados de contato em hash (SHA-256) e dados técnicos.
// Nunca envia idade, informações clínicas ou qualquer dado de saúde.
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';
import { getSettings } from './settings.js';

const sha = (v) => createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

export function buildFbc(fbclid, cookieFbc, createdAtMs = Date.now()) {
  if (cookieFbc && /^fb\.\d\.\d+\./.test(cookieFbc)) return cookieFbc;
  if (fbclid) return `fb.1.${createdAtMs}.${fbclid}`;
  return undefined;
}

export function buildLeadPayload({ booking, eventName, ctx, testCode }) {
  const firstName = booking.name.split(' ')[0].normalize('NFD').replace(/\p{M}/gu, '');
  const user_data = {
    ph: [sha('55' + booking.whatsapp)],
    fn: [sha(firstName)],
    country: [sha('br')],
    external_id: [sha('olhar-patient-' + booking.patientId)],
    client_ip_address: ctx.ip || undefined,
    client_user_agent: ctx.userAgent || undefined,
    fbc: buildFbc(ctx.fbclid, ctx.fbc),
    fbp: ctx.fbp && /^fb\.\d\.\d+\.\d+$/.test(ctx.fbp) ? ctx.fbp : undefined,
  };
  for (const k of Object.keys(user_data)) if (user_data[k] === undefined) delete user_data[k];
  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: booking.eventId,
        action_source: 'website',
        event_source_url: ctx.landingPage || config.appUrl || undefined,
        user_data,
      },
    ],
  };
  if (testCode) payload.test_event_code = testCode;
  return payload;
}

/**
 * Envia Lead (e opcionalmente Schedule) pela CAPI, uma única vez por agendamento.
 * Só envia se: integração ligada, pixel configurado, token no servidor e o visitante aceitou os cookies de medição.
 */
export async function sendConversion(booking, ctx, { fetchImpl = globalThis.fetch } = {}) {
  const settings = await getSettings();
  const m = settings.meta;
  if (!m.capi_enabled || !m.pixel_id || !config.metaCapiToken) return { skipped: 'disabled' };
  if (m.require_consent && !ctx.adsConsent) return { skipped: 'no_consent' };
  const events = ['Lead'];
  if (m.schedule_event) events.push('Schedule');
  const results = [];
  for (const eventName of events) {
    // Registro único por agendamento + evento: impede envio duplicado.
    const { rowCount } = await q(
      `INSERT INTO meta_events (appointment_id, event_name, event_id, status) VALUES ($1,$2,$3,'pending')
       ON CONFLICT (appointment_id, event_name) DO NOTHING`,
      [booking.id, eventName, booking.eventId],
    );
    if (!rowCount) { results.push({ eventName, skipped: 'already_sent' }); continue; }
    const payload = buildLeadPayload({ booking, eventName, ctx, testCode: config.metaTestEventCode });
    const url = `https://graph.facebook.com/${config.metaGraphVersion}/${encodeURIComponent(m.pixel_id)}/events?access_token=${encodeURIComponent(config.metaCapiToken)}`;
    let status = 'error';
    let response = '';
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      response = (await res.text()).slice(0, 1000);
      status = res.ok ? 'sent' : 'error';
    } catch (err) {
      response = String(err.message || err).slice(0, 500);
    }
    await q('UPDATE meta_events SET status = $3, response = $4 WHERE appointment_id = $1 AND event_name = $2', [booking.id, eventName, status, response]);
    results.push({ eventName, status });
  }
  return { results };
}
