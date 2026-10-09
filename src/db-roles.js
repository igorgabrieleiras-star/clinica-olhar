// Permissões do usuário de banco do SITE PÚBLICO (princípio do menor privilégio).
// O painel usa o usuário dono do banco; o site público conecta com um usuário que só consegue:
//   - ler agenda, configurações, FAQ, política e logo;
//   - criar pacientes, agendamentos, consentimentos, atribuição e lista de espera;
//   - atualizar nome/idade/responsável de um paciente que agenda de novo.
// Ele NÃO consegue: ler administradores, sessões, auditoria, consentimentos, atribuições ou observações;
// apagar qualquer registro; alterar vagas, horários, bloqueios, status ou configurações; criar tabelas.
// Mesmo que o processo público fosse comprometido, o banco recusaria operações administrativas.

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error(`Nome de usuário de banco inválido: ${s}`);
  return `"${s}"`;
};

export function publicGrantStatements(role) {
  const r = ident(role);
  return [
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${r}`,
    `REVOKE CREATE ON SCHEMA public FROM ${r}`,
    `GRANT USAGE ON SCHEMA public TO ${r}`,
    // Somente leitura
    `GRANT SELECT ON settings, schedule_rules, date_overrides, faq, legal_texts, media, schema_migrations TO ${r}`,
    // Horários: lê a ocupação e materializa os horários de uma data pela primeira vez (sem alterar existentes)
    `GRANT SELECT, INSERT ON slots TO ${r}`,
    // Pacientes: só as colunas necessárias para reconhecer quem agenda de novo
    `GRANT SELECT (id, name, age, whatsapp, guardian_name, anonymized_at) ON patients TO ${r}`,
    `GRANT INSERT (name, age, whatsapp, guardian_name) ON patients TO ${r}`,
    `GRANT UPDATE (name, age, guardian_name, updated_at) ON patients TO ${r}`,
    // Agendamentos: cria e consulta ocupação/duplicidade; sem ler observações internas nem alterar status
    `GRANT SELECT (id, patient_id, protocol, slot_id, date, time, status, event_id, idempotency_key, social_proof_ok, created_at) ON appointments TO ${r}`,
    `GRANT INSERT (patient_id, protocol, slot_id, date, time, origin, event_id, idempotency_key, social_proof_ok, ads_consent) ON appointments TO ${r}`,
    // Somente escrita (o site nunca relê esses dados)
    `GRANT INSERT ON attributions, consents TO ${r}`,
    `GRANT SELECT (id, whatsapp, status, anonymized_at) ON waitlist TO ${r}`,
    `GRANT INSERT (name, age, whatsapp) ON waitlist TO ${r}`,
    // Registro de envios à API de Conversões (deduplicação)
    `GRANT SELECT, INSERT ON meta_events TO ${r}`,
    `GRANT UPDATE (status, response) ON meta_events TO ${r}`,
    // Estado do próprio serviço (token da API de Conversões configurado, último início)
    `GRANT SELECT, INSERT, UPDATE ON service_status TO ${r}`,
    // Sequências usadas nos INSERTs acima (protocolo e IDs)
    `GRANT USAGE ON SEQUENCE protocol_seq, patients_id_seq, appointments_id_seq, slots_id_seq, consents_id_seq, waitlist_id_seq, meta_events_id_seq TO ${r}`,
  ];
}

/** Reaplica as permissões se o usuário do site existir. Chamado a cada migração. */
export async function applyPublicGrants(client, role, log = console.log) {
  const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (!rows.length) return false;
  for (const sql of publicGrantStatements(role)) await client.query(sql);
  log(`[banco] permissões do site público aplicadas ao usuário ${role}.`);
  return true;
}

/** Cria (ou atualiza a senha de) o usuário do site e aplica as permissões. */
export async function createPublicRole(client, role, password) {
  const r = ident(role);
  const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const lit = `'${String(password).replace(/'/g, "''")}'`;
  if (rows.length) await client.query(`ALTER ROLE ${r} WITH LOGIN PASSWORD ${lit}`);
  else await client.query(`CREATE ROLE ${r} WITH LOGIN PASSWORD ${lit}`);
  const { rows: db } = await client.query('SELECT current_database() AS d');
  await client.query(`GRANT CONNECT ON DATABASE "${db[0].d.replace(/"/g, '""')}" TO ${r}`);
  await applyPublicGrants(client, role, () => {});
}
