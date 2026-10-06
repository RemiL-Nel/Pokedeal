// Tests de la logique embarquée, sans dépendance : node test/core.test.js
const assert = require('node:assert/strict');
const http = require('node:http');
const { createCore, makeRequest, parseSetCookie } = require('../www/js/core.js');

/* ---------- Faux services ---------- */
const nowSec = () => Math.floor(Date.now() / 1000);
const vintedItems = [
  { id: 1, title: 'Dracaufeu 4/102 set de base', price: { amount: '20.0' }, total_item_price: { amount: '21.4' }, status: 'Bon état', photo: { url: 'http://x/1.jpg', high_resolution: { timestamp: String(nowSec() - 60) } }, user: { login: 'marie' }, url: '/items/1-dracaufeu' },
  { id: 2, title: 'Lot 200 cartes pokemon', price: { amount: '8.0' }, photo: { url: 'http://x/2.jpg', high_resolution: { timestamp: String(nowSec() - 120) } }, user: { login: 'paul' } },
  { id: 3, title: 'Pikachu 58/102', price: '2.0', total_item_price: { amount: '2.5' }, photo: { url: 'http://x/3.jpg', high_resolution: { timestamp: String(nowSec() - 300) } }, user: { login: 'lea' } },
];
const telegramSent = [];
const claudeCalls = [];
const langCalls = [];

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)).on('end', () => r(d)); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const vintedUrls = [];
const vintedHandler = (req, res) => {
  vintedUrls.push(req.url);
  if (req.url.startsWith('/boom/')) { res.writeHead(404); return res.end('{"code":"VNT-404"}'); }
  if (req.url.startsWith('/api/v2/catalog/items')) { res.writeHead(404); return res.end('{}'); } // ancien endpoint : mort depuis sept. 2026
  if (req.url.startsWith('/svc-catalogue/items')) {
    if (req.headers.authorization !== 'Bearer tok123' || req.headers['x-anon-id'] !== 'xyz') { res.writeHead(401); return res.end('{}'); }
    if (/[?&](price_to|price_from)=(&|$)/.test(req.url)) { res.writeHead(400); return res.end('{"code":"INVALID_REQUEST"}'); } // filtres vides refusés
    return json(res, 200, { items: vintedItems });
  }
  // cookies avec une virgule dans « Expires » : piège classique du découpage de set-cookie
  res.setHeader('set-cookie', ['access_token_web=tok123; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly', 'anon_id=xyz; Path=/']);
  res.writeHead(200); res.end('ok');
};
const claudeHandler = async (req, res) => {
  if (req.headers['x-api-key'] !== 'sk-test') return json(res, 401, { error: 'bad key' });
  const b = JSON.parse(await readBody(req));
  claudeCalls.push(b);
  const txt = JSON.stringify(b.messages);
  if (txt.includes('un seul mot') || txt.includes('UN seul mot')) {
    langCalls.push({ model: b.model, url: b.messages[0].content[0].source.url });
    const u = b.messages[0].content[0].source.url;
    return json(res, 200, { content: [{ type: 'text', text: u.includes('/en/') ? 'EN' : u.includes('/blur/') ? 'INCONNU' : u.includes('/fail/') ? 'FR' : 'FR' }] });
  }
  assert.ok(txt.includes('"type":"image"'), "l'identification doit envoyer une image");
  return json(res, 200, { content: [{ type: 'text', text: '{"name":"Charizard","name_fr":"Dracaufeu","set":"Base Set","number":"4/102","language":"FR","rarity":"Rare Holo","condition":"Bon état","condition_notes":"léger blanchiment"}' }] });
};
const tcgQueries = [];
const card = (name, number, set, total, prices) => ({ name, number, set: { name: set, printedTotal: total }, images: { small: 'x' }, cardmarket: { url: 'https://cm/x', prices } });
const tcgHandler = (req, res) => {
  const q = decodeURIComponent(req.url);
  tcgQueries.push(q);
  if (q.includes('number:"4" set.printedTotal:102')) return json(res, 200, { data: [card('Charizard', '4', 'Base Set', 102, { trendPrice: 80, avg30: 78, lowPrice: 60, reverseHoloTrend: 0 })] });
  if (q.includes('number:"58" set.printedTotal:102')) return json(res, 200, { data: [card('Pikachu', '58', 'Base Set', 102, { trendPrice: 3, avg30: 3, lowPrice: 1 })] });
  if (q.includes('number:"7" set.printedTotal:99')) return json(res, 200, { data: [card('Machin', '7', 'Set A', 99, { trendPrice: 80 }), card('Truc', '7', 'Set B', 99, { trendPrice: 30 })] });
  json(res, 200, { data: [] });
};
const tcgdexCalls = [];
let tcgdexDown = false;
const dexCard = (id, localId, name, trend, extra = {}) => ({ id, localId, name, image: 'http://img/' + id, pricing: { cardmarket: { trend, avg7: trend, avg30: trend, ...extra } } });
const tcgdexHandler = (req, res) => {
  tcgdexCalls.push(req.url);
  if (tcgdexDown) { res.writeHead(500); return res.end('{}'); }
  const u = req.url;
  if (u === '/v2/fr/sets') return json(res, 200, [{ id: 'base1', name: 'Set de Base', cardCount: { total: 102, official: 102 } }, { id: 'setA', name: 'Set A', cardCount: { total: 99, official: 99 } }, { id: 'setB', name: 'Set B', cardCount: { total: 99, official: 99 } }]);
  if (u === '/v2/fr/sets/base1') return json(res, 200, { id: 'base1', cards: [{ id: 'base1-4', localId: '4', name: 'Dracaufeu' }, { id: 'base1-58', localId: '58', name: 'Pikachu' }] });
  if (u === '/v2/fr/sets/setA') return json(res, 200, { id: 'setA', cards: [{ id: 'setA-7', localId: '7', name: 'Machin' }] });
  if (u === '/v2/fr/sets/setB') return json(res, 200, { id: 'setB', cards: [{ id: 'setB-7', localId: '007', name: 'Truc-EX' }] });
  if (u === '/v2/fr/cards/base1-4') return json(res, 200, dexCard('base1-4', '4', 'Dracaufeu', 80));
  if (u === '/v2/fr/cards/base1-58') return json(res, 200, dexCard('base1-58', '58', 'Pikachu', 3));
  if (u === '/v2/fr/cards/setA-7') return json(res, 200, dexCard('setA-7', '7', 'Machin', 80, { 'trend-holo': 120 }));
  if (u === '/v2/fr/cards/setB-7') return json(res, 200, dexCard('setB-7', '007', 'Truc-EX', 30));
  res.writeHead(404); res.end('{}');
};
const telegramHandler = async (req, res) => { telegramSent.push(JSON.parse(await readBody(req)).text); json(res, 200, { ok: true }); };

