import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import path from 'node:path';
import { config, ROOT } from './config.js';

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', field = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

// ---------- Roteador mínimo ----------
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

// ---------- Utilidades de requisição ----------
export function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignora cookie malformado */ }
  }
  return out;
}

export async function readJson(req, limit = 32 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) throw new HttpError(415, 'Envie os dados em JSON.', 'UNSUPPORTED_MEDIA');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Requisição grande demais.', 'TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON inválido.', 'BAD_JSON'); }
}

// ---------- Respostas ----------
function acceptsEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

export function send(req, res, status, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const type = String(headers['content-type'] || '');
  const h = { ...headers };
  if (buf.length > 1024 && /text|json|javascript|svg|csv/.test(type) && !h['content-encoding']) {
    const enc = acceptsEncoding(req);
    if (enc === 'br') buf = brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } });
    else if (enc === 'gzip') buf = gzipSync(buf, { level: 6 });
    if (enc) { h['content-encoding'] = enc; h['vary'] = 'Accept-Encoding'; }
  }
  h['content-length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export function json(req, res, status, data, headers = {}) {
  send(req, res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
}

export function html(req, res, status, body, headers = {}) {
  send(req, res, status, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...headers });
}

export function setCookie(name, value, { maxAge, path: p = '/', httpOnly = true, sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (config.isProd) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

// ---------- Cabeçalhos de segurança ----------
export function securityHeaders({ pixel = false } = {}) {
  const fb = pixel ? ' https://connect.facebook.net' : '';
  const fbImg = pixel ? ' https://www.facebook.com' : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self'${fb}`,
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data:${fbImg}`,
    `connect-src 'self'${fbImg}${fb}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  const h = {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (config.isProd) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

// ---------- Limite de requisições (memória do processo) ----------
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const nowMs = Date.now();
  let b = buckets.get(key);
  if (!b || nowMs > b.reset) { b = { count: 0, reset: nowMs + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 50_000) for (const [k, v] of buckets) if (nowMs > v.reset) buckets.delete(k);
  return { ok: b.count <= max, retryAfter: Math.ceil((b.reset - nowMs) / 1000) };
}
export function resetRateLimits() { buckets.clear(); }

// ---------- Arquivos estáticos (pré-comprimidos e versionados por hash) ----------
const TYPES = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const assets = new Map();

export function loadAssets() {
  const dir = path.join(ROOT, 'public');
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = '/' + path.relative(dir, full).split(path.sep).join('/');
      const data = readFileSync(full);
      const type = TYPES[path.extname(name)] || 'application/octet-stream';
      const entry = { data, type, hash: createHash('sha256').update(data).digest('hex').slice(0, 10) };
      if (/text|javascript|svg|json/.test(type)) {
        entry.br = brotliCompressSync(data, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } });
        entry.gz = gzipSync(data, { level: 9 });
      }
      assets.set(rel, entry);
    }
  };
  walk(dir);
}

/** URL versionada, ex.: /assets/app.css?v=ab12cd34ef — permite cache longo e seguro. */
export function assetUrl(rel) {
  const a = assets.get(rel);
  return a ? `${rel}?v=${a.hash}` : rel;
}

export function serveStatic(req, res, pathname, query) {
  const a = assets.get(pathname);
  if (!a) return false;
  const versioned = query.get('v') === a.hash;
  const headers = {
    'content-type': a.type,
    'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    etag: `"${a.hash}"`,
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === `"${a.hash}"`) { res.writeHead(304, headers); res.end(); return true; }
  const enc = a.br ? acceptsEncoding(req) : null;
  const body = enc === 'br' ? a.br : enc === 'gzip' ? a.gz : a.data;
  if (enc) { headers['content-encoding'] = enc; headers.vary = 'Accept-Encoding'; }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
