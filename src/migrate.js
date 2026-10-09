import { applyPublicGrants } from './db-roles.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { pool } from './db.js';
import { DEFAULT_PRIVACY_POLICY } from './legal.js';

const DEFAULT_FAQ = [
  ['O exame de vista é realmente gratuito?', 'Sim. O exame de vista anunciado nesta página é gratuito. Você não paga nada para realizá-lo.'],
  ['Preciso comprar alguma coisa?', 'Não. O exame gratuito não depende da compra de óculos, lentes ou qualquer outro produto.'],
  ['Onde será realizado o exame?', ''], // preenchida automaticamente com o endereço configurado
  ['Posso agendar para outra pessoa?', 'Sim. Basta informar o nome e a idade da pessoa que fará o exame. Para menores de idade, informe também o nome do responsável que vai acompanhá-la.'],
  ['Posso escolher meu horário?', 'Sim. Você escolhe entre as datas disponíveis e o horário que preferir, de acordo com as vagas abertas.'],
  ['Como posso cancelar meu agendamento?', 'Envie uma mensagem para o WhatsApp da clínica informando o seu número de protocolo. Assim a vaga é liberada para outra pessoa.'],
  ['Preciso levar algum documento?', ''], // a clínica define
  ['Como meus dados serão utilizados?', 'Usamos seu nome, idade e WhatsApp somente para organizar o seu atendimento e entrar em contato sobre ele. Mensagens promocionais só são enviadas se você autorizar. Os detalhes estão na Política de Privacidade.'],
];

async function seed(client) {
  // Regras padrão (exemplo inicial — revise no painel antes de abrir os agendamentos)
  const rules = [
    [0, false, '08:00', '12:00', null, null, 30, 5],
    [1, true, '08:00', '16:00', '11:00', '13:00', 30, 5],
    [2, true, '08:00', '16:00', '11:00', '13:00', 30, 5],
    [3, true, '08:00', '16:00', '11:00', '13:00', 30, 5],
    [4, true, '08:00', '16:00', '11:00', '13:00', 30, 5],
    [5, true, '08:00', '16:00', '11:00', '13:00', 30, 5],
    [6, true, '08:00', '12:00', null, null, 30, 5],
  ];
  for (const r of rules) {
    await client.query(
      `INSERT INTO schedule_rules (weekday, is_open, open_time, close_time, lunch_start, lunch_end, interval_minutes, capacity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (weekday) DO NOTHING`,
      r,
    );
  }
  const { rows: faqCount } = await client.query('SELECT count(*)::int AS n FROM faq');
  if (faqCount[0].n === 0) {
    let pos = 0;
    for (const [qText, answer] of DEFAULT_FAQ) {
      await client.query('INSERT INTO faq (position, question, answer) VALUES ($1,$2,$3)', [pos++, qText, answer]);
    }
  }
  await client.query(
    `INSERT INTO legal_texts (kind, version, body) VALUES ('privacidade', '1', $1) ON CONFLICT DO NOTHING`,
    [DEFAULT_PRIVACY_POLICY],
  );
}

export async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const dir = path.join(ROOT, 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`[migrate] aplicada ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    await client.query('BEGIN');
    await seed(client);
    await client.query('COMMIT');
    // Mantém as permissões do usuário do site público em dia com o esquema (tabelas novas incluídas).
    await applyPublicGrants(client, config.publicDbRole, log);
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}
