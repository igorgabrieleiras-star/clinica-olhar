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

const WEEKDAY_TAG = ['DOMINGO', 'SEGUNDA', 'TERÇA', 'QUARTA', 'QUINTA', 'SEXTA', 'SÁBADO'];

/**
 * Janela de agendamento: SEMANA ATUAL + PRÓXIMA SEMANA, de segunda a sábado (domingo nunca), no fuso de Manaus.
 * - A semana vai de segunda a sábado. Dias que já passaram ficam de fora.
 * - Domingo: a "semana atual" é a que começa amanhã (segunda) e a próxima vem em seguida.
 * - Calculada pela data de hoje: ao começar uma nova semana, a seguinte entra sozinha na janela.
 * flags.today === false tira o dia de hoje (agendamentos no mesmo dia desligados no painel).
 * Retorna em ordem cronológica: [{ date, kinds, kind, tag, isToday, isSaturday, week }]
 */
export function bookingWindow(now = new Date()) {
  const today = todayISO(now);
  const dow = weekdayOf(today);
  const monday = dow === 0 ? addDays(today, 1) : addDays(today, 1 - dow);
  return { today, start: monday < today ? today : monday, end: addDays(monday, 12), monday };
}

export function publicCandidateDates(now = new Date(), flags = {}) {
  const { today, monday, end } = bookingWindow(now);
  const tomorrow = addDays(today, 1);
  const out = [];
  for (let d = monday; d <= end; d = addDays(d, 1)) {
    if (d < today) continue; // dias que já passaram
    if (weekdayOf(d) === 0) continue; // domingo nunca tem atendimento
    if (d === today && flags.today === false) continue;
    const kind = d === today ? 'hoje' : d === tomorrow ? 'amanha' : 'semana';
    out.push({
      date: d,
      kinds: [kind],
      kind,
      tag: kind === 'hoje' ? 'HOJE' : kind === 'amanha' ? 'AMANHÃ' : WEEKDAY_TAG[weekdayOf(d)],
      isToday: d === today,
      isSaturday: weekdayOf(d) === 6,
      week: d <= addDays(monday, 5) ? 1 : 2,
    });
  }
  return out;
}

/** Próximo sábado depois de hoje (no sábado, o da semana seguinte) — usado nos filtros do painel. */
export function nextSaturdayISO(now = new Date()) {
  const today = todayISO(now);
  const dow = weekdayOf(today);
  return addDays(today, (6 - dow + 7) % 7 || 7);
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
