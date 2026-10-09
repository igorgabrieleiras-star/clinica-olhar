import { q } from '../db.js';
import { config, now } from '../config.js';
import { todayISO, addDays, formatLongDate } from '../dates.js';
import { getSettings } from '../settings.js';
import { publicAvailability } from '../availability.js';
import { parsePublicBooking, createBooking, confirmationView, hashIp, BookingError } from '../booking.js';
import { sendConversion } from '../meta.js';
import { cleanName, cleanWhatsapp, cleanAge, ValidationError } from '../validate.js';
import { json, html, readJson, rateLimit, clientIp, parseCookies, HttpError, send } from '../http.js';
import { renderLanding, renderPrivacy, renderNotFound } from '../views.js';

async function loadFaq(settings) {
  const { rows } = await q('SELECT question, answer FROM faq WHERE active ORDER BY position, id');
  return rows
    .map((r) => {
      // A resposta sobre o local usa o endereço configurado; sem endereço, a pergunta não aparece.
      if (/onde será realizado/i.test(r.question) && !r.answer.trim()) {
        return settings.clinic.address ? { ...r, answer: `O exame é realizado na ${settings.clinic.name}: ${settings.clinic.address}.` } : null;
      }
      return r.answer.trim() ? r : null;
    })
    .filter(Boolean);
}

export function registerPublic(router) {
  router.get('/', async (req, res) => {
    const settings = await getSettings();
    const [availability, faq] = await Promise.all([publicAvailability(now()), loadFaq(settings)]);
    const { rows: logo } = await q("SELECT updated_at FROM media WHERE key = 'logo'");
    html(req, res, 200, renderLanding({ settings, availability, faq, logoVersion: logo[0] ? new Date(logo[0].updated_at).getTime() : null }));
  });

  router.get('/privacidade', async (req, res) => {
    const settings = await getSettings();
    const { rows } = await q("SELECT version, body, created_at FROM legal_texts WHERE kind = 'privacidade' ORDER BY created_at DESC, id DESC LIMIT 1");
    html(req, res, 200, renderPrivacy({ settings, policy: rows[0] }));
  });

  router.get('/api/availability', async (req, res) => {
    json(req, res, 200, await publicAvailability(now()));
  });

  router.post('/api/bookings', async (req, res) => {
    const ip = clientIp(req);
    const limit = rateLimit('booking:' + ip, Number(process.env.BOOKING_RATE_LIMIT || 8), 60 * 60 * 1000);
    if (!limit.ok) throw new HttpError(429, 'Muitas tentativas em pouco tempo. Aguarde alguns minutos ou fale com a clínica pelo WhatsApp.', 'RATE_LIMIT');
    const body = await readJson(req);
    // Proteção contra robôs: campo invisível preenchido ou envio rápido demais.
    if (body.website || Number(body.elapsed_ms) < 2500) {
      throw new HttpError(400, 'Não foi possível concluir. Recarregue a página e tente novamente.', 'SPAM_CHECK');
    }
    const settings = await getSettings();
    const input = parsePublicBooking(body, settings);
    const phoneLimit = rateLimit('booking-phone:' + input.whatsapp, 6, 24 * 60 * 60 * 1000);
    if (!phoneLimit.ok) throw new HttpError(429, 'Este número já fez vários agendamentos hoje. Fale com a clínica pelo WhatsApp.', 'RATE_LIMIT');

    const booking = await createBooking(input, { now: now(), ipHash: hashIp(ip, config.sessionSecret) });
    const fresh = await getSettings();
    json(req, res, booking.replay ? 200 : 201, { ok: true, replay: booking.replay, booking: confirmationView(booking, fresh) });

    if (!booking.replay) {
      const cookies = parseCookies(req);
      sendConversion(booking, {
        ip,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
        fbp: cookies._fbp,
        fbc: cookies._fbc,
        fbclid: input.attribution.fbclid,
        landingPage: input.attribution.landing_page,
        adsConsent: input.adsConsent,
      }).catch((err) => console.error('[meta] falha no envio:', err.message));
    }
  });

  router.post('/api/waitlist', async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimit('waitlist:' + ip, 5, 60 * 60 * 1000).ok) throw new HttpError(429, 'Muitas tentativas. Tente mais tarde.', 'RATE_LIMIT');
    const settings = await getSettings();
    if (!settings.booking.waitlist_enabled) throw new HttpError(409, 'A lista de espera está fechada no momento.', 'WAITLIST_CLOSED');
    const body = await readJson(req);
    if (body.website) throw new HttpError(400, 'Não foi possível concluir.', 'SPAM_CHECK');
    const name = cleanName(body.name);
    const whatsapp = cleanWhatsapp(body.whatsapp);
    let age = null;
    if (body.age !== undefined && body.age !== null && body.age !== '') age = cleanAge(body.age, {});
    if (body.consent_data !== true) throw new ValidationError('consent_data', 'Autorize o uso dos dados para entrarmos em contato.');
    const { rows: existing } = await q(`SELECT id FROM waitlist WHERE whatsapp = $1 AND status = 'AGUARDANDO' AND anonymized_at IS NULL`, [whatsapp]);
    if (existing.length) return json(req, res, 200, { ok: true, already: true });
    const { rows } = await q('INSERT INTO waitlist (name, age, whatsapp) VALUES ($1,$2,$3) RETURNING id', [name, age, whatsapp]);
    await q(
      `INSERT INTO consents (waitlist_id, purpose, granted, text_version, ip_hash) VALUES ($1,'agendamento',true,$2,$3),($1,'mensagens_promocionais',$4,$2,$3)`,
      [rows[0].id, String(settings.privacy.consent_text_version), hashIp(ip, config.sessionSecret), body.consent_marketing === true],
    );
    json(req, res, 201, { ok: true });
  });

  // Avisos de agendamentos recentes: somente pacientes reais que autorizaram exibir o primeiro nome.
  // Dados mínimos: primeiro nome, dia relativo e hora. Nada de sobrenome, idade, telefone ou protocolo.
  router.get('/api/activity', async (req, res) => {
    const settings = await getSettings();
    if (!settings.social_proof.enabled) return json(req, res, 200, { items: [] });
    const hours = Math.min(168, Math.max(1, Number(settings.social_proof.max_age_hours) || 48));
    const { rows } = await q(
      `SELECT p.name, a.date, a.time, extract(epoch FROM (now() - a.created_at))::int AS seconds
         FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.social_proof_ok AND a.status <> 'CANCELADO' AND p.anonymized_at IS NULL
          AND a.created_at > now() - ($1 || ' hours')::interval
        ORDER BY a.created_at DESC LIMIT 12`,
      [String(hours)],
    );
    const today = todayISO(now());
    let items = rows.map((r) => ({
      firstName: r.name.split(' ')[0],
      when: activityWhen(r.date, r.time, today),
      minutesAgo: Math.max(1, Math.round(r.seconds / 60)),
    }));
    // Exemplos fictícios apenas fora de produção e só se ligados explicitamente, sempre marcados como demonstração.
    if (!items.length && !config.isProd && process.env.DEMO_ACTIVITY === 'true') {
      items = [
        { firstName: 'Mariana', when: 'para quinta-feira, às 15h', minutesAgo: 3, demo: true },
        { firstName: 'João', when: 'para sábado, às 9h', minutesAgo: 12, demo: true },
        { firstName: 'Carla', when: 'para amanhã, às 11h', minutesAgo: 25, demo: true },
      ];
    }
    json(req, res, 200, { items }, { 'cache-control': 'public, max-age=30' });
  });

}

