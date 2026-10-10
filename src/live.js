// Atualização ao vivo do painel: escuta o canal olhar_appointments (gatilho no banco) e avisa os painéis
// abertos por Server-Sent Events. A notificação carrega só um aviso de "mudou" — os dados são buscados
// pela própria tela, com a sessão e as permissões do administrador.
import { newClient } from './db.js';

const subscribers = new Set();
let started = false;
let stopped = false;
let current = null;
let timer = null;

function broadcast() {
  clearTimeout(timer);
  // Agrupa rajadas (ex.: várias alterações seguidas) em um único aviso.
  timer = setTimeout(() => { for (const fn of subscribers) { try { fn(); } catch { /* conexão encerrada */ } } }, 400);
  timer.unref?.();
}

function start() {
  if (started) return;
  started = true;
  const connect = async () => {
    if (stopped) return;
    let retried = false;
    const retry = () => { if (retried || stopped) return; retried = true; setTimeout(connect, 5000).unref(); };
    const client = newClient();
    current = client;
    client.on('notification', broadcast);
    client.on('error', (err) => { console.error('[ao vivo] escuta interrompida:', err.message); retry(); });
    client.on('end', retry);
    try {
      await client.connect();
      await client.query('LISTEN olhar_appointments');
    } catch (err) {
      console.error('[ao vivo] não foi possível escutar agendamentos:', err.message);
      client.end().catch(() => {});
      retry();
    }
  };
  connect();
}

/** Registra um painel aberto; retorna a função para cancelar. */
export function subscribeAppointments(fn) {
  start();
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
export const liveSubscribers = () => subscribers.size;

/** Encerra a escuta (usado ao desligar o serviço e nos testes). */
export function stopAppointmentsListener() {
  stopped = true;
  clearTimeout(timer);
  subscribers.clear();
  current?.end().catch(() => {});
}
