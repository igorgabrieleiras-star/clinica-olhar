// Regras de data do fluxo público. Todo cálculo usa o fuso America/Manaus (UTC-4, sem horário de verão).
const TZ = 'America/Manaus';

const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const longFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long' });
const shortFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });

/** Data de hoje em Manaus no formato YYYY-MM-DD. */
export function todayISO(now = new Date()) {
  return ymd.format(now);
}

/** Hora atual em Manaus no formato HH:MM. */
export function nowTimeHM(now = new Date()) {
  return hm.format(now);
}

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = domingo ... 6 = sábado */
export function weekdayOf(iso) {
  return new Date(iso + 'T12:00:00Z').getUTCDay();
}

/**
 * Datas que o fluxo público pode oferecer: AMANHÃ e o PRÓXIMO SÁBADO.
 * - Sexta-feira: amanhã já é sábado → uma única opção.
 * - Sábado: amanhã é domingo; o sábado oferecido é o da semana seguinte.
 */
export function publicCandidateDates(now = new Date()) {
  const today = todayISO(now);
  const tomorrow = addDays(today, 1);
  const dow = weekdayOf(today);
  const daysToSaturday = (6 - dow + 7) % 7 || 7; // nunca hoje
  const saturday = addDays(today, daysToSaturday);
  if (tomorrow === saturday) return [{ date: tomorrow, kind: 'amanha', isSaturday: true }];
  return [
    { date: tomorrow, kind: 'amanha', isSaturday: false },
    { date: saturday, kind: 'sabado', isSaturday: true },
  ];
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Sexta-feira, 09 de outubro" */
export function formatLongDate(iso) {
  const parts = longFmt.formatToParts(new Date(iso + 'T12:00:00Z'));
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${capitalize(get('weekday'))}, ${get('day')} de ${get('month')}`;
}

/** "09/10" */
export function formatShortDate(iso) {
  return shortFmt.format(new Date(iso + 'T12:00:00Z'));
}

export function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