/** Rotas presentes nos dois serviços (site e painel). */
export function registerShared(router, { role }) {
  router.get('/media/logo', async (req, res) => {
    const { rows } = await q("SELECT mime, data FROM media WHERE key = 'logo'");
    if (!rows[0]) throw new HttpError(404, 'Logo não configurada.', 'NOT_FOUND');
    send(req, res, 200, rows[0].data, { 'content-type': rows[0].mime, 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'" });
  });

  router.get('/robots.txt', (req, res) => {
    // Painel: nada indexável. Site: a página de agendamento e a política; as APIs ficam de fora.
    // O painel não é citado no robots do site público para não divulgar sua existência.
    const body = role === 'admin'
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nAllow: /\nDisallow: /api/\n${config.appUrl ? `Sitemap: ${config.appUrl}/sitemap.xml\n` : ''}`;
    send(req, res, 200, body, { 'content-type': 'text/plain; charset=utf-8' });
  });

  if (role !== 'admin') {
    router.get('/sitemap.xml', (req, res) => {
      const base = config.appUrl || '';
      send(req, res, 200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/privacidade</loc></url></urlset>`, { 'content-type': 'application/xml' });
    });
  }

  router.get('/healthz', async (req, res) => {
    await q('SELECT 1');
    json(req, res, 200, { ok: true });
  });
}

/** "para hoje, às 15h" · "para amanhã, às 11h30" · "para sábado, às 9h" */
export function activityWhen(date, time, today) {
  const [h, m] = String(time).split(':');
  const hour = `${Number(h)}h${m && m !== '00' ? m : ''}`;
  let day;
  if (date === today) day = 'hoje';
  else if (date === addDays(today, 1)) day = 'amanhã';
  else day = formatLongDate(date).split(',')[0].toLowerCase();
  return `para ${day}, às ${hour}`;
}

export { renderNotFound, BookingError };
