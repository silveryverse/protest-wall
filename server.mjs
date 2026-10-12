import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = Object.freeze({
  summary: "Cockroach Janta Party (CJP) is a youth-led satirical movement, not a registered political party. Its current campaign calls for electoral reforms and the resignation of Chief Election Commissioner Gyanesh Kumar amid controversy around the Special Intensive Revision (SIR) of voter rolls. CJP's petition asks for an independent inquiry, a pause and rollback of the revision, and changes to the law governing the appointment of election commissioners. The Election Commission and the BJP reject allegations that the revision is being manipulated for partisan advantage. This independent wall is not an official CJP channel or endorsement.",
  demands: [
    { title: 'Accountability now', detail: "CJP's petition calls for Gyanesh Kumar's resignation within 48 hours, criminal proceedings, and an answer to who gave the instructions at issue. These are CJP's demands, not established findings of wrongdoing." },
    { title: 'Freeze the polls. Freeze SIR.', detail: 'CJP calls for upcoming polls to be paused, SIR to be frozen and rolled back to the January 2025 voter list, and an independent inquiry into how decisions were made.' },
    { title: 'Independent election leadership', detail: 'CJP calls for repeal of the 2023 law governing the appointment of Election Commissioners and a replacement law with civil-society participation.' },
  ],
  sourceUrl: 'https://www.cockroachjantaparty.org/petitions/demands-for-electoral-integrity',
  confirmed: true,
});
const POST_TYPES = new Set(['text', 'video', 'image', 'poster', 'link', 'article']);
const POST_CATEGORIES = new Set(['auto', 'protests', 'memes', 'posters', 'news']);
const POST_STATUSES = new Set(['approved', 'rejected', 'pending']);
const BODY_LIMIT = 64 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOGIN_LIMIT = 8;
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_SUBMISSION_LIMIT = 12;
const DEFAULT_SUBMISSION_WINDOW_MS = 60 * 60 * 1000;

function freshConfig() {
  return { summary: DEFAULT_CONFIG.summary, demands: structuredClone(DEFAULT_CONFIG.demands), sourceUrl: DEFAULT_CONFIG.sourceUrl, confirmed: DEFAULT_CONFIG.confirmed };
}

function defaultStore() {
  return { posts: [], config: freshConfig() };
}

function cleanString(value, field, max, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const result = value.trim();
  if (required && !result) throw new HttpError(400, `${field} is required`);
  if (result.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  if (/<\s*\/?\s*[a-z][^>]*>/i.test(result)) throw new HttpError(400, `${field} must be plain text, not HTML`);
  return result;
}

function isPrivateIp(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(host);
  if (version === 4) {
    const octets = host.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && octets[2] === 0) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113) || a >= 224;
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    const mapped = normalized.match(/^(?:0*:){0,4}ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return Boolean(mapped && isPrivateIp(mapped[1]));
  }
  return false;
}

