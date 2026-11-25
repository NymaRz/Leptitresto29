// Recette de bout en bout de l'API, sur un serveur local (« npm run dev ») avec un compte admin local.
// Usage : ADMIN_EMAIL=… ADMIN_PASSWORD=… npm test   (BASE_URL par défaut : http://127.0.0.1:8787)
// À ne jamais lancer contre le site en ligne : la recette crée des comptes, commandes et réservations de test.

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
if (!ADMIN.email || !ADMIN.password) throw new Error('Définir ADMIN_EMAIL et ADMIN_PASSWORD (compte admin local).');
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE)) throw new Error('La recette ne doit viser que le serveur local.');

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) passed++;
  else failures.push(`${label}${detail ? ' → ' + detail : ''}`);
}

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
    const h = { origin: BASE, ...headers };
    if (cookie) h.cookie = cookie;
    let payload = body;
    if (body && !(body instanceof FormData) && !raw) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };
}

const paris = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tomorrow = new Date(paris + 'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
const DATE = tomorrow.toISOString().slice(0, 10);
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const guest = client();
const customer = client();
const admin = client();

// Public
let r = await guest('/api/content');
check('contenu', r.status === 200 && r.data.content.restaurantName === "Le P'tit Resto 29" && r.data.slides.length >= 3);
r = await guest('/api/catalog');
check('carte publique', r.status === 200 && r.data.products.length >= 42, String(r.data.products?.length));
const products = r.data.products;
r = await guest('/api/session');
check('session vide', r.status === 200 && r.data.user === null);
r = await guest('/api/slots?kind=pickup&date=' + DATE);
check('créneaux sans compte → 401', r.status === 401);

// Pages
for (const path of ['/', '/admin', '/compte', '/connexion', '/mentions-legales', '/app.js', '/carousel/burger-double-bacon.webp']) {
  r = await guest(path);
  check(`page ${path}`, r.status === 200, String(r.status));
}
r = await guest('/admin');
check('en-têtes de sécurité', (r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));

// Inscription
const email = `client-${Date.now()}@test.local`;
r = await customer('/api/auth/register', { method: 'POST', body: { name: 'Client Test', phone: '06 12 34 56 78', email, password: 'court' } });
check('mot de passe trop court → 400', r.status === 400);
r = await customer('/api/auth/register', { method: 'POST', body: { name: 'Client Test', phone: '06 12 34 56 78', email, password: 'un-mot-de-passe-solide' } });
check('inscription', r.status === 201 && r.data.user.role === 'customer' && r.data.user.verified === false);
const customerId = r.data.user?.id;
r = await guest('/api/auth/register', { method: 'POST', body: { name: 'Doublon', phone: '0612345678', email, password: 'un-mot-de-passe-solide' } });
check('e-mail déjà utilisé → 409', r.status === 409);
r = await customer('/api/slots?kind=pickup&date=' + DATE);
check('client non validé → 403', r.status === 403);
r = await customer('/api/admin/overview?period=day&date=' + DATE);
check('client sur API admin → 403', r.status === 403);

// Administration
r = await admin('/api/auth/login', { method: 'POST', body: { email: ADMIN.email, password: 'mauvais-mot-de-passe' } });
check('connexion admin refusée', r.status === 401);
r = await admin('/api/auth/login', { method: 'POST', body: ADMIN });
check('connexion admin', r.status === 200 && r.data.redirect === '/admin');
r = await admin('/api/admin/overview?period=day&date=' + paris);
check('vue admin', r.status === 200 && r.data.customers.some((c) => c.id === customerId && !c.verified));
const originalSettings = r.data.settings;
r = await admin('/api/admin/customers/' + customerId, { method: 'PATCH', body: { verified: true } });
check('validation du client', r.status === 200);
r = await admin('/api/admin/settings', { method: 'PATCH', body: { ...originalSettings, slotIntervalMinutes: 15, reservationCapacity: 1, pickupCapacity: 2, lunchStartMinutes: 720, lunchEndMinutes: 810, dinnerStartMinutes: 1140, dinnerEndMinutes: 1260, openWeekdays: [0, 1, 2, 3, 4, 5, 6] } });
check('réglages des créneaux', r.status === 200);
r = await admin('/api/admin/settings', { method: 'PATCH', body: { ...originalSettings, lunchStartMinutes: 900, lunchEndMinutes: 800 } });
check('réglages incohérents → 400', r.status === 400);

// Click & collect
r = await customer('/api/session');
check('client validé', r.data.user?.verified === true);
r = await customer('/api/slots?kind=pickup&date=' + DATE);
check('créneaux de retrait', r.status === 200 && r.data.slots.length === 14 && r.data.slots[0].time === '12:00', JSON.stringify(r.data.slots?.slice(0, 2)));
// Premier créneau libre : la recette peut être rejouée sur la même base locale.
const PICKUP = r.data.slots.find((s) => s.available)?.time;
const burger = products.find((p) => p.slug === 'le-p-tit-cheese');
const gourmand = products.find((p) => p.slug === 'le-gourmand');
const items = [{ productId: burger.id, quantity: 2 }, { productId: gourmand.id, quantity: 1 }];
r = await customer('/api/orders', { method: 'POST', body: { date: DATE, time: PICKUP, note: 'Sans oignons', items } });
check('commande', r.status === 201 && r.data.order.subtotalCents === burger.priceCents * 2 + gourmand.priceCents, JSON.stringify(r.data));
const orderId = r.data.order?.id;
r = await customer('/api/orders', { method: 'POST', body: { date: DATE, time: PICKUP, note: '', items: [{ productId: burger.id, quantity: 1 }] } });
check('2e commande sur le créneau', r.status === 201);
r = await customer('/api/orders', { method: 'POST', body: { date: DATE, time: PICKUP, note: '', items: [{ productId: burger.id, quantity: 1 }] } });
check('créneau de retrait complet → 409', r.status === 409);
r = await customer('/api/orders', { method: 'POST', body: { date: DATE, time: '12:07', note: '', items } });
check('heure hors grille → 400', r.status === 400);
r = await customer('/api/orders', { method: 'POST', body: { date: DATE, time: '12:15', note: '', items: [{ productId: 'inconnu', quantity: 1 }] } });
check('produit inconnu → 400', r.status === 400);
r = await customer('/api/slots?kind=pickup&date=' + DATE);
check('créneau complet affiché', r.data.slots.find((s) => s.time === PICKUP)?.available === false);

// Réservations
r = await customer('/api/slots?kind=reservation&date=' + DATE);
const TABLE = r.data.slots.find((s) => s.available && s.time >= '19:00')?.time;
r = await customer('/api/reservations', { method: 'POST', body: { phone: '06 12 34 56 78', guests: 4, date: DATE, time: TABLE, note: 'Poussette' } });
check('réservation', r.status === 201 && r.data.reservation.status === 'CONFIRMED');
r = await customer('/api/reservations', { method: 'POST', body: { phone: '06 12 34 56 78', guests: 2, date: DATE, time: TABLE, note: '' } });
check('créneau de réservation complet → 409', r.status === 409);
r = await customer('/api/reservations', { method: 'POST', body: { phone: '06 12 34 56 78', guests: 40, date: DATE, time: '19:45', note: '' } });
check('trop de couverts → 400', r.status === 400);

// Historique client
r = await customer('/api/me/history');
check('historique client', r.status === 200 && r.data.reservations.length === 1 && r.data.orders.length === 2 && r.data.orders.some((o) => o.items.length === 2));

// Suivi côté restaurant
r = await admin('/api/admin/overview?period=week&date=' + DATE);
check('vue semaine', r.status === 200 && r.data.orders.filter((o) => o.email === email).length === 2 && r.data.reservations.some((x) => x.email === email));
const reservation = r.data.reservations.find((x) => x.email === email);
r = await admin('/api/admin/orders/' + orderId, { method: 'PATCH', body: { status: 'READY' } });
check('commande prête', r.status === 200);
r = await admin('/api/admin/orders/' + orderId, { method: 'PATCH', body: { status: 'COLLECTED' } });
check('commande retirée', r.status === 200);
r = await admin('/api/admin/orders/' + orderId, { method: 'PATCH', body: { status: 'PREPARING' } });
check('commande clôturée → 409', r.status === 409);
r = await customer('/api/session');
check('points de fidélité', r.data.user.loyaltyPoints === Math.floor((burger.priceCents * 2 + gourmand.priceCents) / 100), String(r.data.user.loyaltyPoints));
r = await admin('/api/admin/reservations/' + reservation.id, { method: 'PATCH', body: { status: 'CANCELLED' } });
check('refus sans motif → 400', r.status === 400);
r = await admin('/api/admin/reservations/' + reservation.id, { method: 'PATCH', body: { status: 'CANCELLED', reason: 'Fermeture exceptionnelle' } });
check('refus avec motif', r.status === 200);
r = await customer('/api/slots?kind=reservation&date=' + DATE);
check('créneau libéré', r.data.slots.find((s) => s.time === TABLE)?.available === true);

// Carte
r = await admin('/api/admin/products', { method: 'POST', body: { name: 'Burger Recette', category: 'BURGER', description: 'Produit de recette.', priceCents: 1234, available: true } });
check('ajout produit', r.status === 201 && r.data.product.slug === 'burger-recette');
const productId = r.data.product?.id;
r = await guest('/api/catalog');
check('produit visible', r.data.products.some((p) => p.id === productId));
r = await admin('/api/admin/products/' + productId, { method: 'PATCH', body: { name: 'Burger Recette', category: 'BURGER', description: 'Masqué.', priceCents: 1300, available: false } });
check('modification produit', r.status === 200);
r = await guest('/api/catalog');
check('produit masqué', !r.data.products.some((p) => p.id === productId));
r = await admin('/api/admin/products');
check('produit masqué visible en admin', r.data.products.some((p) => p.id === productId && !p.available && p.priceCents === 1300));
r = await admin('/api/admin/products/' + productId, { method: 'DELETE' });
check('suppression produit', r.status === 200);

// Contenu
r = await guest('/api/content');
const content = r.data.content;
r = await admin('/api/admin/content', { method: 'PATCH', body: { ...content, heroTitle: 'Titre de recette' } });
check('modification du contenu', r.status === 200);
r = await guest('/api/content');
check('contenu publié', r.data.content.heroTitle === 'Titre de recette');
await admin('/api/admin/content', { method: 'PATCH', body: content });

// Carrousel
let form = new FormData();
form.set('title', 'Photo de recette');
form.set('image', new Blob([PNG], { type: 'image/png' }), 'test.png');
r = await admin('/api/admin/carousel', { method: 'POST', body: form });
check('ajout photo', r.status === 201 && r.data.slide.image.startsWith('/media/'));
const slide = r.data.slide;
r = await guest(slide.image);
check('photo servie', r.status === 200 && r.headers.get('content-type') === 'image/png' && r.data.byteLength === PNG.length);
for (let i = 0; i < 5; i++) await admin('/api/admin/carousel/' + slide.id, { method: 'PATCH', body: { sortOrder: (await guest('/api/content')).data.slides.find((s) => s.id === slide.id).sortOrder - 10 } });
r = await guest('/api/content');
check('photo remontée en tête', r.data.slides[0].id === slide.id, r.data.slides.map((s) => s.title).join(', '));
r = await admin('/api/admin/carousel/' + slide.id, { method: 'DELETE' });
check('suppression photo', r.status === 200);
r = await guest(slide.image);
check('photo supprimée', r.status === 404);
form = new FormData();
form.set('title', 'Faux');
form.set('image', new Blob([new TextEncoder().encode('<script>alert(1)</script>')], { type: 'image/png' }), 'faux.png');
r = await admin('/api/admin/carousel', { method: 'POST', body: form });
check('faux fichier image → 400', r.status === 400);

// Protections
r = await admin('/api/admin/content', { method: 'PATCH', body: content, headers: { origin: 'https://exemple-malveillant.test' } });
check('autre origine → 403', r.status === 403);
r = await customer('/api/auth/logout', { method: 'POST' });
r = await customer('/api/session');
check('déconnexion', r.data.user === null);

// Remise des réglages d'origine
r = await admin('/api/admin/settings', { method: 'PATCH', body: originalSettings });
check('réglages restaurés', r.status === 200);

// Limitation des tentatives (en dernier)
const attacker = client();
const target = `inconnu-${Date.now()}@test.local`;
for (let i = 0; i < 10; i++) await attacker('/api/auth/login', { method: 'POST', body: { email: target, password: 'x'.repeat(12) } });
r = await attacker('/api/auth/login', { method: 'POST', body: { email: target, password: 'x'.repeat(12) } });
check('trop de tentatives → 429', r.status === 429);

console.log(`${passed} contrôles réussis, ${failures.length} en échec.`);
for (const f of failures) console.log('ÉCHEC : ' + f);
process.exit(failures.length ? 1 : 0);
