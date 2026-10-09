-- Estado informado por cada serviço (ex.: o site público avisa se o token da API de Conversões está configurado).
-- Evita copiar segredos do site para o painel só para exibir um indicador.
CREATE TABLE service_status (
  service     text PRIMARY KEY CHECK (service IN ('public')),
  info        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