function parsePublicHttps(value, field = 'url') {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be a public HTTPS URL`);
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new HttpError(400, `${field} must be a public HTTPS URL`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (parsed.protocol !== 'https:' || !hostname || parsed.username || parsed.password || parsed.port ||
      isPrivateIp(hostname) || /^\d+$/.test(hostname) || hostname === 'localhost' ||
      hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') ||
      !hostname.includes('.')) {
    throw new HttpError(400, `${field} must be a public HTTPS URL`);
  }
  if (value.trim().length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, `${field} must be a public HTTPS URL`);
  }
  parsed.hash = '';
  return parsed;
}

function hostIs(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function classifyUrl(parsed) {
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (hostIs(host, 'youtube.com')) {
    const id = parsed.pathname === '/watch' ? parsed.searchParams.get('v') :
      ['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) throw new HttpError(400, 'Invalid YouTube video URL');
    return 'youtube';
  }
  if (host === 'youtu.be') {
    if (!/^[A-Za-z0-9_-]{11}$/.test(parts[0] || '')) throw new HttpError(400, 'Invalid YouTube video URL');
    return 'youtube';
  }
  if (hostIs(host, 'x.com') || hostIs(host, 'twitter.com')) {
    if (!/^\/[^/]+\/status\/\d+(?:\/|$)/.test(parsed.pathname)) throw new HttpError(400, 'Invalid X/Twitter post URL');
    return 'x';
  }
  if (hostIs(host, 'reddit.com')) {
    if (!/(?:^|\/)comments\/[a-z0-9]+(?:\/|$)/i.test(parsed.pathname)) throw new HttpError(400, 'Invalid Reddit post URL');
    return 'reddit';
  }
  if (host === 'redd.it') {
    if (!/^[a-z0-9]+$/i.test(parts[0] || '')) throw new HttpError(400, 'Invalid Reddit post URL');
    return 'reddit';
  }
  return /\.(?:png|jpe?g|gif|webp|avif)$/i.test(parsed.pathname) ||
    (hostIs(host, 'images.unsplash.com') && parsed.pathname.startsWith('/photo-')) ||
    hostIs(host, 'i.redd.it') || hostIs(host, 'i.imgur.com') ? 'image' : 'article';
}

function inferCategory(post) {
  post = post && typeof post === 'object' ? post : {};
  if (post.type === 'poster') return 'posters';
  if (post.satire === true) return 'memes';
  if ((post.type === 'article' || post.type === 'text') && post.url) return 'news';
  return 'protests';
}

function categoryForPost(post) {
  const candidate = post && typeof post === 'object' ? post : {};
  return POST_CATEGORIES.has(candidate.category) && candidate.category !== 'auto' ? candidate.category : inferCategory(candidate);
}

function validatePostBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
  if (['html', 'embed', 'iframe'].some((key) => key in body)) throw new HttpError(400, 'Raw HTML and embed code are not accepted');
  const requestedType = cleanString(body.type, 'type', 20);
  if (requestedType && !POST_TYPES.has(requestedType)) throw new HttpError(400, 'Invalid post type');
  const requestedCategory = cleanString(body.category, 'category', 20);
  if (requestedCategory && !POST_CATEGORIES.has(requestedCategory)) throw new HttpError(400, 'Invalid category');
  if (requestedType === 'poster' && requestedCategory && !['auto', 'posters'].includes(requestedCategory)) {
    throw new HttpError(400, 'poster posts must use the posters category');
  }
  const parsed = body.url === undefined || body.url === '' ? null : parsePublicHttps(body.url, 'url');
  const detectedPlatform = parsed ? classifyUrl(parsed) : 'text';
  if (requestedCategory === 'posters' && (!parsed || detectedPlatform !== 'image')) {
    throw new HttpError(400, 'posters require a direct image link');
  }
  if (requestedCategory === 'news' && (!parsed || detectedPlatform !== 'article')) {
    throw new HttpError(400, 'news requires an article or document URL');
  }
  if (requestedType === 'poster' && (!parsed || detectedPlatform !== 'image')) {
    throw new HttpError(400, 'poster posts require a direct image link');
  }
  const platform = requestedType === 'poster' ? 'image' : detectedPlatform;
  const type = requestedType === 'article' ? 'text' : requestedType === 'link' ?
    (['x', 'reddit', 'youtube'].includes(platform) ? 'video' : platform === 'image' ? 'image' : 'text') :
    requestedType || ({ youtube: 'video', image: 'image', article: 'text', x: 'video', reddit: 'video' })[platform];
  if (!type) throw new HttpError(400, 'url is required');
  if (requestedCategory === 'posters' && type === 'text') throw new HttpError(400, 'posters require a non-text image post');
  if (type !== 'text' && !parsed) throw new HttpError(400, 'url is required');
  if (type === 'video' && !['youtube', 'x', 'reddit'].includes(platform)) throw new HttpError(400, 'url is not an allowed video URL');
  const defaultTitle = { youtube: 'YouTube video', x: 'X post', reddit: 'Reddit post', image: 'Shared image', article: 'Shared article' };
  const title = cleanString(body.title, 'title', 120) || defaultTitle[platform];
  if (!title) throw new HttpError(400, 'title is required');
  const text = cleanString(body.text, 'text', 3000);
  if (type === 'text' && !text && !parsed) throw new HttpError(400, 'text is required for text posts');
  const url = parsed ? parsed.toString() : '';
  if (body.satire !== undefined && typeof body.satire !== 'boolean') throw new HttpError(400, 'satire must be a boolean');
  const author = body.author === undefined ? '' : cleanString(body.author, 'author', 120);
  const post = { type, platform, title, text, url, author, satire: body.satire === true };
  post.category = requestedCategory === 'auto' || !requestedCategory ? inferCategory(post) : requestedCategory;
  return post;
}

function validateConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
  const summary = cleanString(body.summary, 'summary', 3000);
  if (!Array.isArray(body.demands) || body.demands.length > 50) throw new HttpError(400, 'demands must be an array of at most 50 items');
  const demands = body.demands.map((demand) => {
    if (!demand || typeof demand !== 'object' || Array.isArray(demand)) throw new HttpError(400, 'each demand must be an object');
    return {
      title: cleanString(demand.title, 'demand title', 120, { required: true }),
      detail: cleanString(demand.detail, 'demand detail', 1000),
    };
  });
  const sourceUrl = body.sourceUrl === undefined || body.sourceUrl === '' ? '' : parsePublicHttps(body.sourceUrl, 'sourceUrl').toString();
  if (typeof body.confirmed !== 'boolean') throw new HttpError(400, 'confirmed must be a boolean');
  if (body.confirmed && (!summary || demands.length < 1 || !sourceUrl)) {
    throw new HttpError(400, 'confirmed config requires a summary, at least one demand, and a sourceUrl');
  }
  return { summary, demands, sourceUrl, confirmed: body.confirmed };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readStore(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      posts: Array.isArray(parsed.posts) ? parsed.posts.map((post) => post && typeof post === 'object' ? ({ ...post, category: categoryForPost(post) }) : post) : [],
      config: parsed.config && typeof parsed.config === 'object' ? {
        summary: typeof parsed.config.summary === 'string' ? parsed.config.summary : '',
        demands: Array.isArray(parsed.config.demands) ? parsed.config.demands : [],
        sourceUrl: typeof parsed.config.sourceUrl === 'string' ? parsed.config.sourceUrl : '',
        confirmed: parsed.config.confirmed === true,
      } : freshConfig(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return defaultStore();
    throw error;
  }
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function consumeLimit(limits, key, max, windowMs) {
  const now = Date.now();
  let entry = limits.get(key);
  if (!entry || entry.reset <= now) entry = { count: 0, reset: now + windowMs };
  entry.count += 1;
  limits.set(key, entry);
  if (entry.count > max) return Math.max(1, Math.ceil((entry.reset - now) / 1000));
  return 0;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((piece) => piece.trim().split('='))
    .filter(([key, value]) => key && value !== undefined).map(([key, ...value]) => [key, value.join('=')]));
}

function jsonResponse(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error(error);
  jsonResponse(res, status, { error: status >= 500 ? 'Internal server error' : error.message });
}

async function readJson(req) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > BODY_LIMIT) throw new HttpError(413, 'Request body is too large');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_LIMIT) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (!total) throw new HttpError(400, 'JSON body required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function originAllowed(req, publicOrigin) {
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!origin) return true;
  if (!req.headers.host) return false;
  try {
    const parsed = new URL(origin);
    if (publicOrigin) return parsed.origin === publicOrigin;
    const expectedProtocol = req.socket.encrypted ? 'https:' : 'http:';
    return parsed.origin === `${expectedProtocol}//${req.headers.host}`;
  } catch {
    return false;
  }
}

