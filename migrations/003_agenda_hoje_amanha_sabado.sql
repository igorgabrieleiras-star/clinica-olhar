-- Atualização da agenda: HOJE / AMANHÃ / PRÓXIMO SÁBADO, expediente 09:00–17:00 e agendamentos abertos por padrão.
-- Só altera o que nenhum administrador mudou pelo painel (verificado no registro de auditoria).

-- 1) Expediente 09:00–17:00 em todos os dias (domingo pode ser bloqueado no painel), sem pausa, intervalos de 30 min.
UPDATE schedule_rules
   SET is_open = true, open_time = '09:00', close_time = '17:00', lunch_start = NULL, lunch_end = NULL,
       interval_minutes = 30, updated_at = now()
 WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'schedule_rules_updated' AND admin_id IS NOT NULL);

-- Horários futuros gerados pela regra antiga, sem pacientes e não ajustados à mão, são recriados sob demanda.
DELETE FROM slots s
 WHERE s.date >= (now() AT TIME ZONE 'America/Manaus')::date
   AND NOT s.manual
   AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'schedule_rules_updated' AND admin_id IS NOT NULL);

-- 2) Agendamentos abertos e novas opções ativadas por padrão, salvo decisão de um administrador.
UPDATE settings
   SET value = value || '{"enabled": true, "today_enabled": true, "tomorrow_enabled": true, "saturday_enabled": true, "min_lead_minutes": 60, "same_day_cap": 3, "scarcity_threshold": 10}'::jsonb,
       updated_at = now()
 WHERE key = 'booking'
   AND NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'settings_updated' AND entity_id = 'booking' AND admin_id IS NOT NULL);
