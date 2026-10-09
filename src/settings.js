import { q, newClient } from './db.js';

// Valores padrão. Tudo é editável no painel administrativo.
// Endereço, telefone e documentos exigidos ficam VAZIOS até a clínica preencher — nada é inventado.
export const DEFAULTS = {
  clinic: {
    name: 'Clínica Olhar',
    whatsapp: '', // somente dígitos com DDD, ex.: 92999999999
    address: '',
    maps_url: '',
    opening_hours_text: '',
  },
  booking: {
    enabled: true, // agendamentos abertos por padrão; o painel pode fechar a qualquer momento
    today_enabled: true, // HOJE (somente horários futuros com a antecedência mínima)
    tomorrow_enabled: true, // AMANHÃ
    saturday_enabled: true, // PRÓXIMO SÁBADO
    min_lead_minutes: 60, // antecedência mínima para agendar no mesmo dia
    same_day_cap: 3, // teto de pacientes por horário para HOJE (vazio = sem teto extra); nunca passa da capacidade real
    waitlist_enabled: true,
    scarcity_threshold: 10, // até este número o selo mostra "Últimas N vagas"
    min_age: null,
    max_age: null,
    minor_rule: 'guardian_required', // guardian_required | allowed | blocked
  },
  social_proof: {
    enabled: false,
    max_age_hours: 48,
  },
  meta: {
    pixel_enabled: false,
    pixel_id: '',
    capi_enabled: false,
    require_consent: true,
    schedule_event: false,
  },
  privacy: {
    retention_days: 365,
    current_version: '1',
    consent_text_version: '1',
  },
  content: {
    vision_title: 'Por que cuidar da visão?',
    vision_paragraphs: [
      'Muitas alterações na visão aparecem aos poucos. A gente se acostuma a aproximar o celular, apertar os olhos para ler placas ou sentir dor de cabeça no fim do dia — e nem percebe que algo mudou.',
      'A avaliação periódica ajuda a identificar a necessidade de correção visual e a orientar o próximo passo com um profissional. Crianças em idade escolar, pessoas acima dos 40 anos e quem passa muitas horas em telas costumam se beneficiar de avaliações regulares.',
      'O exame não substitui o acompanhamento médico quando há sintomas como dor nos olhos, perda súbita de visão, olho vermelho persistente ou visão de flashes. Nesses casos, procure atendimento médico.',
    ],
  },
};

let cache = null;
let cacheAt = 0;

function merge(base, extra) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 5000) return cache;
  const { rows } = await q('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = merge(DEFAULTS[key], stored[key]);
  cache = out;
  cacheAt = Date.now();
  return out;
}

export async function saveSection(key, value, client = null) {
  if (!(key in DEFAULTS)) throw new Error('Seção de configuração desconhecida: ' + key);
  const runner = client || { query: q };
  await runner.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  // Avisa os outros serviços (site público) para recarregar na hora. Dentro de transação, sai no COMMIT.
  await runner.query("SELECT pg_notify('olhar_settings', $1)", [key]);
  invalidateSettings();
}

/**
 * Escuta as alterações feitas pelo painel (outro processo) e invalida o cache local imediatamente.
 * Se a conexão cair, reconecta; enquanto isso, o cache de 5 s garante que nada fica desatualizado por muito tempo.
 */
export function listenForSettingsChanges({ log = console.log } = {}) {
  let stopped = false;
  let client = null;
  const connect = async () => {
    if (stopped) return;
    let retried = false;
    const retry = () => {
      if (retried || stopped) return;
      retried = true;
      invalidateSettings();
      setTimeout(connect, 5000).unref();
    };
    client = newClient();
    client.on('notification', () => invalidateSettings());
    client.on('error', (err) => { console.error('[config] escuta interrompida:', err.message); retry(); });
    client.on('end', retry);
    try {
      await client.connect();
      await client.query('LISTEN olhar_settings');
      log('[config] ouvindo alterações do painel em tempo real.');
    } catch (err) {
      console.error('[config] não foi possível escutar alterações:', err.message);
      client.end().catch(() => {});
      retry();
    }
  };
  connect();
  return () => { stopped = true; client?.end().catch(() => {}); };
}

export function invalidateSettings() {
  cache = null;
}