function requireOrigin(req, publicOrigin) {
  if (!originAllowed(req, publicOrigin)) throw new HttpError(403, 'Cross-origin mutation rejected');
}

function requireContentType(req) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
}

function sessionToken(req, sessions) {
  const token = parseCookies(req.headers.cookie).admin_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}

function requireAdmin(req, sessions) {
  if (!sessionToken(req, sessions)) throw new HttpError(401, 'Authentication required');
}

function safeStaticPath(rawPath, staticDir) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, 'Invalid path');
  }
  if (pathname.includes('\0') || pathname.includes('\\')) throw new HttpError(400, 'Invalid path');
  const parts = pathname.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) throw new HttpError(400, 'Invalid path');
  const target = path.resolve(staticDir, `.${pathname}`);
  const root = path.resolve(staticDir);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new HttpError(400, 'Invalid path');
  return target;
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

export function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data'));
  const staticDir = path.resolve(options.publicDir || path.join(ROOT, 'public'));
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '';
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !/^https?:\/\//.test(publicOrigin))) {
    throw new Error('PUBLIC_ORIGIN must be an exact http(s) origin without a trailing slash or path');
  }
  const secureCookie = publicOrigin.startsWith('https://');
  const configured = typeof adminPassword === 'string' && adminPassword.length >= 12;
  const sessions = new Map();
  const loginLimits = new Map();
  const submissionLimits = new Map();
  const loginLimit = options.loginLimit ?? options.rateLimits?.login?.max ?? DEFAULT_LOGIN_LIMIT;
  const loginWindowMs = options.loginWindowMs ?? options.rateLimits?.login?.windowMs ?? DEFAULT_LOGIN_WINDOW_MS;
  const submissionLimit = options.submissionLimit ?? options.rateLimits?.submissions?.max ?? DEFAULT_SUBMISSION_LIMIT;
  const submissionWindowMs = options.submissionWindowMs ?? options.rateLimits?.submissions?.windowMs ?? DEFAULT_SUBMISSION_WINDOW_MS;
  const storeFile = path.join(dataDir, 'store.json');
  const state = { store: defaultStore(), writeQueue: Promise.resolve() };
  const ready = (async () => {
    await fs.mkdir(dataDir, { recursive: true });
    state.store = await readStore(storeFile);
  })();

  function commit(change) {
    const operation = state.writeQueue.catch(() => {}).then(async () => {
      const next = structuredClone(state.store);
      const result = change(next);
      const snapshot = JSON.stringify(next, null, 2) + '\n';
      const temporary = path.join(dataDir, `.store.${process.pid}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, storeFile);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      state.store = next;
      return result;
    });
    state.writeQueue = operation;
    return operation;
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
     res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; frame-src https://www.youtube-nocookie.com https://platform.twitter.com https://twitter.com https://reddit.com https://www.reddit.com https://www.redditmedia.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    await ready;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = requestUrl.pathname;
    const method = req.method || 'GET';
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (mutation) requireOrigin(req, publicOrigin);

    if (pathname === '/health' && method === 'GET') return jsonResponse(res, 200, { status: 'ok' });

    if (pathname === '/api/posts' && method === 'GET') {
      const posts = state.store.posts.filter((post) => post.status === 'approved')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse(res, 200, { posts });
    }
    if (pathname === '/api/config' && method === 'GET') return jsonResponse(res, 200, { config: state.store.config });

    if (pathname === '/api/posts' && method === 'POST') {
      const retryAfter = consumeLimit(submissionLimits, clientIp(req), submissionLimit, submissionWindowMs);
      if (retryAfter) return jsonResponse(res, 429, { error: 'Too many submissions; try again later' }, { 'Retry-After': retryAfter });
      requireContentType(req);
      const input = validatePostBody(await readJson(req));
      const post = { id: crypto.randomUUID(), ...input, status: 'pending', createdAt: new Date().toISOString() };
      await commit((next) => next.posts.push(post));
      return jsonResponse(res, 201, { message: 'Post submitted for moderation', id: post.id });
    }

    if (pathname === '/api/admin/session' && method === 'GET') {
      return jsonResponse(res, 200, { authenticated: Boolean(sessionToken(req, sessions)), configured });
    }
    if (pathname === '/api/admin/login' && method === 'POST') {
      const retryAfter = consumeLimit(loginLimits, clientIp(req), loginLimit, loginWindowMs);
      if (retryAfter) return jsonResponse(res, 429, { error: 'Too many login attempts; try again later' }, { 'Retry-After': retryAfter });
      requireContentType(req);
      const body = await readJson(req);
      if (!configured || !body || typeof body.password !== 'string') throw new HttpError(401, 'Invalid credentials');
      const supplied = crypto.createHash('sha256').update(body.password).digest();
      const expected = crypto.createHash('sha256').update(adminPassword).digest();
      if (!crypto.timingSafeEqual(supplied, expected)) throw new HttpError(401, 'Invalid credentials');
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
      const cookieSecurity = secureCookie || req.socket.encrypted ? '; Secure' : '';
      return jsonResponse(res, 200, { message: 'Logged in' }, {
        'Set-Cookie': `admin_session=${token}; Path=/; HttpOnly${cookieSecurity}; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
    }
    if (pathname === '/api/admin/logout' && method === 'POST') {
      const token = parseCookies(req.headers.cookie).admin_session;
      if (token) sessions.delete(token);
      const cookieSecurity = secureCookie || req.socket.encrypted ? '; Secure' : '';
      return jsonResponse(res, 200, { message: 'Logged out' }, { 'Set-Cookie': `admin_session=; Path=/; HttpOnly${cookieSecurity}; SameSite=Strict; Max-Age=0` });
    }
    if (pathname === '/api/admin/posts' && method === 'GET') {
      requireAdmin(req, sessions);
      return jsonResponse(res, 200, { posts: [...state.store.posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    const postMatch = pathname.match(/^\/api\/admin\/posts\/([^/]+)$/);
    if (postMatch && (method === 'PATCH' || method === 'DELETE')) {
      requireAdmin(req, sessions);
      let id;
      try {
        id = decodeURIComponent(postMatch[1]);
      } catch {
        throw new HttpError(400, 'Invalid post id');
      }
      if (method === 'DELETE') {
        await commit((next) => {
          const index = next.posts.findIndex((post) => post.id === id);
          if (index < 0) throw new HttpError(404, 'Post not found');
          next.posts.splice(index, 1);
        });
        return jsonResponse(res, 200, { message: 'Post deleted' });
      }
      requireContentType(req);
      const body = await readJson(req);
      if (!body || !POST_STATUSES.has(body.status)) throw new HttpError(400, 'status must be approved, rejected, or pending');
      const post = await commit((next) => {
        const selected = next.posts.find((item) => item.id === id);
        if (!selected) throw new HttpError(404, 'Post not found');
        selected.status = body.status;
        return selected;
      });
      return jsonResponse(res, 200, { message: 'Post status updated', post });
    }
    if (pathname === '/api/admin/config' && method === 'PUT') {
      requireAdmin(req, sessions);
      requireContentType(req);
      const config = validateConfig(await readJson(req));
      await commit((next) => { next.config = config; });
      return jsonResponse(res, 200, { config: state.store.config });
    }

    if (pathname.startsWith('/api/') || pathname === '/health') throw new HttpError(404, 'Not found');

    if (method === 'GET' || method === 'HEAD') {
      const target = safeStaticPath(pathname === '/' ? '/index.html' : pathname, staticDir);
      try {
        const resolved = await fs.realpath(target);
        if (!resolved.startsWith(`${staticDir}${path.sep}`)) throw new HttpError(404, 'Not found');
        const info = await fs.stat(target);
        if (!info.isFile()) throw new Error('not a file');
        const content = await fs.readFile(target);
        const headers = { 'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': content.length };
        res.writeHead(200, headers);
        if (method === 'GET') res.end(content); else res.end();
        return;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(404, 'Not found');
      }
    }
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.ready = ready;
  server.dataDir = dataDir;
  server.storeFile = storeFile;
  return server;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST || '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const server = createApp({});
  server.on('error', (error) => { console.error(error); process.exitCode = 1; });
  server.ready.then(() => {
    server.listen(port, host, () => console.log(`Protest wall listening on http://${host}:${port}`));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  const shutdown = () => server.close((error) => { if (error) { console.error(error); process.exitCode = 1; } });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
