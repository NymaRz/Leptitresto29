// Le P'tit Resto 29 : API du site (Cloudflare Workers + D1 + KV).
// Reprend à l'identique le contrat attendu par l'interface d'origine (public/app.js).

const SESSION_COOKIE = 'pr29_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // maximum accepté par Workers
const LOGIN_MAX_FAILURES = { email: 10, ip: 30 };
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_SLIDES = 20;
const BOOKING_HORIZON_DAYS = 90;
const CATEGORIES = ['BURGER', 'ACCOMPAGNEMENT', 'BOISSON', 'DESSERT'];
const ORDER_STATUSES = ['TO_PREPARE', 'PREPARING', 'READY', 'COLLECTED', 'CANCELLED'];
const RESERVATION_STATUSES = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
const FINAL_STATUSES = ['COLLECTED', 'CANCELLED', 'COMPLETED'];
const CONTENT_FIELDS = {
  restaurantName: 80, town: 80, address: 160, phone: 30, openingHours: 160,
  heroEyebrow: 80, heroTitle: 160, heroText: 500,
};
const DEFAULT_SETTINGS = {
  slotIntervalMinutes: 15, reservationCapacity: 1, pickupCapacity: 5,
  lunchStartMinutes: 720, lunchEndMinutes: 810, dinnerStartMinutes: 1140, dinnerEndMinutes: 1260,
  openWeekdays: [2, 3, 4, 5],
};
const IMAGE_TYPES = {
  'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Réponses ----------

const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...extraHeaders } });
}

// ---------- Dates (heure de Paris) ----------

function parisNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const weekdayOf = (date) => new Date(date + 'T12:00:00Z').getUTCDay();
const clock = (minutes) => String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');

// ---------- Cryptographie ----------

const encoder = new TextEncoder();

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromBase64(value) {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function randomToken(bytes = 32) {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}
async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2' || !salt || !expected) return false;
  const actual = await pbkdf2(password, fromBase64(salt), Number(iterations));
  const wanted = fromBase64(expected);
  if (actual.length !== wanted.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ wanted[i];
  return diff === 0;
}

// ---------- Lecture et validation des requêtes ----------

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Format de requête non pris en charge.');
  const text = await request.text();
  if (text.length > 64 * 1024) throw new HttpError(413, 'Requête trop volumineuse.');
  try {
    const data = JSON.parse(text || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Requête invalide.');
  }
}

function text(value, { field, min = 0, max }) {
  const v = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (v.length < min) throw new HttpError(400, min > 0 && !v ? `${field} est obligatoire.` : `${field} est trop court.`);
  if (v.length > max) throw new HttpError(400, `${field} est trop long (${max} caractères maximum).`);
  return v;
}

function integer(value, { field, min, max }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} : valeur attendue entre ${min} et ${max}.`);
  return n;
}

function phoneNumber(value) {
  const v = text(value, { field: 'Le numéro de téléphone', min: 8, max: 24 });
  if (!/^[+0-9 ().-]+$/.test(v) || (v.match(/\d/g) || []).length < 8) throw new HttpError(400, 'Le numéro de téléphone est invalide.');
  return v;
}

function emailAddress(value) {
  const v = text(value, { field: "L'adresse e-mail", min: 3, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, "L'adresse e-mail est invalide.");
  return v;
}

// ---------- Sessions ----------

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, verified: !!u.verified, loyaltyPoints: u.loyalty_points };
}

async function currentUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(await sha256Hex(token), Math.floor(Date.now() / 1000)).first();
  return row || null;
}

async function createSession(env, userId) {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(token), userId, now + SESSION_DAYS * 86400),
  ]);
  return sessionCookie(token, SESSION_DAYS * 86400);
}

function requireUser(user) {
  if (!user) throw new HttpError(401, 'Connectez-vous pour continuer.');
  return user;
}
function requireAdmin(user) {
  requireUser(user);
  if (user.role !== 'admin') throw new HttpError(403, 'Accès réservé au restaurant.');
  return user;
}
function requireVerifiedCustomer(user) {
  requireUser(user);
  if (user.role !== 'customer') throw new HttpError(403, 'Utilisez un compte client pour réserver ou commander.');
  if (!user.verified) throw new HttpError(403, 'Votre compte doit être validé par le restaurant.');
  return user;
}

// ---------- Limitation des tentatives de connexion ----------

async function checkLoginLimit(env, keys) {
  const now = Math.floor(Date.now() / 1000);
  for (const key of keys) {
    const row = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE key = ?').bind(key).first();
    const max = key.startsWith('ip:') ? LOGIN_MAX_FAILURES.ip : LOGIN_MAX_FAILURES.email;
    if (row && now - row.window_start < LOGIN_WINDOW_SECONDS && row.count >= max) {
      throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
    }
  }
}
async function recordLoginFailure(env, keys) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(keys.map((key) => env.DB.prepare(
    `INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
  ).bind(key, now, LOGIN_WINDOW_SECONDS)));
}

