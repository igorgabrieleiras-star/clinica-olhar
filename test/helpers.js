// Banco de testes isolado. Use TEST_DATABASE_URL para apontar para outro servidor.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://olhar:olhar_dev_pw@127.0.0.1:5432/olhar_test';
process.env.SESSION_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';

const { pool, q } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { saveSection, invalidateSettings } = await import('../src/settings.js');

export async function resetDb() {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  invalidateSettings();
  await saveSection('booking', { enabled: true, waitlist_enabled: true, scarcity_threshold: 20, min_age: null, max_age: null, minor_rule: 'guardian_required' });
  // Agenda fixa de teste (independe do expediente padrão): seg–sex 08–16 com pausa 11–13, sábado 08–12, domingo fechado, 5 vagas.
  await q(`UPDATE schedule_rules SET is_open = (weekday <> 0), open_time = '08:00',
             close_time = CASE WHEN weekday = 6 THEN '12:00'::time ELSE '16:00'::time END,
             lunch_start = CASE WHEN weekday BETWEEN 1 AND 5 THEN '11:00'::time END,
             lunch_end = CASE WHEN weekday BETWEEN 1 AND 5 THEN '13:00'::time END,
             interval_minutes = 30, capacity = 5`);
}

/** Desliga HOJE nos testes que verificam só a regra de amanhã/sábado. */
export async function onlyTomorrowAndSaturday() {
  const { getSettings } = await import('../src/settings.js');
  const s = await getSettings({ fresh: true });
  await saveSection('booking', { ...s.booking, today_enabled: false });
}

/** Uma quinta-feira às 10h em Manaus (14h UTC). */
export const THURSDAY = new Date('2026-10-08T14:00:00Z');

let n = 0;
export function person(overrides = {}) {
  n++;
  const suffix = String(10000000 + n).slice(-8);
  return {
    name: `Paciente ${'abcdefghijklmnopqrstuvwxyz'[n % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(n / 26) % 26]}`,
    age: 40,
    guardian: null,
    whatsapp: '929' + suffix,
    date: '2026-10-09',
    time: '08:00',
    idempotencyKey: null,
    marketing: false,
    socialProof: false,
    adsConsent: false,
    attribution: {},
    ...overrides,
  };
}

export { pool, q };