/* ---------- Faux Capacitor (forme de réponse lue dans le code source de CapacitorHttp) ---------- */
function fakeNative(log) {
  return {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          async request(req) {
            const ct = Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === 'content-type');
            if (req.data !== undefined) assert.equal(typeof req.data, 'object', 'Capacitor attend un objet pour un corps JSON');
            if (req.data !== undefined) assert.ok(ct && ct[1].includes('application/json'));
            log.push(req.url);
            const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.data !== undefined ? JSON.stringify(req.data) : undefined });
            const h = {};
            r.headers.forEach((v, k) => { h[k] = v; });
            const sc = r.headers.getSetCookie();
            if (sc.length) h['set-cookie'] = sc.join(', '); // Android joint les valeurs avec « , »
            const text = await r.text();
            const isJson = (r.headers.get('content-type') || '').includes('application/json');
            return { status: r.status, headers: h, data: isJson ? JSON.parse(text) : text, url: req.url };
          },
        },
      },
    },
  };
}

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Mini lanceur ---------- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

(async () => {
  const [vinted, claude, tcg, tg, dex] = await Promise.all([listen(vintedHandler), listen(claudeHandler), listen(tcgHandler), listen(telegramHandler), listen(tcgdexHandler)]);
  const mk = (extra = {}, rt = globalThis) =>
    createCore({ request: makeRequest(rt), storage: memStorage(), vintedBase: vinted.url, anthropicBase: claude.url, tcgBase: tcg.url, tgBase: tg.url, tcgdexBase: dex.url, minWatch: 1, ...extra });

  test('parseSetCookie : tableau, chaîne jointe, virgule dans Expires', () => {
    assert.equal(parseSetCookie(['a=1; Path=/', 'b=2; HttpOnly']), 'a=1; b=2');
    assert.equal(parseSetCookie('a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly, b=2; Path=/'), 'a=1; b=2');
    assert.equal(parseSetCookie(''), '');
    assert.equal(parseSetCookie(undefined), '');
  });

  test("Vinted : nouvel endpoint svc-catalogue, jeton anonyme, URL relative rendue absolue, filtres vides omis", async () => {
    vintedUrls.length = 0;
    const core = mk();
    const j = await core.api('/api/recent?q=carte+pokemon&min=&max=');
    assert.equal(j.items.length, 3);
    assert.ok(vintedUrls.some((u) => u.startsWith('/svc-catalogue/items')));
    assert.ok(!vintedUrls.some((u) => u.startsWith('/api/v2/catalog')), "l'ancien endpoint ne doit plus être appelé");
    assert.match(j.items[0].url, /^https?:\/\/.+\/items\/1-dracaufeu$/);
    assert.equal(j.items[2].price, 2); // prix en chaîne ou en objet
  });

  test('parseTitle : numéro/total, lots, gradées, étrangères, ambiguës', () => {
    const { parseTitle } = createCore({ request: makeRequest(globalThis), storage: memStorage() });
    assert.deepEqual([parseTitle('Dracaufeu 004/102 holo').single, parseTitle('Dracaufeu 004/102 holo').number, parseTitle('Dracaufeu 004/102 holo').total], [true, '4', 102]);
    assert.equal(parseTitle('Carte Pokémon Mew 151/165 reverse').reverse, true);
    assert.equal(parseTitle('Lot 200 cartes pokemon').lotCount, 200);
    assert.equal(parseTitle('Lot de 3 cartes 4/102 5/102 6/102').single, false);
    assert.equal(parseTitle('Dracaufeu 4/102 PSA 9').single, false);
    assert.equal(parseTitle('Dracaufeu 4/102 PSA 9').graded, true);
    assert.equal(parseTitle('Pikachu 25/165 japonais').single, false);
    assert.equal(parseTitle('Booster pokemon 151').single, false);
    assert.equal(parseTitle('rdv le 12/10 pour carte').single, false);
    assert.equal(parseTitle('Pikachu holo rare').single, false);
  });

  test('Récent : score par formule, sans clé Anthropic, lot et inconnues sans score', async () => {
    const claudeBefore = claudeCalls.length;
    const core = mk();
    const j = await core.api('/api/recent?q=carte+pokemon|pokemone');
    assert.equal(j.scoring, true);
    const byId = Object.fromEntries(j.items.map((i) => [i.id, i]));
    // 80 × 0,9 × 0,95 = 68,4 ; coût = 21,4 + 3 = 24,4 ; marge 44 ; ROI 180 % → score 90
    assert.equal(byId[1].deal.margin, 44);
    assert.equal(byId[1].deal.score, 90);
    assert.equal(byId[1].deal.level, 'top');
    assert.equal(byId[1].analysis.name, 'Dracaufeu');
    assert.equal(byId[2].deal, null);
    assert.deepEqual(byId[2].lot, { count: 200, perCard: 0.04 });
    assert.equal(byId[3].deal.level, 'none'); // Pikachu à 3 € : marge négative
    assert.equal(byId[3].deal.score, 0);
    assert.equal(claudeCalls.length, claudeBefore, "aucun appel à l'API Claude pour scorer");
  });

  test('Reconnaissance : le nom français du titre tranche entre extensions de même numéro/total', async () => {
    const saved = vintedItems.slice();
    vintedItems.length = 0;
    vintedItems.push({ id: 7, title: 'Truc ex 7/99 neuve', price: { amount: '1.0' }, photo: { url: 'x' }, user: { login: 'a' } }); // Set B (nom EX dans le titre)
    vintedItems.push({ id: 8, title: 'Machin 007/99 reverse', price: { amount: '1.0' }, photo: { url: 'x' }, user: { login: 'b' } }); // Set A, reverse holo
    vintedItems.push({ id: 9, title: 'Carte pokemon 7/99', price: { amount: '0.5' }, photo: { url: 'x' }, user: { login: 'c' } }); // pas de nom, 2 extensions : non identifiée
    vintedItems.push({ id: 10, title: 'Carte neuve 4/102', price: { amount: '5.0' }, photo: { url: 'x' }, user: { login: 'd' } }); // pas de nom mais 1 seule extension
    vintedItems.push({ id: 11, title: 'Mewtwo 4/102', price: { amount: '5.0' }, photo: { url: 'x' }, user: { login: 'e' } }); // mauvais nom : le nom connu est Dracaufeu
    const core = mk();
    const j = await core.api('/api/recent?q=x');
    vintedItems.length = 0;
    vintedItems.push(...saved);
    const byId = Object.fromEntries(j.items.map((i) => [i.id, i]));
    assert.equal(byId[7].deal.matched.startsWith('Truc-EX — Set B'), true);
    assert.equal(byId[7].deal.market, 30);
    assert.equal(byId[7].deal.score, 100);
    assert.equal(byId[7].deal.level, 'top');
    assert.equal(byId[8].deal.market, 120, 'reverse : prix holo');
    assert.equal(byId[9].deal, null, 'ambiguë sans nom : pas de score plutôt qu\'un faux');
    assert.equal(byId[10].deal.unverified, true);
    assert.equal(byId[10].deal.level, 'good', 'nom absent du titre : jamais « top »');
    assert.equal(byId[10].deal.gap, Math.round((5 / 80 - 1) * 100));
    assert.equal(byId[11].deal.unverified, true, 'une seule extension possible : acceptée mais signalée');
  });

  test('Repli pokemontcg.io si TCGdex est en panne : seulement si le numéro est sans ambiguïté', async () => {
    const saved = vintedItems.slice();
    vintedItems.length = 0;
    vintedItems.push({ id: 21, title: 'Pikachu 58/102', price: { amount: '1.0' }, photo: { url: 'x' }, user: { login: 'a' } });
    vintedItems.push({ id: 22, title: 'Truc 7/99', price: { amount: '1.0' }, photo: { url: 'x' }, user: { login: 'b' } });
    tcgdexDown = true;
    try {
      const j = await mk().api('/api/recent?q=x');
      const byId = Object.fromEntries(j.items.map((i) => [i.id, i]));
      assert.equal(byId[21].deal.market, 3);
      assert.equal(byId[21].deal.unverified, true);
      assert.equal(byId[22].deal, null, 'deux cartes possibles : rien');
    } finally {
      tcgdexDown = false;
      vintedItems.length = 0;
      vintedItems.push(...saved);
    }
  });

  test('Cache : une extension / carte n\'est demandée qu\'une fois', async () => {
    tcgdexCalls.length = 0;
    const core = mk();
    await core.api('/api/recent?q=a');
    const n = tcgdexCalls.length;
    await core.api('/api/recent?q=b');
    assert.equal(tcgdexCalls.length, n, 'deuxième rafraîchissement : aucun nouvel appel TCGdex');
  });

  test('Langue : titre explicite, nom français, puis photo (IA) seulement si nécessaire', async () => {
    const saved = vintedItems.slice();
    vintedItems.length = 0;
    const mkItem = (id, title, photo = 'http://x/' + id + '.jpg') => ({ id, title, price: { amount: '5.0' }, photo: { url: photo }, user: { login: 'u' + id } });
    vintedItems.push(mkItem(31, 'Dracaufeu 4/102 FR'));                    // FR dans le titre
    vintedItems.push(mkItem(32, 'Dracaufeu 4/102 version anglaise'));      // anglais dans le titre
    vintedItems.push(mkItem(33, 'Carte neuve 4/102', 'http://x/en/33.jpg')); // rien dans le titre, photo anglaise
    vintedItems.push(mkItem(34, 'Carte neuve 58/102', 'http://x/fr/34.jpg')); // rien dans le titre, photo française
    vintedItems.push(mkItem(35, 'Dracaufeu 4/102 neuf'));                  // nom français dans le titre
    vintedItems.push(mkItem(36, 'Carte neuve 4/102 EN'));                  // code EN
    vintedItems.push(mkItem(37, 'CARTE NEUVE EN POCHETTE 4/102'));         // titre en majuscules : « EN » est du français ici
    try {
      // sans clé : pas d'appel IA, la langue vient du titre
      langCalls.length = 0;
      let j = await mk().api('/api/recent?q=x');
      let by = Object.fromEntries(j.items.map((i) => [i.id, i]));
      assert.equal(langCalls.length, 0);
      assert.equal(by[31].lang, 'fr');
      assert.equal(by[35].lang, 'fr'); assert.equal(by[35].langSrc, 'nom');
      assert.equal(by[32], undefined, 'anglaise dans le titre : masquée');
      assert.equal(by[36], undefined, 'EN : masquée');
      assert.equal(by[33].lang, 'unknown');
      assert.ok(by[37], 'EN en majuscules dans un titre tout en majuscules : pas une langue');
      assert.equal(j.hiddenOther, 2);
      // avec clé + vérification photo : seules les annonces sans indice partent à l'IA, modèle économique
      const core = mk();
      await core.api('/api/settings', 'POST', { anthropicKey: 'sk-test', langCheck: true });
      j = await core.api('/api/recent?q=x');
      by = Object.fromEntries(j.items.map((i) => [i.id, i]));
      assert.equal(by[33], undefined, 'photo en anglais : masquée');
      assert.equal(by[34].lang, 'fr'); assert.equal(by[34].langSrc, 'photo');
      const urls = langCalls.map((c) => c.url);
      assert.ok(urls.includes('http://x/en/33.jpg') && urls.includes('http://x/fr/34.jpg'));
      assert.ok(!urls.some((u) => /\/(31|32|35|36)\.jpg$/.test(u)), 'pas de photo envoyée quand le titre ou le nom suffit');
      assert.ok(langCalls.every((c) => /haiku/.test(c.model)));
      const n = langCalls.length;
      await core.api('/api/recent?q=x');
      assert.equal(langCalls.length, n, 'résultat mis en cache : pas de nouvel appel');
      // FR seulement désactivé : tout revient
      await core.api('/api/settings', 'POST', { frOnly: false });
      j = await core.api('/api/recent?q=x');
      assert.ok(j.items.find((i) => i.id === 33) && j.items.find((i) => i.id === 32));
    } finally {
      vintedItems.length = 0;
      vintedItems.push(...saved);
    }
  });

  test('Langue : mauvaise clé => annonces conservées, erreur signalée', async () => {
    const saved = vintedItems.slice();
    vintedItems.length = 0;
    vintedItems.push({ id: 41, title: 'Carte neuve 4/102', price: { amount: '5.0' }, photo: { url: 'http://x/41.jpg' }, user: { login: 'a' } });
    try {
      const core = mk();
      await core.api('/api/settings', 'POST', { anthropicKey: 'mauvaise', langCheck: true });
      const j = await core.api('/api/recent?q=x');
      assert.equal(j.items.length, 1);
      assert.match(j.langError, /401/);
    } finally {
      vintedItems.length = 0;
      vintedItems.push(...saved);
    }
  });

  test('Chemin natif Android : cookies en chaîne jointe, jeton lu depuis set-cookie', async () => {
    const log = [];
    const core = mk({}, fakeNative(log));
    const j = await core.api('/api/recent?q=carte+pokemon');
    assert.equal(j.items.length, 3);
    assert.equal(j.items.find((i) => i.id === 1).deal.level, 'top');
    assert.ok(log.some((u) => u.includes('/svc-catalogue/items')));
    assert.ok(!log.some((u) => u.includes('/v1/messages')));
  });

  test('Vinted en erreur : message lisible avec le code et un extrait', async () => {
    const core = mk({ vintedApiBase: vinted.url + '/boom' });
    await assert.rejects(core.api('/api/recent?q=carte+pokemon'), /Vinted a répondu 404 : .*VNT-404/);
  });

  test('État : les secrets ne sont jamais renvoyés', async () => {
    const core = mk();
    await core.api('/api/settings', 'POST', { anthropicKey: 'sk-test', tgToken: 'TOKEN-SECRET', tgChat: '42' });
    const s = await core.api('/api/state');
    assert.equal(s.settings.hasAnthropicKey, true);
    assert.equal(s.settings.hasTelegram, true);
    assert.ok(!JSON.stringify(s).includes('sk-test') && !JSON.stringify(s).includes('TOKEN-SECRET'));
    await core.api('/api/settings', 'POST', { clear: ['anthropicKey', 'tgToken', 'tgChat'] });
    const s2 = await core.api('/api/state');
    assert.equal(s2.settings.hasAnthropicKey, false);
    assert.equal(s2.config.canIdentify, false);
    assert.equal(s2.config.canScore, true, 'le score ne dépend plus de la clé');
  });

  test('Stock, budget, bénéfices et validations', async () => {
    const core = mk();
    await core.api('/api/budget', 'POST', { monthly: 100 });
    const a = await core.api('/api/inventory', 'POST', { name: 'Charizard 4/102', buyPrice: 21.4, buyShip: 3, url: 'https://www.vinted.fr/items/1', marketAtBuy: 80 });
    assert.equal(a.stats.remaining, 75.6);
    const b = await core.api('/api/inventory/' + a.item.id, 'POST', { status: 'sold', sellPrice: 70, sellFees: 3.5 });
    assert.equal(b.stats.profit, 42.1);
    assert.equal(b.stats.revenue, 66.5);
    await assert.rejects(core.api('/api/inventory', 'POST', { name: '', buyPrice: 5 }), /Nom manquant/);
    await assert.rejects(core.api('/api/inventory', 'POST', { name: 'x', buyPrice: -3 }), /Prix invalide/);
    await assert.rejects(core.api('/api/inventory/999', 'POST', { status: 'sold' }), /Introuvable/);
    const d = await core.api('/api/inventory/' + a.item.id, 'DELETE');
    assert.equal(d.stats.count, 0);
  });

  test('Persistance : un nouveau moteur retrouve le stock', async () => {
    const storage = memStorage();
    const c1 = createCore({ request: makeRequest(globalThis), storage });
    await c1.api('/api/inventory', 'POST', { name: 'Pikachu', buyPrice: 2 });
    const c2 = createCore({ request: makeRequest(globalThis), storage });
    assert.equal((await c2.api('/api/state')).inventory.length, 1);
  });

  test('Export puis import : aller-retour et fichier invalide refusé', async () => {
    const c1 = mk();
    await c1.api('/api/budget', 'POST', { monthly: 50 });
    await c1.api('/api/inventory', 'POST', { name: 'A', buyPrice: 1 });
    await c1.api('/api/inventory', 'POST', { name: 'B', buyPrice: 2 });
    const dump = JSON.parse(JSON.stringify(await c1.api('/api/export')));
    assert.ok(!JSON.stringify(dump).includes('sk-'), "l'export ne contient pas de clé");
    const c2 = mk();
    const r = await c2.api('/api/import', 'POST', dump);
    assert.equal(r.imported, 2);
    assert.equal(r.stats.monthly, 50);
    const after = await c2.api('/api/inventory', 'POST', { name: 'C', buyPrice: 3 });
    assert.ok(![...dump.state.inventory].some((i) => i.id === after.item.id), "les nouveaux ids ne doivent pas entrer en collision");
    await assert.rejects(c2.api('/api/import', 'POST', { foo: 1 }), /invalide/);
  });

  test('Identification de carte + annonce prête', async () => {
    const core = mk();
    await assert.rejects(core.api('/api/identify', 'POST', { image: 'data:image/jpeg;base64,AAAA' }), /clé Anthropic/);
    await core.api('/api/settings', 'POST', { anthropicKey: 'sk-test' });
    const j = await core.api('/api/identify', 'POST', { image: 'data:image/jpeg;base64,AAAA' });
    assert.equal(j.card.name_fr, 'Dracaufeu');
    assert.equal(j.market.trend, 80);
    assert.equal(j.listing.suggestedPrice, 80);
    assert.match(j.listing.title, /Dracaufeu 4\/102 Base Set FR/);
  });

  test('Alertes : premier passage silencieux, puis notif + Telegram pour la bonne affaire seulement', async () => {
    const notes = [];
    telegramSent.length = 0;
    const core = mk({ notify: async (n) => notes.push(n), ensureNotifyPermission: async () => true });
    await core.api('/api/settings', 'POST', { tgToken: 'tok', tgChat: '42' });
    await core.api('/api/watch', 'POST', { enabled: true, queries: ['carte pokemon'], onlyDeals: true, intervalSec: 1 });
    await sleep(1500);
    assert.equal(notes.length, 0, 'premier passage : rien envoyé');
    vintedItems.unshift({ id: 99, title: 'Dracaufeu 4/102 neuf', price: { amount: '15.0' }, total_item_price: { amount: '16.0' }, photo: { url: 'http://x/99.jpg', high_resolution: { timestamp: String(nowSec()) } }, user: { login: 'new' } });
    vintedItems.unshift({ id: 100, title: 'Lot cartes variées', price: { amount: '3.0' }, photo: { url: 'http://x/100.jpg', high_resolution: { timestamp: String(nowSec()) } }, user: { login: 'new2' } });
    await sleep(2800);
    await core.api('/api/watch', 'POST', { enabled: false });
    assert.equal(notes.length, 1, 'seule la bonne affaire déclenche une alerte');
    assert.match(notes[0].title, /🔥 Score \d+\/100 · marge \+\d/);
    assert.equal(telegramSent.length, 1);
    assert.match(telegramSent[0], /Dracaufeu 4\/102 neuf/);
    const st = (await core.api('/api/state')).watchStatus;
    assert.equal(st.running, false);
    assert.equal(st.sent, 1);
  });

  test('Alertes : permission de notification refusée => activation refusée', async () => {
    const core = mk({ ensureNotifyPermission: async () => false });
    await assert.rejects(core.api('/api/watch', 'POST', { enabled: true }), /notifications/);
    assert.equal((await core.api('/api/state')).watch.enabled, false);
  });

  test("Isolation : modifier une réponse n'altère pas l'état interne (bug de doublon corrigé)", async () => {
    const core = mk();
    const a = await core.api('/api/inventory', 'POST', { name: 'Zard', buyPrice: 10 });
    const s = await core.api('/api/state');
    s.inventory.unshift(a.item); // ce que faisait l'interface
    s.inventory[0].name = 'MODIFIÉ';
    const s2 = await core.api('/api/state');
    assert.equal(s2.inventory.length, 1);
    assert.equal(s2.inventory[0].name, 'Zard');
    assert.equal(s2.stats.invested, 10);
  });

  test('Route inconnue', async () => {
    await assert.rejects(mk().api('/api/nimportequoi'), /Route inconnue/);
  });

  /* ---------- Exécution ---------- */
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('✔', t.name);
    } catch (e) {
      failed++;
      console.log('✘', t.name, '\n   ', e && e.message ? e.message : e);
    }
  }
  for (const x of [vinted, claude, tcg, tg, dex]) x.s.close();
  console.log(failed ? `\n${failed} test(s) en échec` : `\n${tests.length} tests OK`);
  process.exit(failed ? 1 : 0);
})();