// ---------- Réglages, contenu, carte ----------

async function getConfig(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first();
  return row ? { ...fallback, ...JSON.parse(row.value) } : { ...fallback };
}
async function setConfig(env, key, value) {
  await env.DB.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}

async function listSlides(env) {
  const { results } = await env.DB.prepare('SELECT * FROM slides ORDER BY sort_order, id').all();
  return results.map((s) => ({ id: s.id, title: s.title, image: s.image, objectKey: s.object_key, sortOrder: s.sort_order }));
}

async function listProducts(env, includeHidden) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM products ${includeHidden ? '' : 'WHERE available = 1'} ORDER BY category, sort_order, name`,
  ).all();
  return results.map((p) => ({
    id: p.id, slug: p.slug, name: p.name, description: p.description, category: p.category,
    priceCents: p.price_cents, available: !!p.available, sortOrder: p.sort_order,
  }));
}

function slugify(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'produit';
}

function productInput(body) {
  const category = String(body.category || '');
  if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Catégorie inconnue.');
  const priceCents = Number(body.priceCents);
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 100000) throw new HttpError(400, 'Le prix est invalide.');
  return {
    name: text(body.name, { field: 'Le nom', min: 1, max: 100 }),
    description: text(body.description, { field: 'La description', min: 1, max: 350 }),
    category,
    priceCents,
    available: body.available === true || body.available === 'on' || body.available === 'true',
  };
}

// ---------- Créneaux ----------

function slotTimes(settings) {
  const times = [];
  for (const [start, end] of [[settings.lunchStartMinutes, settings.lunchEndMinutes], [settings.dinnerStartMinutes, settings.dinnerEndMinutes]]) {
    for (let t = start; t < end; t += settings.slotIntervalMinutes) times.push(t);
  }
  return times;
}

async function computeSlots(env, kind, date) {
  if (!isValidDate(date)) throw new HttpError(400, 'Date invalide.');
  const now = parisNow();
  if (date < now.date) throw new HttpError(400, 'Cette date est déjà passée.');
  if (date > addDays(now.date, BOOKING_HORIZON_DAYS)) throw new HttpError(400, `Les créneaux sont ouverts ${BOOKING_HORIZON_DAYS} jours à l'avance.`);
  const settings = await getConfig(env, 'settings', DEFAULT_SETTINGS);
  if (!settings.openWeekdays.includes(weekdayOf(date))) return { settings, slots: [] };
  const table = kind === 'pickup' ? 'orders' : 'reservations';
  const capacity = kind === 'pickup' ? settings.pickupCapacity : settings.reservationCapacity;
  const { results } = await env.DB.prepare(
    `SELECT time, COUNT(*) AS n FROM ${table} WHERE date = ? AND status <> 'CANCELLED' GROUP BY time`,
  ).bind(date).all();
  const taken = Object.fromEntries(results.map((r) => [r.time, r.n]));
  const slots = slotTimes(settings).map((t) => ({
    time: clock(t),
    available: !(date === now.date && t <= now.minutes) && (taken[clock(t)] || 0) < capacity,
  }));
  return { settings, slots, capacity };
}

async function assertSlotOpen(env, kind, date, time) {
  const { slots, capacity } = await computeSlots(env, kind, date);
  const slot = slots.find((s) => s.time === time);
  if (!slot) throw new HttpError(400, 'Ce créneau ne fait pas partie des horaires du restaurant.');
  if (!slot.available) throw new HttpError(409, 'Ce créneau est complet. Choisissez-en un autre.');
  return capacity;
}

// ---------- Routes ----------

