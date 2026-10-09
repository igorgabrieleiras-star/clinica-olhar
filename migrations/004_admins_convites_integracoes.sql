-- Administradores com níveis de acesso, convites por link e proteção da área de Integrações.
-- Não altera agendamentos, pacientes nem configurações existentes.

-- 1) Níveis de acesso: "principal" (acesso completo) e "admin" (operação do dia a dia).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';
ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('principal', 'admin'));
ALTER TABLE admins ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS invited_by bigint REFERENCES admins(id) ON DELETE SET NULL;

-- O administrador mais antigo (o que já usa o painel) passa a ser o administrador principal.
UPDATE admins SET role = 'principal'
 WHERE id = (SELECT id FROM admins ORDER BY created_at, id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM admins WHERE role = 'principal');

-- 2) Convites: o token nunca é gravado, somente o hash SHA-256. Uso único e validade de 24 horas.
CREATE TABLE admin_invites (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('principal', 'admin')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_by  bigint REFERENCES admins(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX admin_invites_email_idx ON admin_invites (lower(email));

-- 3) Sessões: momento do login (autenticação recente) e desbloqueio temporário das Integrações.
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS integrations_until timestamptz;

-- 4) Senha exclusiva da área de Integrações (uma só, definida pelo administrador principal).
CREATE TABLE integration_security (
  id               integer PRIMARY KEY CHECK (id = 1),
  password_hash    text NOT NULL,
  recovery_hash    text NOT NULL,
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  created_by       bigint REFERENCES admins(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
