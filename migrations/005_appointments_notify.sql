-- Atualização em tempo real do painel: cada inclusão/alteração de agendamento avisa o serviço do painel
-- (canal olhar_appointments). Envia apenas o id — nenhum dado de paciente trafega na notificação.
CREATE OR REPLACE FUNCTION notify_appointments_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('olhar_appointments', COALESCE(NEW.id, OLD.id)::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS appointments_notify ON appointments;
CREATE TRIGGER appointments_notify
AFTER INSERT OR UPDATE OR DELETE ON appointments
FOR EACH ROW EXECUTE FUNCTION notify_appointments_change();
