import http from 'node:http';
import { config } from './config.js';
import { q } from './db.js';
import { Router, HttpError, json, html, serveStatic, securityHeaders, loadAssets } from './http.js';
import { ValidationError } from './validate.js';
import { BookingError } from './booking.js';
import { registerPublic, registerShared } from './routes/public.js';
import { registerAdmin } from './routes/admin.js';
import { renderNotFound, renderAdmin, renderError } from './views.js';
import { getSettings } from './settings.js';
import { adminGate } from './admin-gate.js';

const NOINDEX = { 'x-robots-tag': 'noindex, nofollow, noarchive' };

/**
 * Monta o servidor conforme o papel:
 *  - public: só o site de agendamento. As rotas do painel NÃO são registradas — /admin e /api/admin/* não existem.
 *  - admin:  só o painel, servido na raiz. Camadas de acesso (IP, Cloudflare Access, senha extra) antes de tudo.
 *  - all:    os dois juntos, apenas para desenvolvimento local (painel em /admin).
 */
export function createApp({ role = config.role } = {}) {
  loadAssets();
  const servesPublic = role === 'public' || role === 'all';
  const servesAdmin = role === 'admin' || role === 'all';
  const router = new Router();
  if (servesPublic) registerPublic(router);
  registerShared(router, { role });
  if (servesAdmin) {
    registerAdmin(router);
    const adminPath = role === 'admin' ? '/' : '/admin';
    router.get(adminPath, (req, res) => html(req, res, 200, renderAdmin(), { ...NOINDEX, 'cache-control': 'no-store' }));
    if (role === 'admin') router.get('/admin', (req, res) => { res.writeHead(301, { location: '/' }); res.end(); });
  }
  // Cada serviço só entrega os próprios arquivos: o site não expõe o JS do painel, e vice-versa.
  const assetAllowed = (p) => (servesAdmin || !p.startsWith('/assets/admin.')) && (servesPublic || !p.startsWith('/assets/site.'));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    let pixel = false;
    // Em produção atrás de proxy/CDN, força HTTPS (o healthcheck interno continua em HTTP).
    if (config.isProd && config.trustProxy && pathname !== '/healthz' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'http') {
      res.writeHead(301, { location: (config.appUrl || `https://${req.headers.host}`) + req.url });
      res.end();
      return;
    }
    try {
      // Painel: camadas extras de acesso antes de qualquer rota ou arquivo, e nada indexável.
      if (role === 'admin') {
        for (const [k, v] of Object.entries(NOINDEX)) res.setHeader(k, v);
        if (!(await adminGate(req, res, pathname))) return;
      } else if (role === 'all' && (pathname === '/admin' || pathname.startsWith('/api/admin/') || pathname.startsWith('/assets/admin.'))) {
        for (const [k, v] of Object.entries(NOINDEX)) res.setHeader(k, v);
        if (!(await adminGate(req, res, pathname))) return;
      }

      // Cabeçalhos de segurança em todas as respostas; o Pixel só é liberado na CSP do site quando ativado.
      if (pathname === '/' && servesPublic) {
        const s = await getSettings();
        pixel = !!(s.meta.pixel_enabled && s.meta.pixel_id);
      }
      for (const [k, v] of Object.entries(securityHeaders({ pixel }))) res.setHeader(k, v);

      if ((req.method === 'GET' || req.method === 'HEAD') && assetAllowed(pathname) && serveStatic(req, res, pathname, url.searchParams)) return;
      const match = router.match(req.method, pathname);
      if (!match) {
        if (pathname.startsWith('/api/')) throw new HttpError(404, 'Endereço não encontrado.', 'NOT_FOUND');
        return html(req, res, 404, renderNotFound(), role === 'admin' ? { 'cache-control': 'no-store' } : {});
      }
      if (match.methodNotAllowed) throw new HttpError(405, 'Método não permitido.', 'METHOD_NOT_ALLOWED');
      await match.handler(req, res, { params: match.params, url });
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      const known = err instanceof HttpError || err instanceof ValidationError || err instanceof BookingError;
      if (!known) console.error(`[erro] ${req.method} ${pathname}:`, err);
      const status = known ? err.status : 500;
      const message = known ? err.message : 'Não foi possível concluir agora. Tente novamente em instantes.';
      if (pathname.startsWith('/api/')) {
        const headers = status === 429 ? { 'retry-after': '60' } : {};
        json(req, res, status, { ok: false, code: known ? err.code : 'SERVER_ERROR', field: err.field, error: message }, headers);
      } else {
        html(req, res, status, renderError(status, message));
      }
    }
  });
}

/** Anonimiza dados antigos conforme o prazo de retenção configurado. */
export async function runRetention() {
  const settings = await getSettings({ fresh: true });
  const days = Number(settings.privacy.retention_days) || 365;
  const { rowCount } = await q(
    `UPDATE patients p SET name = 'Dados excluídos', whatsapp = '00000000000', guardian_name = NULL, anonymized_at = now(), updated_at = now()
      WHERE p.anonymized_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.date > (now() AT TIME ZONE 'America/Manaus')::date - $1::int)
        AND p.created_at < now() - ($1 || ' days')::interval`,
    [days],
  );
  const { rowCount: w } = await q(
    `UPDATE waitlist SET name = 'Dados excluídos', whatsapp = '00000000000', anonymized_at = now() WHERE anonymized_at IS NULL AND created_at < now() - ($1 || ' days')::interval`,
    [days],
  );
  await q('DELETE FROM admin_sessions WHERE expires_at < now()');
  if (rowCount || w) console.log(`[retenção] anonimizados: ${rowCount} pacientes, ${w} da lista de espera`);
  return { patients: rowCount, waitlist: w };
}

export { config };
