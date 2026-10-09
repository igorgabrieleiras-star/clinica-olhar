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
 * Datas que o fluxo público pode oferecer: HOJE, AMANHÃ e o PRÓXIMO SÁBADO (cada uma pode ser desligada no painel).
 * - Datas iguais aparecem uma vez só (sexta-feira: amanhã já é sábado → "AMANHÃ · SÁBADO").
 * - Sábado: hoje é sábado, amanhã é domingo e o "próximo sábado" é o da semana seguinte.
 * Retorna em ordem cronológica: [{ date, kinds: ['hoje'|'amanha'|'sabado'], kind, tag, isToday, isSaturday }]
 */
export function publicCandidateDates(now = new Date(), flags = {}) {
  const on = { today: flags.today !== false, tomorrow: flags.tomorrow !== false, saturday: flags.saturday !== false };
  const today = todayISO(now);
  const tomorrow = addDays(today, 1);
  const dow = weekdayOf(today);
  const daysToSaturday = (6 - dow + 7) % 7 || 7; // o "próximo sábado" nunca é hoje
  const saturday = addDays(today, daysToSaturday);
  const map = new Map();
  const add = (date, kind) => { if (!map.has(date)) map.set(date, []); map.get(date).push(kind); };
  if (on.today) add(today, 'hoje');
  if (on.tomorrow) add(tomorrow, 'amanha');
  if (on.saturday) add(saturday, 'sabado');
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, kinds]) => ({
    date,
    kinds,
    kind: kinds[0],
    tag: candidateTag(kinds, dow),
    isToday: date === today,
    isSaturday: weekdayOf(date) === 6,
  }));
}

function candidateTag(kinds, todayDow) {
  const names = { hoje: 'HOJE', amanha: 'AMANHÃ', sabado: todayDow === 6 ? 'PRÓXIMO SÁBADO' : 'SÁBADO' };
  return kinds.map((k) => names[k]).join(' · ');
}

/** Primeiro horário permitido hoje: agora + antecedência mínima (HH:MM). null se já passou do fim do dia. */
export function earliestTimeToday(now = new Date(), leadMinutes = 60) {
  const min = timeToMinutes(nowTimeHM(now)) + Math.max(0, Number(leadMinutes) || 0);
  return min >= 24 * 60 ? null : minutesToTime(min);
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
