-- Clínica Olhar — estrutura inicial

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Regra padrão de atendimento por dia da semana (0 = domingo ... 6 = sábado)
CREATE TABLE schedule_rules (
  weekday           smallint PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  is_open           boolean  NOT NULL DEFAULT true,
  open_time         time     NOT NULL DEFAULT '08:00',
  close_time        time     NOT NULL DEFAULT '17:00',
  lunch_start       time,
  lunch_end         time,
  interval_minutes  smallint NOT NULL DEFAULT 30 CHECK (interval_minutes BETWEEN 5 AND 240),
  capacity          smallint NOT NULL DEFAULT 5  CHECK (capacity BETWEEN 0 AND 500),
  daily_limit       integer  CHECK (daily_limit IS NULL OR daily_limit >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (close_time > open_time),
  CHECK ((lunch_start IS NULL) = (lunch_end IS NULL)),
  CHECK (lunch_start IS NULL OR lunch_end > lunch_start)
);

-- Exceções por data: bloqueio (feriados etc.) ou horário especial
CREATE TABLE date_overrides (
  date              date PRIMARY KEY,
  is_blocked        boolean NOT NULL DEFAULT false,
  reason            text,
  open_time         time,
  close_time        time,
  lunch_start       time,
  lunch_end         time,
  interval_minutes  smallint CHECK (interval_minutes IS NULL OR interval_minutes BETWEEN 5 AND 240),
  capacity          smallint CHECK (capacity IS NULL OR capacity BETWEEN 0 AND 500),
  daily_limit       integer  CHECK (daily_limit IS NULL OR daily_limit >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Disponibilidade materializada: um registro por data + horário
CREATE TABLE slots (
  id          bigserial PRIMARY KEY,
  date        date     NOT NULL,
  time        time     NOT NULL,
  capacity    smallint NOT NULL CHECK (capacity BETWEEN 0 AND 500),
  blocked     boolean  NOT NULL DEFAULT false,
  manual      boolean  NOT NULL DEFAULT false, -- editado manualmente: não é sobrescrito pelas regras
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, time)
);
CREATE INDEX slots_date_idx ON slots (date);

CREATE TABLE patients (
  id             bigserial PRIMARY KEY,
  name           text     NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  age            smallint NOT NULL CHECK (age BETWEEN 0 AND 120),
  whatsapp       text     NOT NULL CHECK (whatsapp ~ '^[0-9]{10,11}$'),
  guardian_name  text,
  anonymized_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patients_whatsapp_idx ON patients (whatsapp);

CREATE SEQUENCE protocol_seq START 1;

CREATE TABLE appointments (
  id               bigserial PRIMARY KEY,
  patient_id       bigint NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  protocol         text   NOT NULL UNIQUE,
  slot_id          bigint NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
  date             date   NOT NULL,
  time             time   NOT NULL,
  status           text   NOT NULL DEFAULT 'NOVO'
                   CHECK (status IN ('NOVO','CONFIRMADO','CONTATADO','COMPARECEU','NAO_COMPARECEU','CANCELADO')),
  origin           text   NOT NULL DEFAULT 'site' CHECK (origin IN ('site','admin')),
  event_id         uuid   NOT NULL UNIQUE,
  idempotency_key  text   UNIQUE,
  social_proof_ok  boolean NOT NULL DEFAULT false,
  ads_consent      boolean NOT NULL DEFAULT false,
  notes            text,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_slot_active_idx ON appointments (slot_id) WHERE status <> 'CANCELADO';
CREATE INDEX appointments_date_time_idx ON appointments (date, time);
CREATE INDEX appointments_created_idx ON appointments (created_at);
CREATE INDEX appointments_status_idx ON appointments (status);
-- Impede agendamentos duplicados do mesmo paciente na mesma data
CREATE UNIQUE INDEX appointments_patient_date_active_uq ON appointments (patient_id, date) WHERE status <> 'CANCELADO';

CREATE TABLE attributions (
  appointment_id  bigint PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  utm_term        text,
  fbclid          text,
  referrer        text,
  landing_page    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_texts (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('privacidade')),
  version     text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);

CREATE TABLE waitlist (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL,
  age            smallint,
  whatsapp       text NOT NULL,
  status         text NOT NULL DEFAULT 'AGUARDANDO' CHECK (status IN ('AGUARDANDO','CONTATADO','AGENDADO','DESCARTADO')),
  anonymized_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id              bigserial PRIMARY KEY,
  patient_id      bigint REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id  bigint REFERENCES appointments(id) ON DELETE CASCADE,
  waitlist_id     bigint REFERENCES waitlist(id) ON DELETE CASCADE,
  purpose         text NOT NULL CHECK (purpose IN ('agendamento','mensagens_promocionais','exibir_primeiro_nome','cookies_anuncios','responsavel_menor')),
  granted         boolean NOT NULL,
  text_version    text NOT NULL,
  ip_hash         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_patient_idx ON consents (patient_id);

CREATE TABLE admins (
  id                    bigserial PRIMARY KEY,
  email                 text NOT NULL UNIQUE,
  name                  text NOT NULL,
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_attempts       integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  id          text PRIMARY KEY, -- sha256 do token do cookie
  admin_id    bigint NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  admin_id    bigint REFERENCES admins(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meta_events (
  id              bigserial PRIMARY KEY,
  appointment_id  bigint REFERENCES appointments(id) ON DELETE CASCADE,
  event_name      text NOT NULL,
  event_id        text NOT NULL,
  status          text NOT NULL,
  response        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, event_name)
);

CREATE TABLE media (
  key         text PRIMARY KEY,
  mime        text NOT NULL,
  data        bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE faq (
  id        serial PRIMARY KEY,
  position  integer NOT NULL DEFAULT 0,
  question  text NOT NULL,
  answer    text NOT NULL DEFAULT '',
  active    boolean NOT NULL DEFAULT true
);
