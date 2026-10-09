import { randomUUID, createHash } from 'node:crypto';
import { tx, q } from './db.js';
import { publicCandidateDates, formatLongDate, isISODate } from './dates.js';
import { dayAvailability, ensureSlots, effectiveRule } from './availability.js';
import { getSettings } from './settings.js';
import { cleanName, cleanAge, cleanWhatsapp, cleanTime, optText, ValidationError, isUuid, formatWhatsapp } from './validate.js';

export class BookingError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function dateLockKey(date) {
  return Number(date.replaceAll('-', '')); // 20261009
}

export function hashIp(ip, secret) {
  if (!ip) return null;
  return createHash('sha256').update(secret + '|' + ip).digest('hex').slice(0, 32);
}

/** Normaliza o nome para comparar pacientes (sem acentos, minúsculas). */
function nameKey(name) {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Valida o corpo do agendamento vindo do site. Lança ValidationError. */
export function parsePublicBooking(body, settings) {
  const b = body || {};
  const name = cleanName(b.name);
  const age = cleanAge(b.age, settings.booking);
  let guardian = null;
  if (age < 18 && settings.booking.minor_rule === 'guardian_required') {
    guardian = cleanName(b.guardian_name, 'guardian_name');
    if (b.guardian_ack !== true) {
      throw new ValidationError('guardian_ack', 'Confirme que o paciente estará acompanhado pelo responsável.');
    }
  }
  const whatsapp = cleanWhatsapp(b.whatsapp);
  if (b.consent_data !== true) {
    throw new ValidationError('consent_data', 'Para agendar, autorize o uso dos dados para o seu atendimento.');
  }
  if (!isISODate(b.date)) throw new ValidationError('date', 'Escolha uma data.');
  const time = cleanTime(b.time);
  const idem = isUuid(b.idempotency_key) ? b.idempotency_key : null;
  const u = b.attribution || {};
  return {
    name,
    age,
    guardian,
    whatsapp,
    date: b.date,
    time,
    idempotencyKey: idem,
    marketing: b.consent_marketing === true,
    socialProof: b.consent_social === true,
    adsConsent: b.ads_consent === true,
    attribution: {
      utm_source: optText(u.utm_source, 150),
      utm_medium: optText(u.utm_medium, 150),
      utm_campaign: optText(u.utm_campaign, 200),
      utm_content: optText(u.utm_content, 200),
      utm_term: optText(u.utm_term, 200),
      fbclid: optText(u.fbclid, 500),
      referrer: optText(u.referrer, 500),
      landing_page: optText(u.landing_page, 500),
    },
  };
}

/**
 * Cria o agendamento com controle de concorrência:
 * - trava a data (advisory lock) para serializar reservas do mesmo dia,
 * - recalcula a ocupação real dentro da transação,
 * - só grava se ainda houver vaga no horário e no limite diário.
 */
export async function createBooking(input, { now = new Date(), ipHash = null, admin = false } = {}) {
  // Reenvio do mesmo pedido (ex.: conexão caiu) devolve o mesmo agendamento, sem duplicar.
  if (input.idempotencyKey) {
    const existing = await findByIdempotency(input.idempotencyKey);
    if (existing) return { ...existing, replay: true };
  }

  if (!admin) {
    const allowed = publicCandidateDates(now).map((c) => c.date);
    if (!allowed.includes(input.date)) {
      throw new BookingError('DATE_NOT_ALLOWED', 'As datas disponíveis foram atualizadas. Escolha uma das opções exibidas.', 422);
    }
    const settings = await getSettings();
    if (!settings.booking.enabled) throw new BookingError('BOOKING_CLOSED', 'Os agendamentos online estão fechados no momento.', 409);
  }

  const settings = await getSettings();
  try {
    const result = await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [dateLockKey(input.date)]);
      if (input.idempotencyKey) {
        // Dois envios simultâneos do mesmo pedido: o segundo espera o primeiro e devolve o mesmo agendamento.
        const { rows: done } = await c.query('SELECT 1 FROM appointments WHERE idempotency_key = $1', [input.idempotencyKey]);
        if (done.length) return { replayLookup: true };
      }
      const rule = await effectiveRule(input.date, c);
      if (!rule.open && !admin) throw new BookingError('DATE_UNAVAILABLE', 'Esta data não está disponível para agendamento.');
      await ensureSlots(input.date, c);

      const day = await dayAvailability(input.date, c);
      const slot = day.slots.find((s) => s.time === input.time);
      if (!slot || slot.blocked) throw new BookingError('SLOT_UNAVAILABLE', 'Este horário não está disponível. Escolha outro.');
      if (slot.free <= 0) throw new BookingError('SLOT_FULL', 'Este horário acabou de esgotar. Escolha outro horário.');

      // Paciente: reaproveita o cadastro com mesmo WhatsApp e mesmo nome.
      const { rows: candidates } = await c.query(
        'SELECT id, name FROM patients WHERE whatsapp = $1 AND anonymized_at IS NULL ORDER BY id',
        [input.whatsapp],
      );
      let patient = candidates.find((p) => nameKey(p.name) === nameKey(input.name));
      if (patient) {
        await c.query('UPDATE patients SET name = $2, age = $3, guardian_name = $4, updated_at = now() WHERE id = $1', [
          patient.id, input.name, input.age, input.guardian,
        ]);
      } else {
        const { rows } = await c.query(
          'INSERT INTO patients (name, age, whatsapp, guardian_name) VALUES ($1,$2,$3,$4) RETURNING id',
          [input.name, input.age, input.whatsapp, input.guardian],
        );
        patient = rows[0];
      }

      const { rows: dup } = await c.query(
        `SELECT protocol FROM appointments WHERE patient_id = $1 AND date = $2 AND status <> 'CANCELADO'`,
        [patient.id, input.date],
      );
      if (dup.length) {
        throw new BookingError('DUPLICATE', 'Já existe um agendamento com este nome e WhatsApp para esta data. Se precisar mudar o horário, fale com a clínica pelo WhatsApp.');
      }

      const eventId = randomUUID();
      const { rows: seq } = await c.query(`SELECT 'OLH-' || lpad(nextval('protocol_seq')::text, 6, '0') AS protocol`);
      const protocol = seq[0].protocol;
      const { rows: ins } = await c.query(
        `INSERT INTO appointments (patient_id, protocol, slot_id, date, time, origin, event_id, idempotency_key, social_proof_ok, ads_consent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
        [patient.id, protocol, slot.id, input.date, input.time, admin ? 'admin' : 'site', eventId, input.idempotencyKey, !!input.socialProof, !!input.adsConsent],
      );
      const appt = ins[0];

      if (!admin) {
        const a = input.attribution || {};
        await c.query(
          `INSERT INTO attributions (appointment_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, referrer, landing_page)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [appt.id, a.utm_source, a.utm_medium, a.utm_campaign, a.utm_content, a.utm_term, a.fbclid, a.referrer, a.landing_page],
        );
        const version = String(settings.privacy.consent_text_version || '1');
        const consents = [
          ['agendamento', true],
          ['mensagens_promocionais', !!input.marketing],
          ['exibir_primeiro_nome', !!input.socialProof],
          ['cookies_anuncios', !!input.adsConsent],
        ];
        if (input.guardian) consents.push(['responsavel_menor', true]);
        for (const [purpose, granted] of consents) {
          await c.query(
            `INSERT INTO consents (patient_id, appointment_id, purpose, granted, text_version, ip_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
            [patient.id, appt.id, purpose, granted, version, ipHash],
          );
        }
      }

      return {
        id: appt.id,
        protocol,
        eventId,
        patientId: patient.id,
        name: input.name,
        age: input.age,
        guardian: input.guardian,
        whatsapp: input.whatsapp,
        date: input.date,
        time: input.time,
        replay: false,
      };
    });
    if (result.replayLookup) return { ...(await findByIdempotency(input.idempotencyKey)), replay: true };
    return result;
  } catch (err) {
    // Corrida rara com a mesma chave de idempotência: devolve o registro já gravado.
    if (err.code === '23505' && input.idempotencyKey && /idempotency/.test(err.constraint || '')) {
      const existing = await findByIdempotency(input.idempotencyKey);
      if (existing) return { ...existing, replay: true };
    }
    if (err.code === '23505' && /patient_date/.test(err.constraint || '')) {
      throw new BookingError('DUPLICATE', 'Já existe um agendamento com este nome e WhatsApp para esta data.');
    }
    throw err;
  }
}

async function findByIdempotency(key) {
  const { rows } = await q(
    `SELECT a.id, a.protocol, a.event_id, a.date, a.time, p.id AS patient_id, p.name, p.age, p.guardian_name, p.whatsapp
       FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.idempotency_key = $1`,
    [key],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id, protocol: r.protocol, eventId: r.event_id, patientId: r.patient_id, name: r.name, age: r.age,
    guardian: r.guardian_name, whatsapp: r.whatsapp, date: r.date, time: r.time,
  };
}

/** Dados exibidos na tela de confirmação. */
export function confirmationView(b, settings) {
  return {
    protocol: b.protocol,
    eventId: b.eventId,
    name: b.name,
    age: b.age,
    guardian: b.guardian || null,
    date: b.date,
    dateLabel: formatLongDate(b.date),
    time: b.time,
    whatsapp: formatWhatsapp(b.whatsapp),
    clinic: {
      name: settings.clinic.name,
      address: settings.clinic.address || '',
      maps_url: settings.clinic.maps_url || '',
      whatsapp: settings.clinic.whatsapp || '',
    },
  };
}

/** Remarcação feita pelo administrador para qualquer data/horário existente na agenda. */
export async function rescheduleAppointment(id, date, time) {
  if (!isISODate(date)) throw new ValidationError('date', 'Data inválida.');
  cleanTime(time);
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id]);
    const appt = rows[0];
    if (!appt) throw new BookingError('NOT_FOUND', 'Agendamento não encontrado.', 404);
    if (appt.status === 'CANCELADO') throw new BookingError('CANCELLED', 'Reative o agendamento antes de remarcar.');
    await c.query('SELECT pg_advisory_xact_lock($1)', [dateLockKey(date)]);
    await ensureSlots(date, c);
    const day = await dayAvailability(date, c);
    const slot = day.slots.find((s) => s.time === time);
    if (!slot || slot.blocked) throw new BookingError('SLOT_UNAVAILABLE', 'Horário inexistente ou bloqueado nesta data.');
    const sameSlot = slot.id === appt.slot_id;
    if (!sameSlot && slot.free <= 0) throw new BookingError('SLOT_FULL', 'Este horário está lotado.');
    if (appt.date !== date) {
      const { rows: dup } = await c.query(
        `SELECT 1 FROM appointments WHERE patient_id = $1 AND date = $2 AND status <> 'CANCELADO' AND id <> $3`,
        [appt.patient_id, date, id],
      );
      if (dup.length) throw new BookingError('DUPLICATE', 'O paciente já tem um agendamento nesta data.');
    }
    await c.query('UPDATE appointments SET slot_id = $2, date = $3, time = $4, updated_at = now() WHERE id = $1', [id, slot.id, date, time]);
    return { id, from: { date: appt.date, time: appt.time }, to: { date, time } };
  });
}

/** Alteração de status. Reativar um cancelado exige vaga livre no horário. */
export async function setStatus(id, status) {
  const valid = ['NOVO', 'CONFIRMADO', 'CONTATADO', 'COMPARECEU', 'NAO_COMPARECEU', 'CANCELADO'];
  if (!valid.includes(status)) throw new ValidationError('status', 'Status inválido.');
  return tx(async (c) => {
    const { rows } = await c.query('SELECT id, status, date, slot_id, patient_id FROM appointments WHERE id = $1 FOR UPDATE', [id]);
    const appt = rows[0];
    if (!appt) throw new BookingError('NOT_FOUND', 'Agendamento não encontrado.', 404);
    if (appt.status === 'CANCELADO' && status !== 'CANCELADO') {
      await c.query('SELECT pg_advisory_xact_lock($1)', [dateLockKey(appt.date)]);
      const day = await dayAvailability(appt.date, c);
      const slot = day.slots.find((s) => s.id === appt.slot_id);
      if (!slot || slot.free <= 0) throw new BookingError('SLOT_FULL', 'Não há vaga livre no horário original. Remarque o paciente.');
      const { rows: dup } = await c.query(
        `SELECT 1 FROM appointments WHERE patient_id = $1 AND date = $2 AND status <> 'CANCELADO' AND id <> $3`,
        [appt.patient_id, appt.date, id],
      );
      if (dup.length) throw new BookingError('DUPLICATE', 'O paciente já tem outro agendamento ativo nesta data.');
    }
    await c.query(
      `UPDATE appointments SET status = $2, updated_at = now(),
              cancelled_at = CASE WHEN $2 = 'CANCELADO' THEN now() ELSE NULL END
        WHERE id = $1`,
      [id, status],
    );
    return { id, from: appt.status, to: status };
  });
}
