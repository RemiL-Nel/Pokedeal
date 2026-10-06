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
  if (q.includes('number:"21" set.printedTotal:62')) return json(res, 200, { data: [card('Haunter', '21', 'Fossil', 62, { trendPrice: 36 })] });
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
  if (u === '/v2/fr/sets') return json(res, 200, [{ id: 'base1', name: 'Set de Base', cardCount: { total: 102, official: 102 } }, { id: 'setA', name: 'Set A', cardCount: { total: 99, official: 99 } }, { id: 'setB', name: 'Set B', cardCount: { total: 99, official: 99 } }, { id: 'fossil1', name: 'Fossile', cardCount: { total: 62, official: 62 } }, { id: 'hskit', name: 'HS Kit du dresseur (Raichu)', cardCount: { total: 30, official: 30 } }, { id: 'm30', name: 'Pokémon 30 ans', cardCount: { total: 128, official: 128 } }]);
  if (u === '/v2/fr/sets/base1') return json(res, 200, { id: 'base1', cards: [{ id: 'base1-4', localId: '4', name: 'Dracaufeu' }, { id: 'base1-58', localId: '58', name: 'Pikachu' }] });
  if (u === '/v2/fr/sets/setA') return json(res, 200, { id: 'setA', cards: [{ id: 'setA-7', localId: '7', name: 'Machin' }] });
  if (u === '/v2/fr/sets/setB') return json(res, 200, { id: 'setB', cards: [{ id: 'setB-7', localId: '007', name: 'Truc-EX' }] });
  if (u === '/v2/fr/sets/fossil1') return json(res, 200, { id: 'fossil1', cards: [{ id: 'fossil1-21', localId: '21', name: 'Spectrum' }] });
  if (u === '/v2/fr/sets/hskit') return json(res, 200, { id: 'hskit', cards: [{ id: 'hskit-16', localId: '16', name: 'Pikachu' }] });
  if (u === '/v2/fr/sets/m30') return json(res, 200, { id: 'm30', cards: [{ id: 'm30-38', localId: '038', name: 'Pikachu' }] });
  if (u === '/v2/fr/cards/hskit-16') return json(res, 200, dexCard('hskit-16', '16', 'Pikachu', 12.04));
  if (u === '/v2/fr/cards/m30-38') return json(res, 200, dexCard('m30-38', '038', 'Pikachu', 3.5));
  if (u === '/v2/fr/cards/fossil1-21') return json(res, 200, dexCard('fossil1-21', '21', 'Spectrum', 36.35));
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
// la lecture des photos tourne en arrière-plan : on rafraîchit jusqu'à ce qu'il n'y ait plus d'annonce en attente
const settle = async (core, path = '/api/recent?q=x') => { let j; for (let i = 0; i < 25; i++) { j = await core.api(path); if (!j.pending) break; await sleep(30); } return j; };

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

  const withItems = async (list, fn) => {
    const saved = vintedItems.slice();
    vintedItems.length = 0;
    vintedItems.push(...list.map(([id, title, photo]) => ({ id, title, price: { amount: '5.0' }, photo: { url: photo || 'http://x/' + id + '.jpg' }, user: { login: 'u' + id } })));
    try { return await fn(); } finally { vintedItems.length = 0; vintedItems.push(...saved); }
  };

  test('Reconnaissance : nom français OU extension citée dans le titre, sinon pas de carte', async () => {
    await withItems([
      [7, 'Truc ex 7/99 neuve'],            // nom (Set B) dans le titre
      [8, 'Machin 007/99 reverse'],         // nom (Set A) + reverse holo
      [9, 'Carte pokemon 7/99'],            // 2 extensions, aucun nom : rien
      [10, 'Carte neuve 4/102'],            // 1 extension mais aucune preuve : rien (pourrait être une carte étrangère)
      [11, 'Mewtwo 4/102'],                 // mauvais nom : rien
      [12, 'Haunter 21/62 set fossil'],     // nom anglais mais extension citée : accepté, signalé
    ], async () => {
      await core0().api('/api/settings', 'POST', {});
      const core = mk();
      await core.api('/api/settings', 'POST', { frMode: 'off' });
      const j = await core.api('/api/recent?q=x');
      const by = Object.fromEntries(j.items.map((i) => [i.id, i]));
      assert.equal(by[7].deal.matched.startsWith('Truc-EX — Set B'), true);
      assert.equal(by[7].deal.market, 30);
      assert.equal(by[7].deal.score, 100);
      assert.equal(by[7].deal.level, 'top');
      assert.equal(by[8].deal.market, 120, 'reverse : prix holo');
      assert.equal(by[9].deal, null);
      assert.equal(by[10].deal, null, 'numéro seul : pas assez sûr');
      assert.equal(by[11].deal, null);
      assert.equal(by[12].deal.unverified, true);
      assert.equal(by[12].deal.market, 36.35);
      assert.equal(by[12].deal.level, 'good', 'nom absent du titre : jamais « top »');
      assert.equal(by[12].deal.gap, Math.round((5 / 36.35 - 1) * 100));
    });
  });
  const core0 = () => mk();

  test('Repli pokemontcg.io si TCGdex est en panne : une seule carte possible ET extension citée', async () => {
    await withItems([[21, 'Haunter 21/62 fossil'], [22, 'Pikachu 58/102'], [23, 'Truc 7/99']], async () => {
      tcgdexDown = true;
      try {
        const core = mk();
        await core.api('/api/settings', 'POST', { frMode: 'off' });
        const j = await core.api('/api/recent?q=x');
        const by = Object.fromEntries(j.items.map((i) => [i.id, i]));
        assert.equal(by[21].deal.market, 36);
        assert.equal(by[21].deal.unverified, true);
        assert.equal(by[22].deal, null, 'aucune preuve (nom ou extension) : rien');
        assert.equal(by[23].deal, null, 'deux cartes possibles : rien');
      } finally { tcgdexDown = false; }
    });
  });

  test('Marge : détail du calcul, décote réglable, prix de référence saisi à la main', async () => {
    const core = mk();
    let j = await core.api('/api/recent?q=carte+pokemon');
    let d = j.items.find((i) => i.id === 1).deal;
    // achat 21,4 + port 3 = 24,4 ; revente 80 × (1 − 10 %) × (1 − 5 %) = 68,4 ; marge 44
    assert.deepEqual([d.paid, d.ship, d.cost, d.sell, d.margin, d.source], [21.4, 3, 24.4, 68.4, 44, 'cardmarket']);
    await core.api('/api/settings', 'POST', { haircut: 0 });
    j = await core.api('/api/recent?q=carte+pokemon');
    d = j.items.find((i) => i.id === 1).deal;
    assert.deepEqual([d.sell, d.margin], [76, 51.6]);
    // prix saisi à la main (ex. Cardmarket FR near mint, ventes eBay) : remplace le prix Cardmarket, sans décote
    await core.api('/api/ref', 'POST', { key: j.items.find((i) => i.id === 1).refKey, price: 50 });
    j = await core.api('/api/recent?q=carte+pokemon');
    d = j.items.find((i) => i.id === 1).deal;
    assert.deepEqual([d.source, d.market, d.sell, d.margin], ['manuel', 50, 47.5, 23.1]);
    const exp = await core.api('/api/export');
    assert.equal(exp.state.refPrices['4/102'], 50);
    await core.api('/api/ref', 'POST', { key: '4/102', price: 0 });
    j = await core.api('/api/recent?q=carte+pokemon');
    assert.equal(j.items.find((i) => i.id === 1).deal.source, 'cardmarket');
    await assert.rejects(core.api('/api/ref', 'POST', { price: 5 }), /Carte inconnue/);
  });

  test('Score : toujours là, ou une raison explicite ; prix manuel possible sur une carte non identifiée', async () => {
    await withItems([
      [61, 'Lot 50 cartes pokemon'],
      [62, 'Dracaufeu 4/102 PSA 9'],
      [63, 'Pikachu holo rare'],
      [64, 'Carte neuve 4/102'],
      [65, 'Dracaufeu 4/102'],
    ], async () => {
      const core = mk();
      await core.api('/api/settings', 'POST', { frMode: 'off' });
      let j = await core.api('/api/recent?q=x');
      const by = Object.fromEntries(j.items.map((i) => [i.id, i]));
      assert.match(by[61].scoreReason, /lot de 50 cartes/);
      assert.match(by[62].scoreReason, /gradée/);
      assert.match(by[63].scoreReason, /carte non reconnue/);
      assert.match(by[64].scoreReason, /non identifiée/);
      assert.equal(by[65].scoreReason, '');
      assert.ok(by[65].deal);
      assert.ok(j.items.every((i) => i.deal || i.scoreReason), 'chaque annonce a un score ou une raison');
      // prix de revente saisi à la main sur une annonce non identifiée : score calculé
      await core.api('/api/ref', 'POST', { key: by[63].refKey, price: 20 });
      j = await core.api('/api/recent?q=x');
      const d = j.items.find((i) => i.id === 63).deal;
      assert.equal(d.source, 'manuel');
      assert.equal(d.margin, 11); // 20 × 0,95 − (5 + 3)
    });
  });

  test('Recoupe numéro du titre / numéros imprimés sur la carte (badge 16/30 vs 038/128)', async () => {
    const PIKA_TEXT = 'Pikachu PV 60\nÉtincelle Ciblée Cette attaque inflige 20 dégâts\nFaiblesse x2 Résistance Retraite\n038/128 16/30';
    await withItems([[71, 'Pikachu 16/30 Pokémon 30 ans', 'http://x/pika/71.jpg']], async () => {
      // sans OCR : le titre seul identifie la carte du kit HS (12,04 €)
      let core = mk();
      await core.api('/api/settings', 'POST', { frMode: 'off' });
      let d = (await core.api('/api/recent?q=x')).items[0].deal;
      assert.equal(d.market, 12.04);
      // avec OCR : la carte porte aussi 038/128 (extension « Pokémon 30 ans ») : plus grand total retenu, signalé moins sûr
      core = mk({ ocr: async () => PIKA_TEXT });
      await core.api('/api/settings', 'POST', { frMode: 'off' });
      const j = await settle(core);
      d = j.items[0].deal;
      assert.equal(d.market, 3.5);
      assert.match(d.matched, /Pokémon 30 ans 038\/128/);
      assert.equal(d.unverified, true);
      assert.equal(j.items[0].refKey, '38/128');
    });
  });

  test('Reconnaissance par la photo : titre sans nom, titre sans numéro, photo illisible', async () => {
    await withItems([
      [81, 'Carte neuve 4/102', 'http://x/fr/81.jpg'],        // numéro mais pas de nom : le nom imprimé sur la carte valide
      [82, 'Carte holo rare neuve', 'http://x/fr/82.jpg'],    // pas de numéro : lu sur la carte
      [83, 'Carte neuve 4/102', 'http://x/blur/83.jpg'],      // photo illisible : rien
    ], async () => {
      const ocr = async (url) => (url.includes('/fr/') ? FR_TEXT : 'flou');
      // sans OCR : aucune des trois n'est identifiée
      let j = await (async () => { const c = mk(); await c.api('/api/settings', 'POST', { frMode: 'off' }); return c.api('/api/recent?q=x'); })();
      assert.ok(j.items.every((i) => !i.deal));
      const core = mk({ ocr });
      await core.api('/api/settings', 'POST', { frMode: 'off' });
      j = await settle(core);
      const by = Object.fromEntries(j.items.map((i) => [i.id, i]));
      assert.equal(by[81].deal.market, 80);
      assert.equal(by[81].deal.via, 'photo');
      assert.equal(by[82].deal.market, 80);
      assert.equal(by[82].refKey, '4/102');
      assert.equal(by[83].deal, null);
      assert.match(by[83].scoreReason, /non identifiée|non reconnue/);
    });
  });

  test('Reconnaissance nom + extension (titre sans numéro) et vérification par mot entier', async () => {
    await withItems([
      [91, 'Spectrum fossile neuf'],     // extension « Fossile » + nom unique dans cette extension
      [92, 'Spectrum holo'],             // pas d'extension : rien
      [93, 'Machinette 7/99'],           // « Machinette » n'est pas « Machin »
      [94, 'Machin 7/99'],               // mot entier : accepté
    ], async () => {
      const core = mk();
      await core.api('/api/settings', 'POST', { frMode: 'off' });
      const by = Object.fromEntries((await core.api('/api/recent?q=x')).items.map((i) => [i.id, i]));
      assert.equal(by[91].deal.market, 36.35);
      assert.equal(by[91].deal.via, 'extension');
      assert.equal(by[91].refKey, '21/62');
      assert.equal(by[92].deal, null);
      assert.equal(by[93].deal, null);
      assert.equal(by[94].deal.market, 80);
    });
  });

  test('Cache : une extension / carte n\'est demandée qu\'une fois', async () => {
    tcgdexCalls.length = 0;
    const core = mk();
    await core.api('/api/recent?q=a');
    const n = tcgdexCalls.length;
    await core.api('/api/recent?q=b');
    assert.equal(tcgdexCalls.length, n, 'deuxième rafraîchissement : aucun nouvel appel TCGdex');
  });

  test('Filtre FR : strict (confirmée), loose (pas de langue étrangère), off ; IA seulement si nécessaire', async () => {
    await withItems([
      [31, 'Dracaufeu 4/102 FR'],
      [32, 'Dracaufeu 4/102 version anglaise'],
      [33, 'Carte neuve 4/102', 'http://x/en/33.jpg'],
      [34, 'Carte neuve 58/102', 'http://x/fr/34.jpg'],
      [35, 'Dracaufeu 4/102 neuf'],
      [36, 'Carte neuve 4/102 EN'],
      [37, 'CARTE NEUVE EN BON ETAT 4/102'],
      [38, 'Lot 200 cartes pokemon'],
    ], async () => {
      const ids = (j) => j.items.map((i) => i.id).sort((x, y) => x - y);
      // sans clé ni OCR : seules les cartes confirmées françaises restent (titre FR, nom français) ; le lot est conservé
      langCalls.length = 0;
      const core = mk();
      let j = await core.api('/api/recent?q=x');
      assert.deepEqual(ids(j), [31, 35, 38]);
      assert.deepEqual(j.hidden, { other: 2, unverified: 3 });
      assert.equal(langCalls.length, 0);
      await core.api('/api/settings', 'POST', { frMode: 'loose' });
      assert.deepEqual(ids(await core.api('/api/recent?q=x')), [31, 33, 34, 35, 37, 38]);
      await core.api('/api/settings', 'POST', { frMode: 'off' });
      assert.equal((await core.api('/api/recent?q=x')).items.length, 8);
      // avec clé + option : seules les annonces sans indice partent à l'IA (modèle économique), en cache ensuite
      const core2 = mk();
      await core2.api('/api/settings', 'POST', { anthropicKey: 'sk-test', langCheck: true });
      j = await settle(core2);
      assert.deepEqual(ids(j), [31, 34, 35, 37, 38], 'photo 33 en anglais : masquée ; 34 et 37 lues FR par l\'IA');
      assert.equal(j.items.find((i) => i.id === 34).langSrc, 'photo');
      const urls = langCalls.map((c) => c.url).sort();
      assert.deepEqual(urls, ['http://x/37.jpg', 'http://x/en/33.jpg', 'http://x/fr/34.jpg']);
      assert.ok(langCalls.every((c) => /haiku/.test(c.model)));
      const n = langCalls.length;
      await settle(core2);
      assert.equal(langCalls.length, n, 'résultat mis en cache');
    });
  });

  test('Filtre FR : ancien réglage frOnly, valeurs invalides ignorées', async () => {
    const core = mk();
    assert.equal((await core.api('/api/state')).settings.frMode, 'strict');
    await core.api('/api/settings', 'POST', { frOnly: false });
    assert.equal((await core.api('/api/state')).settings.frMode, 'off');
    await core.api('/api/settings', 'POST', { frMode: 'nimportequoi' });
    assert.equal((await core.api('/api/state')).settings.frMode, 'off');
  });

  test('Langue : mauvaise clé => annonces conservées, erreur signalée', async () => {
    await withItems([[41, 'Carte neuve 4/102']], async () => {
      const core = mk();
      await core.api('/api/settings', 'POST', { anthropicKey: 'mauvaise', langCheck: true, frMode: 'loose' });
      const j = await settle(core);
      assert.equal(j.items.length, 1);
      assert.match(j.langError, /401/);
    });
  });

  const FR_TEXT = 'Dracaufeu PV 120 Pokémon de base\nAttaque Feu Rotatif\nFaiblesse Eau x2 Retraite 3\nIllus. Mitsuhiro Arita 4/102';
  const EN_TEXT = 'Charizard HP 120 Basic Pokémon\nAttack Fire Spin\nWeakness Water Retreat Cost 3\nIllus. Mitsuhiro Arita 4/102';

  test('OCR : numéro en bas de carte, confusion O/0, langue par mots imprimés', () => {
    const { parseCardText } = createCore({ request: makeRequest(globalThis), storage: memStorage() });
    const fr = parseCardText(FR_TEXT);
    assert.deepEqual([fr.number, fr.total, fr.lang, fr.strong], ['4', 102, 'fr', true]);
    assert.equal(parseCardText(EN_TEXT).lang, 'other');
    assert.equal(parseCardText('O04/102').number, '4', '« O04 » lu pour « 004 »');
    assert.equal(parseCardText('PV 90 12/20 ... 058 / 102').number, '58', 'le dernier numéro lu (bas de carte) gagne');
    assert.equal(parseCardText('Résistance Illus. Jean').lang, 'unknown', 'mots identiques FR/EN ignorés');
    assert.equal(parseCardText('').number, '');
    const it = parseCardText('Haunter 50 PV debolezza resistenza costo di ritirata Fase 1 Evolve da Gastly 21/62');
    assert.deepEqual([it.lang, it.strong], ['other', true], 'italien : PV et résistance ne comptent pas comme français');
    assert.equal(parseCardText('몸통박치기 진검승부 몸통박치기').lang, 'other', 'coréen');
    assert.equal(parseCardText('PV 50 Pokémon').lang, 'unknown', 'PV seul : ambigu');
  });

  test('Scan sans IA : texte OCR → carte, prix, annonce FR ; état modifiable', async () => {
    claudeCalls.length = 0;
    const core = mk();
    const j = await core.api('/api/scan', 'POST', { text: FR_TEXT, condition: 'Bon état' });
    assert.equal(j.found, true);
    assert.equal(j.card.name_fr, 'Dracaufeu');
    assert.equal(j.card.set, 'Set de Base');
    assert.equal(j.card.language, 'FR');
    assert.equal(j.market.trend, 80);
    assert.equal(j.listing.suggestedPrice, 80);
    assert.match(j.listing.title, /Dracaufeu 4\/102 Set de Base FR/);
    assert.match(j.listing.description, /État : Bon état/);
    assert.equal(claudeCalls.length, 0, 'aucun appel IA');
  });

  test('Scan : numéro tapé à la main, numéro non lu, mauvais nom', async () => {
    const core = mk();
    const manual = await core.api('/api/scan', 'POST', { text: '', number: '58/102', name: 'Pikachu' });
    assert.equal(manual.found, true);
    assert.equal(manual.card.name_fr, 'Pikachu');
    const none = await core.api('/api/scan', 'POST', { text: 'reflets illisibles', name: 'Dracaufeu' });
    assert.equal(none.found, false);
    assert.equal(none.card.name_fr, 'Dracaufeu');
    assert.match(none.listing.title, /Dracaufeu/);
    // 7/99 existe dans deux extensions : sans nom, pas de carte ; avec le nom, c'est tranché
    assert.equal((await core.api('/api/scan', 'POST', { number: '7/99' })).found, false);
    assert.equal((await core.api('/api/scan', 'POST', { number: '7/99', name: 'Truc' })).market.trend, 30);
  });

  test('Langue des annonces : OCR de la photo gratuit (FR, EN, italien, coréen), IA en dernier recours', async () => {
    const IT_TEXT = 'Haunter 50 PV Pokemon gassoso\nPotere Pokémon Trasparenza\ndebolezza resistenza costo di ritirata\nFase 1 Evolve da Gastly';
    const KO_TEXT = 'NAME\n' + '몸통박치기 진검승부 '.repeat(3);
    await withItems([
      [51, 'Carte neuve 4/102', 'http://x/en/51.jpg'],
      [52, 'Carte neuve 58/102', 'http://x/fr/52.jpg'],
      [53, 'Carte neuve 4/102 bis', 'http://x/blur/53.jpg'],
      [54, 'Haunter 21/62', 'http://x/it/54.jpg'],
      [55, 'Cufant AR 073/064', 'http://x/ko/55.jpg'],
    ], async () => {
      const ocrCalls = [];
      const ocr = async (url) => { ocrCalls.push(url); if (url.includes('/en/')) return EN_TEXT; if (url.includes('/fr/')) return FR_TEXT; if (url.includes('/it/')) return IT_TEXT; if (url.includes('/ko/')) return KO_TEXT; return 'flou'; };
      langCalls.length = 0;
      const core = mk({ ocr });
      const j = await settle(core);
      assert.deepEqual(j.items.map((i) => i.id), [52], 'strict : seule la carte lue en français reste');
      assert.equal(j.items[0].langSrc, 'ocr');
      assert.equal(j.hidden.other, 3, 'anglais, italien et coréen détectés');
      assert.equal(j.hidden.unverified, 1, 'photo illisible : non confirmée');
      assert.equal(langCalls.length, 0, 'sans clé : aucun appel IA');
      const n = ocrCalls.length;
      await settle(core);
      assert.equal(ocrCalls.length, n, 'résultat OCR mis en cache');
      // avec clé + option : l'IA ne voit que ce que l'OCR n'a pas su lire
      langCalls.length = 0;
      const core2 = mk({ ocr });
      await core2.api('/api/settings', 'POST', { anthropicKey: 'sk-test', langCheck: true });
      await settle(core2);
      assert.deepEqual(langCalls.map((c) => c.url), ['http://x/blur/53.jpg']);
    });
    // OCR en erreur : l'appli continue
    await withItems([[56, 'Carte neuve 4/102', 'http://x/boom/56.jpg']], async () => {
      const core = mk({ ocr: async () => { throw new Error('x'); } });
      await core.api('/api/settings', 'POST', { frMode: 'loose' });
      assert.equal((await settle(core)).items.length, 1);
    });
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

  test('Alertes : le service d\'arrière-plan suit l\'état de la surveillance', async () => {
    const calls = [];
    const core = mk({ keepAlive: (on) => calls.push(on), ensureNotifyPermission: async () => true });
    await core.api('/api/watch', 'POST', { enabled: true, queries: ['carte pokemon'], intervalSec: 1 });
    await core.api('/api/watch', 'POST', { enabled: false });
    assert.deepEqual(calls, [true, false]);
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