async function handleApi(request, env, url) {
  const method = request.method;
  const path = url.pathname;

  // Les requêtes qui modifient des données doivent venir du site lui-même.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Origine de la requête refusée.');
  }

  const user = await currentUser(request, env);
  let m;

  // --- Public ---
  if (method === 'GET' && path === '/api/session') return json({ user: user ? publicUser(user) : null });

  if (method === 'GET' && path === '/api/content') {
    return json({ content: await getConfig(env, 'content', {}), slides: await listSlides(env) });
  }

  if (method === 'GET' && path === '/api/catalog') return json({ products: await listProducts(env, false) });

  // --- Authentification ---
  if (method === 'POST' && path === '/api/auth/register') {
    const body = await readJson(request);
    const name = text(body.name, { field: 'Le nom', min: 2, max: 80 });
    const phone = phoneNumber(body.phone);
    const email = emailAddress(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 10 || password.length > 128) throw new HttpError(400, 'Le mot de passe doit contenir entre 10 et 128 caractères.');
    const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
    if (exists) throw new HttpError(409, 'Un compte existe déjà avec cette adresse e-mail.');
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email, name, phone, role, verified, password_hash) VALUES (?, ?, ?, ?, \'customer\', 0, ?)')
      .bind(id, email, name, phone, await hashPassword(password)).run();
    const created = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return json({ user: publicUser(created) }, 201, { 'set-cookie': await createSession(env, id) });
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
    const keys = ['email:' + email, 'ip:' + (request.headers.get('cf-connecting-ip') || 'local')];
    await checkLoginLimit(env, keys);
    const found = email ? await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first() : null;
    if (!found || !(await verifyPassword(password, found.password_hash))) {
      await recordLoginFailure(env, keys);
      throw new HttpError(401, 'Adresse e-mail ou mot de passe incorrect.');
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(keys[0]).run();
    return json({ user: publicUser(found), redirect: found.role === 'admin' ? '/admin' : '/' }, 200, { 'set-cookie': await createSession(env, found.id) });
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  // --- Client ---
  if (method === 'GET' && path === '/api/slots') {
    requireVerifiedCustomer(user);
    const kind = url.searchParams.get('kind');
    if (kind !== 'pickup' && kind !== 'reservation') throw new HttpError(400, 'Type de créneau inconnu.');
    const { slots } = await computeSlots(env, kind, url.searchParams.get('date'));
    return json({ slots });
  }

  if (method === 'POST' && path === '/api/orders') {
    requireVerifiedCustomer(user);
    const body = await readJson(request);
    const date = String(body.date || '');
    const time = String(body.time || '');
    const note = text(body.note, { field: 'La précision', max: 300 });
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 60) throw new HttpError(400, 'Ajoutez au moins un produit.');
    const quantities = new Map();
    for (const item of body.items) {
      const id = String(item?.productId || '');
      const qty = integer(item?.quantity, { field: 'La quantité', min: 1, max: 99 });
      quantities.set(id, (quantities.get(id) || 0) + qty);
    }
    const ids = [...quantities.keys()];
    const { results: products } = await env.DB.prepare(
      `SELECT id, name, price_cents FROM products WHERE available = 1 AND id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all();
    if (products.length !== ids.length) throw new HttpError(400, "Un produit du panier n'est plus disponible. Rechargez la page.");
    products.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)); // ordre du panier
    const subtotal = products.reduce((sum, p) => sum + p.price_cents * quantities.get(p.id), 0);
    const capacity = await assertSlotOpen(env, 'pickup', date, time);
    const id = crypto.randomUUID();
    const statements = [
      env.DB.prepare(
        `INSERT INTO orders (id, user_id, date, time, note, status, subtotal_cents)
         SELECT ?, ?, ?, ?, ?, 'TO_PREPARE', ?
         WHERE (SELECT COUNT(*) FROM orders WHERE date = ? AND time = ? AND status <> 'CANCELLED') < ?`,
      ).bind(id, user.id, date, time, note, subtotal, date, time, capacity),
      ...products.map((p) => env.DB.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, quantity)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
      ).bind(id, p.id, p.name, p.price_cents, quantities.get(p.id), id)),
    ];
    const results = await env.DB.batch(statements);
    if (!results[0].meta.changes) throw new HttpError(409, "Ce créneau vient d'être complété. Choisissez-en un autre.");
    return json({
      order: { id, date, time, note, status: 'TO_PREPARE', subtotalCents: subtotal, items: products.map((p) => ({ productName: p.name, quantity: quantities.get(p.id) })) },
    }, 201);
  }

  if (method === 'POST' && path === '/api/reservations') {
    requireVerifiedCustomer(user);
    const body = await readJson(request);
    const date = String(body.date || '');
    const time = String(body.time || '');
    const phone = phoneNumber(body.phone);
    const guests = integer(body.guests, { field: 'Le nombre de personnes', min: 1, max: 18 });
    const note = text(body.note, { field: 'La demande particulière', max: 500 });
    const capacity = await assertSlotOpen(env, 'reservation', date, time);
    const id = crypto.randomUUID();
    const result = await env.DB.prepare(
      `INSERT INTO reservations (id, user_id, date, time, guests, phone, note, status)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED'
       WHERE (SELECT COUNT(*) FROM reservations WHERE date = ? AND time = ? AND status <> 'CANCELLED') < ?`,
    ).bind(id, user.id, date, time, guests, phone, note, date, time, capacity).run();
    if (!result.meta.changes) throw new HttpError(409, "Ce créneau vient d'être réservé. Choisissez-en un autre.");
    return json({ reservation: { id, date, time, guests, note, status: 'CONFIRMED' }, notification: { sent: false } }, 201);
  }

  if (method === 'GET' && path === '/api/me/history') {
    requireUser(user);
    const { results: reservations } = await env.DB.prepare(
      'SELECT id, date, time, guests, note, status FROM reservations WHERE user_id = ? ORDER BY date DESC, time DESC LIMIT 50',
    ).bind(user.id).all();
    const { results: orders } = await env.DB.prepare(
      'SELECT id, date, time, note, status, subtotal_cents FROM orders WHERE user_id = ? ORDER BY date DESC, time DESC LIMIT 50',
    ).bind(user.id).all();
    const items = await orderItems(env, orders.map((o) => o.id));
    return json({
      reservations,
      orders: orders.map((o) => ({ id: o.id, date: o.date, time: o.time, note: o.note, status: o.status, subtotalCents: o.subtotal_cents, items: items[o.id] || [] })),
    });
  }

  // --- Administration ---
  if (path.startsWith('/api/admin/')) requireAdmin(user);

  if (method === 'GET' && path === '/api/admin/overview') {
    const period = ['day', 'week', 'month'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'day';
    const date = url.searchParams.get('date');
    if (!isValidDate(date)) throw new HttpError(400, 'Date invalide.');
    let start = date;
    let end = addDays(date, 1);
    if (period === 'week') { start = addDays(date, -((weekdayOf(date) + 6) % 7)); end = addDays(start, 7); }
    if (period === 'month') {
      start = date.slice(0, 8) + '01';
      const d = new Date(start + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1);
      end = d.toISOString().slice(0, 10);
    }
    const { results: reservations } = await env.DB.prepare(
      `SELECT r.id, r.date, r.time, r.guests, r.phone, r.note, r.status, u.name, u.email
       FROM reservations r JOIN users u ON u.id = r.user_id
       WHERE r.date >= ? AND r.date < ? ORDER BY r.date, r.time`,
    ).bind(start, end).all();
    const { results: orders } = await env.DB.prepare(
      `SELECT o.id, o.date, o.time, o.note, o.status, o.subtotal_cents, u.name, u.email, u.phone
       FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.date >= ? AND o.date < ? ORDER BY o.date, o.time`,
    ).bind(start, end).all();
    const items = await orderItems(env, orders.map((o) => o.id));
    const { results: customers } = await env.DB.prepare(
      "SELECT id, name, email, phone, verified FROM users WHERE role = 'customer' ORDER BY verified ASC, created_at DESC LIMIT 500",
    ).all();
    return json({
      period, start, end,
      reservations,
      orders: orders.map((o) => ({ id: o.id, date: o.date, time: o.time, note: o.note, status: o.status, subtotalCents: o.subtotal_cents, name: o.name, email: o.email, phone: o.phone, items: items[o.id] || [] })),
      customers: customers.map((c) => ({ ...c, verified: !!c.verified })),
      settings: await getConfig(env, 'settings', DEFAULT_SETTINGS),
    });
  }

  if (method === 'PATCH' && path === '/api/admin/settings') {
    const body = await readJson(request);
    const minutes = (key, label) => integer(body[key], { field: label, min: 0, max: 1439 });
    const settings = {
      slotIntervalMinutes: Number(body.slotIntervalMinutes),
      reservationCapacity: integer(body.reservationCapacity, { field: 'Le nombre de réservations par créneau', min: 1, max: 30 }),
      pickupCapacity: integer(body.pickupCapacity, { field: 'Le nombre de retraits par créneau', min: 1, max: 80 }),
      lunchStartMinutes: minutes('lunchStartMinutes', 'Le début du midi'),
      lunchEndMinutes: minutes('lunchEndMinutes', 'La fin du midi'),
      dinnerStartMinutes: minutes('dinnerStartMinutes', 'Le début du soir'),
      dinnerEndMinutes: minutes('dinnerEndMinutes', 'La fin du soir'),
      openWeekdays: Array.isArray(body.openWeekdays) ? [...new Set(body.openWeekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [],
    };
    if (![5, 10, 15, 20, 30].includes(settings.slotIntervalMinutes)) throw new HttpError(400, 'Intervalle de créneau invalide.');
    if (settings.lunchStartMinutes >= settings.lunchEndMinutes || settings.dinnerStartMinutes >= settings.dinnerEndMinutes) {
      throw new HttpError(400, 'Chaque service doit se terminer après son début.');
    }
    if (settings.lunchEndMinutes > settings.dinnerStartMinutes) throw new HttpError(400, 'Le service du midi doit se terminer avant celui du soir.');
    await setConfig(env, 'settings', settings);
    return json({ settings });
  }

  if (method === 'GET' && path === '/api/admin/products') return json({ products: await listProducts(env, true) });

  if (method === 'POST' && path === '/api/admin/products') {
    const p = productInput(await readJson(request));
    let slug = slugify(p.name);
    for (let i = 2; await env.DB.prepare('SELECT 1 FROM products WHERE slug = ?').bind(slug).first(); i++) slug = `${slugify(p.name)}-${i}`;
    const max = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM products WHERE category = ?').bind(p.category).first();
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO products (id, slug, name, description, category, price_cents, available, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, slug, p.name, p.description, p.category, p.priceCents, p.available ? 1 : 0, max.m + 10).run();
    return json({ product: { id, slug, ...p, sortOrder: max.m + 10 } }, 201);
  }

  if ((m = path.match(/^\/api\/admin\/products\/([\w-]{1,64})$/))) {
    const id = m[1];
    if (method === 'PATCH') {
      const p = productInput(await readJson(request));
      const r = await env.DB.prepare('UPDATE products SET name = ?, description = ?, category = ?, price_cents = ?, available = ? WHERE id = ?')
        .bind(p.name, p.description, p.category, p.priceCents, p.available ? 1 : 0, id).run();
      if (!r.meta.changes) throw new HttpError(404, 'Produit introuvable.');
      return json({ product: { id, ...p } });
    }
    if (method === 'DELETE') {
      const r = await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
      if (!r.meta.changes) throw new HttpError(404, 'Produit introuvable.');
      return json({ ok: true });
    }
  }

  if (method === 'PATCH' && path === '/api/admin/content') {
    const body = await readJson(request);
    const content = {};
    for (const [key, max] of Object.entries(CONTENT_FIELDS)) content[key] = text(body[key], { field: 'Chaque champ', min: 1, max });
    await setConfig(env, 'content', content);
    return json({ content });
  }

  if (method === 'POST' && path === '/api/admin/carousel') {
    let form;
    try { form = await request.formData(); } catch { throw new HttpError(400, 'Envoi de la photo invalide.'); }
    const title = text(form.get('title'), { field: 'Le titre', min: 1, max: 100 });
    const file = form.get('image');
    if (!file || typeof file === 'string') throw new HttpError(400, 'Choisissez une photo.');
    const type = IMAGE_TYPES[file.type];
    if (!type) throw new HttpError(400, 'Formats acceptés : PNG, JPEG ou WebP.');
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'La photo dépasse 4 Mo.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!type.magic(bytes)) throw new HttpError(400, "Le fichier n'est pas une image valide.");
    const count = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS m FROM slides').first();
    if (count.n >= MAX_SLIDES) throw new HttpError(400, `Le carrousel contient déjà ${MAX_SLIDES} photos.`);
    const id = crypto.randomUUID();
    const key = `media/${id}.${type.ext}`;
    await env.MEDIA.put(key, bytes, { metadata: { contentType: file.type } });
    await env.DB.prepare('INSERT INTO slides (id, title, image, object_key, sort_order) VALUES (?, ?, ?, ?, ?)')
      .bind(id, title, '/' + key, key, count.m + 10).run();
    return json({ slide: { id, title, image: '/' + key, objectKey: key, sortOrder: count.m + 10 } }, 201);
  }

  if ((m = path.match(/^\/api\/admin\/carousel\/([\w-]{1,64})$/))) {
    const id = m[1];
    const slide = await env.DB.prepare('SELECT * FROM slides WHERE id = ?').bind(id).first();
    if (!slide) throw new HttpError(404, 'Photo introuvable.');
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM slides WHERE id = ?').bind(id).run();
      if (slide.object_key) await env.MEDIA.delete(slide.object_key);
      return json({ ok: true });
    }
    if (method === 'PATCH') {
      const body = await readJson(request);
      const target = integer(body.sortOrder, { field: 'La position', min: -100000, max: 100000 });
      const movingUp = target < slide.sort_order;
      const { results } = await env.DB.prepare('SELECT id, sort_order FROM slides ORDER BY sort_order, id').all();
      // L'interface envoie « position ± 10 » : on place la photo avant ou après sa voisine, puis on renumérote.
      const ordered = results.map((s) => ({ id: s.id, order: s.id === id ? target : s.sort_order }))
        .sort((a, b) => a.order - b.order || (a.id === id ? (movingUp ? -1 : 1) : b.id === id ? (movingUp ? 1 : -1) : 0));
      await env.DB.batch(ordered.map((s, i) => env.DB.prepare('UPDATE slides SET sort_order = ? WHERE id = ?').bind((i + 1) * 10, s.id)));
      return json({ ok: true });
    }
  }

  if (method === 'PATCH' && (m = path.match(/^\/api\/admin\/customers\/([\w-]{1,64})$/))) {
    const body = await readJson(request);
    const r = await env.DB.prepare("UPDATE users SET verified = ? WHERE id = ? AND role = 'customer'").bind(body.verified === true ? 1 : 0, m[1]).run();
    if (!r.meta.changes) throw new HttpError(404, 'Client introuvable.');
    return json({ ok: true });
  }

  if (method === 'PATCH' && (m = path.match(/^\/api\/admin\/(orders|reservations)\/([\w-]{1,64})$/))) {
    const [, kind, id] = m;
    const body = await readJson(request);
    const status = String(body.status || '');
    if (!(kind === 'orders' ? ORDER_STATUSES : RESERVATION_STATUSES).includes(status)) throw new HttpError(400, 'Statut inconnu.');
    const record = await env.DB.prepare(`SELECT * FROM ${kind} WHERE id = ?`).bind(id).first();
    if (!record) throw new HttpError(404, 'Demande introuvable.');
    if (FINAL_STATUSES.includes(record.status)) throw new HttpError(409, 'Cette demande est déjà clôturée.');
    if (kind === 'reservations') {
      const reason = status === 'CANCELLED' ? text(body.reason, { field: 'Le motif', min: 3, max: 300 }) : null;
      await env.DB.prepare('UPDATE reservations SET status = ?, cancel_reason = ? WHERE id = ?').bind(status, reason, id).run();
    } else {
      const statements = [env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, id)];
      // Fidélité : 1 point par euro sur chaque commande retirée.
      if (status === 'COLLECTED') {
        statements.push(env.DB.prepare('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?').bind(Math.floor(record.subtotal_cents / 100), record.user_id));
      }
      await env.DB.batch(statements);
    }
    return json({ ok: true, notification: { sent: false } });
  }

  throw new HttpError(404, 'Ressource introuvable.');
}

async function orderItems(env, orderIds) {
  if (!orderIds.length) return {};
  const out = {};
  // D1 limite le nombre de paramètres par requête : on procède par lots.
  for (let i = 0; i < orderIds.length; i += 90) {
    const chunk = orderIds.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT order_id, product_name, quantity FROM order_items WHERE order_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`,
    ).bind(...chunk).all();
    for (const r of results) (out[r.order_id] ||= []).push({ productName: r.product_name, quantity: r.quantity });
  }
  return out;
}

async function handleMedia(env, url) {
  const key = url.pathname.slice(1);
  if (!/^media\/[\w-]{1,64}\.(png|jpg|webp)$/.test(key)) return new Response('Introuvable', { status: 404 });
  const { value, metadata } = await env.MEDIA.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!value) return new Response('Introuvable', { status: 404 });
  return new Response(value, {
    headers: {
      'content-type': metadata?.contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      if (url.pathname.startsWith('/media/')) return await handleMedia(env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'Erreur du serveur. Réessayez dans un instant.' }, 500);
    }
  },
};
