// Tests de la logique embarquée, sans dépendance : node test/core.test.js
const assert = require('node:assert/strict');
const http = require('node:http');
const { createCore, makeRequest, parseSetCookie } = require('../www/js/core.js');

/* ---------- Faux services ---------- */
const nowSec = () => Math.floor(Date.now() / 1000);
const vintedItems = [
  { id: 1, title: 'Dracaufeu 4/102 set de base', price: { amount: '20.0' }, total_item_price: { amount: '21.4' }, status: 'Bon état', photo: { url: 'http://x/1.jpg', high_resolution: { timestamp: String(nowSec() - 60) } }, user: { login: 'marie' }, url: 'https://www.vinted.fr/items/1' },
  { id: 2, title: 'Lot 200 cartes pokemon', price: { amount: '8.0' }, photo: { url: 'http://x/2.jpg', high_resolution: { timestamp: String(nowSec() - 120) } }, user: { login: 'paul' } },
  { id: 3, title: 'Pikachu 58/102', price: '2.0', total_item_price: { amount: '2.5' }, photo: { url: 'http://x/3.jpg', high_resolution: { timestamp: String(nowSec() - 300) } }, user: { login: 'lea' } },
];
const telegramSent = [];
const claudeCalls = [];

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)).on('end', () => r(d)); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const vintedHandler = (req, res) => {
  if (req.url.startsWith('/api/v2/catalog/items')) {
    const c = req.headers.cookie || '';
    if (!c.includes('_vinted_fr_session=abc123') || !c.includes('anon_id=xyz')) { res.writeHead(401); return res.end('{}'); }
    return json(res, 200, { items: vintedItems });
  }
  // cookie avec une virgule dans « Expires » : piège classique du découpage de set-cookie
  res.setHeader('set-cookie', ['_vinted_fr_session=abc123; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly', 'anon_id=xyz; Path=/']);
  res.writeHead(200); res.end('ok');
};
const claudeHandler = async (req, res) => {
  if (req.headers['x-api-key'] !== 'sk-test') return json(res, 401, { error: 'bad key' });
  const b = JSON.parse(await readBody(req));
  claudeCalls.push(b);
  const txt = JSON.stringify(b.messages);
  if (txt.includes('Voici des titres')) {
    const out = [];
    if (txt.includes('Dracaufeu 4/102 set de base')) out.push({ id: 1, single: true, name: 'Charizard', number: '4/102', set: 'Base Set' });
    if (txt.includes('Lot 200')) out.push({ id: 2, single: false });
    if (txt.includes('Pikachu 58/102')) out.push({ id: 3, single: true, name: 'Pikachu', number: '58/102', set: 'Base Set' });
    if (txt.includes('Dracaufeu 4/102 neuf')) out.push({ id: 99, single: true, name: 'Charizard', number: '4/102', set: 'Base Set' });
    return json(res, 200, { content: [{ type: 'text', text: 'Voici : ' + JSON.stringify(out) }] });
  }
  assert.ok(txt.includes('"type":"image"'), "l'identification doit envoyer une image");
  return json(res, 200, { content: [{ type: 'text', text: '{"name":"Charizard","name_fr":"Dracaufeu","set":"Base Set","number":"4/102","language":"FR","rarity":"Rare Holo","condition":"Bon état","condition_notes":"léger blanchiment"}' }] });
};
const tcgHandler = (req, res) => {
  const q = decodeURIComponent(req.url);
  const big = q.includes('Charizard');
  json(res, 200, { data: [{ name: big ? 'Charizard' : 'Pikachu', number: big ? '4' : '58', set: { name: 'Base Set', printedTotal: 102 }, images: { small: 'x' }, cardmarket: { url: 'https://cm/x', prices: big ? { trendPrice: 80, avg30: 78, lowPrice: 60 } : { trendPrice: 3, avg30: 3, lowPrice: 1 } } }] });
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
  const [vinted, claude, tcg, tg] = await Promise.all([listen(vintedHandler), listen(claudeHandler), listen(tcgHandler), listen(telegramHandler)]);
  const mk = (extra = {}, rt = globalThis) =>
    createCore({ request: makeRequest(rt), storage: memStorage(), vintedBase: vinted.url, anthropicBase: claude.url, tcgBase: tcg.url, tgBase: tg.url, minWatch: 1, ...extra });

  test('parseSetCookie : tableau, chaîne jointe, virgule dans Expires', () => {
    assert.equal(parseSetCookie(['a=1; Path=/', 'b=2; HttpOnly']), 'a=1; b=2');
    assert.equal(parseSetCookie('a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly, b=2; Path=/'), 'a=1; b=2');
    assert.equal(parseSetCookie(''), '');
    assert.equal(parseSetCookie(undefined), '');
  });

  test('Récent sans clé : liste seule, pas de score', async () => {
    const core = mk();
    const j = await core.api('/api/recent?q=carte+pokemon');
    assert.equal(j.scoring, false);
    assert.equal(j.items.length, 3);
    assert.equal(j.items[0].deal, null);
    assert.equal(j.items[2].price, 2); // prix en chaîne ou en objet
  });

  test('Récent avec clé : score de bonne affaire, lot ignoré', async () => {
    const core = mk();
    await core.api('/api/settings', 'POST', { anthropicKey: 'sk-test' });
    const j = await core.api('/api/recent?q=carte+pokemon|pokemone');
    assert.equal(j.scoring, true);
    const byId = Object.fromEntries(j.items.map((i) => [i.id, i]));
    assert.equal(byId[1].deal.level, 'top');
    assert.equal(byId[1].deal.margin, 51.6); // 80*0.95 - (21.4+3)
    assert.equal(byId[1].analysis.name, 'Charizard');
    assert.equal(byId[2].deal, null);
    assert.equal(byId[3].deal.level, 'none');
  });

  test('Chemin natif Android : cookie en chaîne jointe, corps JSON en objet', async () => {
    const log = [];
    const core = mk({}, fakeNative(log));
    await core.api('/api/settings', 'POST', { anthropicKey: 'sk-test' });
    const j = await core.api('/api/recent?q=carte+pokemon');
    assert.equal(j.items.length, 3);
    assert.equal(j.items.find((i) => i.id === 1).deal.level, 'top');
    assert.ok(log.some((u) => u.includes('/v1/messages')));
  });

  test('Mauvaise clé Anthropic : la liste reste affichée, scoring signalé indisponible', async () => {
    const core = mk();
    await core.api('/api/settings', 'POST', { anthropicKey: 'mauvaise' });
    const j = await core.api('/api/recent?q=carte+pokemon');
    assert.equal(j.items.length, 3);
    assert.ok(j.aiError && /401/.test(j.aiError));
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
    assert.equal(s2.config.canScore, false);
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
    await core.api('/api/settings', 'POST', { anthropicKey: 'sk-test', tgToken: 'tok', tgChat: '42' });
    await core.api('/api/watch', 'POST', { enabled: true, queries: ['carte pokemon'], onlyDeals: true, intervalSec: 1 });
    await sleep(1500);
    assert.equal(notes.length, 0, 'premier passage : rien envoyé');
    vintedItems.unshift({ id: 99, title: 'Dracaufeu 4/102 neuf', price: { amount: '15.0' }, total_item_price: { amount: '16.0' }, photo: { url: 'http://x/99.jpg', high_resolution: { timestamp: String(nowSec()) } }, user: { login: 'new' } });
    vintedItems.unshift({ id: 100, title: 'Lot cartes variées', price: { amount: '3.0' }, photo: { url: 'http://x/100.jpg', high_resolution: { timestamp: String(nowSec()) } }, user: { login: 'new2' } });
    await sleep(2800);
    await core.api('/api/watch', 'POST', { enabled: false });
    assert.equal(notes.length, 1, 'seule la bonne affaire déclenche une alerte');
    assert.match(notes[0].title, /🔥 Marge \+\d/);
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
  for (const x of [vinted, claude, tcg, tg]) x.s.close();
  console.log(failed ? `\n${failed} test(s) en échec` : `\n${tests.length} tests OK`);
  process.exit(failed ? 1 : 0);
})();
