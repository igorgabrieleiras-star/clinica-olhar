-- Acompanhamento operacional interno do funil (próprio, anônimo e sem cookies):
-- uma sessão aleatória por aba (sessionStorage), etapas do formulário e origem da visita (UTM).
-- Nunca guarda nome, idade, WhatsApp, IP nem identificadores de clique — só se a visita veio de anúncio (from_ad).
CREATE TABLE funnel_events (
  id              bigserial PRIMARY KEY,
  session_id      uuid NOT NULL,
  event           text NOT NULL CHECK (event IN ('landing','name_started','age_step','whatsapp_step','date_step','time_step','booking_confirmed')),
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  utm_term        text,
  from_ad         boolean NOT NULL DEFAULT false,
  referrer_host   text,
  device          text CHECK (device IN ('mobile','desktop')),
  appointment_id  bigint REFERENCES appointments(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Cada etapa conta uma vez por sessão (voltar e avançar não duplica).
CREATE UNIQUE INDEX funnel_events_session_event_idx ON funnel_events (session_id, event);
CREATE INDEX funnel_events_created_idx ON funnel_events (created_at);
