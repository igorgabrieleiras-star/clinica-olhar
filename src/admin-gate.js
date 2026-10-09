// Camadas de acesso que ficam NA FRENTE do login do painel (somam-se a ele, não o substituem).
// Todas são verificadas no servidor, a cada requisição, antes de qualquer rota ou arquivo do painel:
//   1. Lista de IPs permitidos (ADMIN_ALLOWED_IPS) — ex.: IP fixo da clínica ou da VPN.
//   2. Cloudflare Access (ADMIN_CF_ACCESS_TEAM_DOMAIN + ADMIN_CF_ACCESS_AUD) — identidade por e-mail/Google,
//      com o token JWT assinado pela Cloudflare validado aqui (assinatura RS256, audiência, emissor e validade).
//   3. Porta de acesso HTTP Basic (ADMIN_GATE_USER + ADMIN_GATE_PASSWORD) — uma senha extra antes da tela de login.
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import net from 'node:net';
import { config } from './config.js';
import { clientIp, rateLimit, parseCookies } from './http.js';

// ---------- IPs ----------
function normalizeIp(ip) {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}
function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
export function ipAllowed(ip, list) {
  const addr = normalizeIp(ip);
  for (const entry of list) {
    if (entry.includes('/')) {
      const [range, bitsStr] = entry.split('/');
      const bits = Number(bitsStr);
      if (net.isIPv4(addr) && net.isIPv4(range) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if ((ipv4ToInt(addr) & mask) === (ipv4ToInt(range) & mask)) return true;
      } else if (net.isIPv6(addr) && net.isIPv6(range)) {
        const bl = new net.BlockList();
        bl.addSubnet(range, bits, 'ipv6');
        if (bl.check(addr, 'ipv6')) return true;
      }
    } else if (normalizeIp(entry) === addr) {
      return true;
    }
  }
  return false;
}

// ---------- Porta HTTP Basic ----------
const digest = (s) => createHash('sha256').update(String(s)).digest();
export function basicOk(req, user, password) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const okUser = timingSafeEqual(digest(decoded.slice(0, i)), digest(user));
  const okPass = timingSafeEqual(digest(decoded.slice(i + 1)), digest(password));
  return okUser && okPass;
}

// ---------- Cloudflare Access ----------
let certsCache = { keys: null, at: 0 };
let fetchCerts = async (team) => {
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('certs HTTP ' + res.status);
  return (await res.json()).keys || [];
};
/** Permite substituir a busca de chaves nos testes. */
export function setCfCertsFetcher(fn) { fetchCerts = fn; certsCache = { keys: null, at: 0 }; }

async function cfKeys(forceRefresh = false) {
  if (!forceRefresh && certsCache.keys && Date.now() - certsCache.at < 60 * 60 * 1000) return certsCache.keys;
  const keys = await fetchCerts(config.cfAccessTeamDomain);
  certsCache = { keys, at: Date.now() };
  return keys;
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Valida o JWT do Cloudflare Access. Retorna { email } ou null. */
export async function verifyCfAccess(token, { team = config.cfAccessTeamDomain, aud = config.cfAccessAud, nowMs = Date.now() } = {}) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;
  let keys = await cfKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await cfKeys(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) return null;
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key: jwk, format: 'jwk' }), b64url(parts[2]));
  if (!ok) return null;
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) return null;
  if (payload.iss !== `https://${team}`) return null;
  const nowS = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowS) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowS + 60) return null;
  return { email: payload.email || payload.sub || '' };
}

function deny(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    ...headers,
  });
  res.end(body);
}

/**
 * Aplica as camadas configuradas. Retorna true se a requisição pode seguir.
 * Quando nega, já escreve a resposta.
 */
export async function adminGate(req, res, pathname) {
  if (pathname === '/healthz') return true; // verificação de saúde da hospedagem
  const ip = clientIp(req);

  if (config.adminAllowedIps.length && !ipAllowed(ip, config.adminAllowedIps)) {
    console.warn(`[painel] acesso negado por IP: ${ip} ${req.method} ${pathname}`);
    deny(res, 404, 'Não encontrado.');
    return false;
  }

  if (config.cfAccessAud) {
    const token = req.headers['cf-access-jwt-assertion'] || parseCookies(req).CF_Authorization;
    let identity = null;
    try { identity = await verifyCfAccess(token); } catch (err) { console.error('[painel] Cloudflare Access:', err.message); }
    if (!identity) {
      console.warn(`[painel] acesso negado (Cloudflare Access): ${ip} ${req.method} ${pathname}`);
      deny(res, 403, 'Acesso restrito.');
      return false;
    }
    req.accessIdentity = identity.email;
  }

  if (config.adminGateUser) {
    if (!basicOk(req, config.adminGateUser, config.adminGatePassword)) {
      if (req.headers.authorization && !rateLimit('gate:' + ip, 20, 15 * 60 * 1000).ok) {
        deny(res, 429, 'Muitas tentativas. Aguarde 15 minutos.', { 'retry-after': '900' });
        return false;
      }
      deny(res, 401, 'Acesso restrito.', { 'www-authenticate': 'Basic realm="Clinica Olhar - acesso interno", charset="UTF-8"' });
      return false;
    }
  }
  return true;
}
