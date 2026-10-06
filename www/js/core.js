/* PokéDeals — logique embarquée (tourne dans l'appli, sans serveur).
 * Fonctionne dans la WebView Android (requêtes natives via CapacitorHttp, donc pas de CORS)
 * et sous Node pour les tests. */
(function (root) {
  'use strict';

  const UA =
    'Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  const r2 = (n) => Math.round(n * 100) / 100;
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const num = (v, def = 0) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : def);
  const eur = (n) => `${r2(n)} €`.replace('.', ',');

  /* ---------- Requêtes HTTP : natives sur Android, fetch ailleurs ---------- */
  function makeRequest(rt) {
    return async function request(url, o = {}) {
      const method = (o.method || 'GET').toUpperCase();
      const headers = { ...(o.headers || {}) };
      const timeout = o.timeout || 10000;
      const cap = rt.Capacitor;
      const http =
        cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() && cap.Plugins && cap.Plugins.CapacitorHttp;
      if (http) {
        const req = { url, method, headers, responseType: 'text', connectTimeout: timeout, readTimeout: timeout };
        if (o.json !== undefined) {
          headers['content-type'] = 'application/json';
          req.data = o.json;
        }
        const r = await http.request(req);
        const h = {};
        for (const k of Object.keys(r.headers || {})) h[k.toLowerCase()] = r.headers[k];
        const raw = r.data;
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        return {
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          headers: h,
          setCookie: h['set-cookie'] || '',
          text: async () => text,
          json: async () => (typeof raw === 'string' ? JSON.parse(raw) : raw),
        };
      }
      const init = { method, headers, signal: AbortSignal.timeout(timeout) };
      if (o.json !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(o.json);
      }
      const r = await fetch(url, init);
      return {
        status: r.status,
        ok: r.ok,
        headers: Object.fromEntries(r.headers.entries()),
        setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [],
        text: () => r.text(),
        json: () => r.json(),
      };
    };
  }

  // set-cookie arrive soit en tableau, soit en une seule chaîne jointe par « , » (Android)
  function parseSetCookie(h) {
    if (!h || (Array.isArray(h) && !h.length)) return '';
    const arr = Array.isArray(h) ? h : String(h).split(/,(?=\s*[^;,=\s]+=)/);
    return arr
      .map((c) => c.trim().split(';')[0])
      .filter((c) => c.includes('='))
      .join('; ');
  }

  function createCore(env) {
    const request = env.request;
    const storage = env.storage;
    const VINTED = env.vintedBase || 'https://www.vinted.fr';
    const ANTHROPIC_BASE = env.anthropicBase || 'https://api.anthropic.com';
    const TCG_BASE = env.tcgBase || 'https://api.pokemontcg.io';
    const TG_BASE = env.tgBase || 'https://api.telegram.org';
    const MIN_WATCH = env.minWatch || 30;
    const notifyLocal = env.notify || (async () => {});

    /* ---------- Persistance ---------- */
    const read = (k, def) => {
      try {
        const v = storage.getItem(k);
        return v ? JSON.parse(v) : def;
      } catch {
        return def;
      }
    };
    const write = (k, v) => {
      try {
        storage.setItem(k, JSON.stringify(v));
      } catch {}
    };
    const defSettings = () => ({ anthropicKey: '', model: 'claude-sonnet-5-5', tgToken: '', tgChat: '', tcgKey: '', shipIn: 3, feeOut: 0.05, frMode: 'strict', haircut: 10, langCheck: false, langModel: 'claude-haiku-4-5-20251001' });
    const defState = () => ({
      watch: { enabled: false, queries: ['carte pokemon'], maxPrice: null, onlyDeals: true, intervalSec: 60 },
      budget: { monthly: 0 },
      refPrices: {}, // prix de référence saisis à la main (Cardmarket FR near mint, ventes eBay…), par carte
      inventory: [],
      nextId: 1,
    });
    let settings = { ...defSettings(), ...read('pd_settings', {}) };
    let state = { ...defState(), ...read('pd_state', {}) };
    const saveSettings = () => write('pd_settings', settings);
    const save = () => write('pd_state', state);

    const canIdentify = () => !!settings.anthropicKey; // photo → carte (optionnel, payant côté Anthropic)
    const canTelegram = () => !!(settings.tgToken && settings.tgChat);

    /* ---------- Vinted ---------- */
    // Depuis septembre 2026, Vinted n'expose plus /api/v2/catalog/items (404) :
    // la recherche passe par api.<domaine>/svc-catalogue/items avec un jeton anonyme
    // (cookie access_token_web + identifiant anon_id obtenus sur la page d'accueil).
    const VINTED_API =
      env.vintedApiBase || (/^https?:\/\/www\./.test(VINTED) ? VINTED.replace('://www.', '://api.') : VINTED);
    let cookie = '';
    let token = '';
    let anonId = '';
    let cookieAt = 0;

    const cookieValue = (str, name) => {
      const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(str || '');
      return m ? m[1] : '';
    };

    async function getCookie(force) {
      if (!force && cookieAt && Date.now() - cookieAt < 20 * 60 * 1000) return cookie;
      const r = await request(VINTED + '/', { headers: { 'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9' } });
      cookie = parseSetCookie(r.setCookie); // peut être vide sur Android si le cookie est géré par le système
      token = cookieValue(cookie, 'access_token_web');
      anonId = cookieValue(cookie, 'anon_id') || (r.headers && r.headers['x-anon-id']) || '';
      cookieAt = Date.now();
      return cookie;
    }

    const absUrl = (u, id) => (u ? (/^https?:/.test(u) ? u : VINTED + (u.startsWith('/') ? '' : '/') + u) : `${VINTED}/items/${id}`);

    function norm(it) {
      const amount = (v) => (v && typeof v === 'object' ? parseFloat(v.amount) : parseFloat(v));
      const price = amount(it.price);
      const total = it.total_item_price ? amount(it.total_item_price) : NaN;
      const photo = it.photo || {};
      const box = it.item_box || {};
      return {
        id: it.id,
        title: it.title || '',
        price: Number.isFinite(price) ? price : null,
        totalPrice: Number.isFinite(total) ? total : null,
        status: it.status || box.second_line || '',
        photo: photo.url || (photo.thumbnails && photo.thumbnails.length ? photo.thumbnails[photo.thumbnails.length - 1].url : ''),
        url: absUrl(it.url, it.id),
        seller: it.user ? it.user.login : '',
        ts: photo.high_resolution && photo.high_resolution.timestamp ? Number(photo.high_resolution.timestamp) : null,
      };
    }

    const itemsOf = (j) => (j && (j.items || (j.data && j.data.items) || j.catalog_items)) || [];

    async function vintedSearch({ q, min, max }) {
      let lastStatus = 0;
      let lastBody = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const ck = await getCookie(attempt > 0);
        // les paramètres vides sont refusés (400) par le nouvel endpoint : on ne les envoie pas
        const p = new URLSearchParams({ search_text: q || 'carte pokemon', order: 'newest_first', per_page: '48', page: '1' });
        if (max) p.set('price_to', String(max));
        if (min) p.set('price_from', String(min));
        const headers = {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'fr-FR,fr;q=0.9',
          origin: VINTED,
          referer: VINTED + '/',
        };
        if (token) headers.authorization = 'Bearer ' + token;
        if (anonId) headers['x-anon-id'] = anonId;
        if (ck) headers.cookie = ck;
        const r = await request(`${VINTED_API}/svc-catalogue/items?${p}`, { headers });
        lastStatus = r.status;
        if (r.status === 401 || r.status === 403) {
          cookieAt = 0;
          continue;
        }
        if (!r.ok) {
          try {
            lastBody = (await r.text()).replace(/\s+/g, ' ').slice(0, 120);
          } catch {}
          throw new Error(`Vinted a répondu ${r.status}${lastBody ? ' : ' + lastBody : ''}`);
        }
        return itemsOf(await r.json()).map(norm);
      }
      throw new Error(`Vinted a refusé la requête (${lastStatus}). Réessaie dans quelques minutes.`);
    }

    async function searchMany(queries, opts) {
      const seen = new Map();
      let ok = 0;
      let lastErr = null;
      for (const q of queries.slice(0, 6)) {
        try {
          for (const it of await vintedSearch({ q, ...opts })) if (!seen.has(it.id)) seen.set(it.id, it);
          ok++;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!ok) throw lastErr || new Error('Aucune recherche');
      return [...seen.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }

    /* ---------- Reconnaissance de la carte + prix Cardmarket ---------- */
    // Méthode : numéro/total du titre → extension(s) possible(s) → le NOM de la carte (en français)
    // doit apparaître dans le titre. Sans cette vérification, 4/102 pourrait être n'importe quelle extension.
    // Source : TCGdex (noms français, prix Cardmarket). Repli : pokemontcg.io, seulement si le numéro est sans ambiguïté.
    const TCGDEX = env.tcgdexBase || 'https://api.tcgdex.net';
    const DAY = 24 * 3600 * 1000;
    const memo = new Map(); // url -> { at, v }

    async function getJson(url, ttl, headers = { accept: 'application/json' }) {
      const hit = memo.get(url);
      if (hit && Date.now() - hit.at < ttl) return hit.v;
      const r = await request(url, { headers, timeout: 15000 });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v = await r.json();
      memo.set(url, { at: Date.now(), v });
      if (memo.size > 2000) [...memo.keys()].slice(0, 500).forEach((k) => memo.delete(k));
      return v;
    }

    const plain = (x) =>
      String(x || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[-–’'.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const NAME_STOP = new Set(['ex', 'gx', 'v', 'vmax', 'vstar', 'vunion', 'break', 'prime', 'lv', 'x', 'star', 'delta']);
    // Mot-clé du nom de la carte (« Dracaufeu-EX » → « dracaufeu »)
    function nameKey(name) {
      const words = plain(name).split(' ').filter((w) => w && !NAME_STOP.has(w));
      return words.find((w) => w.length >= 3) || words.join(' ');
    }
    // Le nom est-il un MOT du texte (« Mew » ne doit pas valider « Mewtwo ») ? pluriel simple toléré.
    function hasWord(textPlain, key) {
      if (!key) return false;
      return textPlain.split(' ').some((w) => w === key || w === key + 's' || w === key + 'x');
    }
    const sameNumber = (local, n) => {
      const a = String(local || '').toLowerCase();
      return a === String(n) || String(parseInt(a, 10)) === String(n);
    };

    // L'extension est-elle citée dans le titre (« fossil » ↔ « Fossile », « Fable Nébuleuse »…) ?
    const SET_STOP = new Set(['set', 'base', 'pokemon', 'carte', 'cartes', 'promo', 'promos', 'collection', 'serie', 'series', 'edition', 'illustration', 'coffret']);
    function setEvidence(setName, titlePlain) {
      return plain(setName)
        .split(' ')
        .filter((w) => w.length >= 5 && !SET_STOP.has(w))
        .some((w) => titlePlain.includes(w.length > 5 ? w.replace(/(es|e|s)$/, '') : w));
    }

    const cmUrlFor = (name, set) => `https://www.cardmarket.com/fr/Pokemon/Products/Search?searchString=${encodeURIComponent(`${name} ${set || ''}`.trim())}`;

    function tcgdexPrice(card, reverse) {
      const cm = card && card.pricing && card.pricing.cardmarket;
      if (!cm) return 0;
      const pick = reverse ? [cm['trend-holo'], cm['avg7-holo'], cm.trend, cm.avg7, cm.avg] : [cm.trend, cm.avg7, cm.avg30, cm.avg];
      const v = pick.map(Number).find((x) => x > 0);
      return v || 0;
    }

    // Renvoie : objet carte+prix, null (carte non identifiée de façon sûre) ou undefined (erreur réseau/format, à réessayer).
    async function resolveTcgdex(a, title, lenient) {
      const sets = await getJson(`${TCGDEX}/v2/fr/sets`, DAY);
      if (!Array.isArray(sets)) return undefined;
      const count = (x) => x.cardCount || {};
      let cands = sets.filter((x) => count(x).official === a.total);
      if (!cands.length) cands = sets.filter((x) => count(x).total === a.total);
      cands = cands.slice(0, 8);
      if (!cands.length) return null;
      const t = plain(title);
      const found = [];
      for (const st of cands) {
        const det = await getJson(`${TCGDEX}/v2/fr/sets/${encodeURIComponent(st.id)}`, DAY);
        const c = det && Array.isArray(det.cards) ? det.cards.find((x) => sameNumber(x.localId, a.number)) : null;
        if (c) found.push({ set: st, card: c, named: !!(c.name && hasWord(t, nameKey(c.name))) });
      }
      let pick = found.filter((f) => f.named);
      let nameChecked = true;
      if (!pick.length) {
        // le nom n'est pas dans le titre : une seule extension possible ET (extension citée dans le titre, ou mode « scan » où l'utilisateur tient la carte)
        if (found.length !== 1 || !(lenient || setEvidence(found[0].set.name, t))) return null;
        pick = found;
        nameChecked = false;
      }
      if (pick.length > 1) return null; // deux cartes de même nom pour ce numéro/total : trop incertain
      return finishTcgdex(pick[0].set, pick[0].card, a, nameChecked);
    }

    async function finishTcgdex(set, card, a, nameChecked) {
      const full = await getJson(`${TCGDEX}/v2/fr/cards/${encodeURIComponent(card.id)}`, 6 * 3600 * 1000);
      if (!full) return null;
      const trend = tcgdexPrice(full, a.reverse);
      const total = (set.cardCount || {}).official || a.total;
      return {
        matched: `${full.name || card.name} — ${set.name} ${full.localId || card.localId}/${total}`,
        name: full.name || card.name,
        set: set.name,
        image: full.image ? full.image + '/low.webp' : '',
        trend: trend || null,
        url: cmUrlFor(full.name || card.name, set.name),
        nameChecked,
        number: String(full.localId || card.localId).replace(/^0+(?=\d)/, ''),
        total,
      };
    }

    // Méthode « nom + extension » : titre sans numéro mais qui cite l'extension ET un nom de carte présent une seule fois dans cette extension.
    async function resolveByNameSet(a, title) {
      const sets = await getJson(`${TCGDEX}/v2/fr/sets`, DAY);
      if (!Array.isArray(sets)) return undefined;
      const t = plain(title);
      const cands = sets.filter((x) => x.name && setEvidence(x.name, t));
      if (!cands.length || cands.length > 3) return null;
      const hits = [];
      for (const st of cands) {
        const det = await getJson(`${TCGDEX}/v2/fr/sets/${encodeURIComponent(st.id)}`, DAY);
        for (const c of det && Array.isArray(det.cards) ? det.cards : []) if (c.name && hasWord(t, nameKey(c.name))) hits.push({ set: st, card: c });
      }
      if (hits.length !== 1) return null; // aucune carte, ou plusieurs impressions du même nom : trop incertain
      const m = await finishTcgdex(hits[0].set, hits[0].card, a, true);
      return m && m.total ? m : null;
    }

    async function resolveTcgIo(a, title, lenient) {
      const q = `number:"${a.number}" set.printedTotal:${a.total}`;
      const headers = { accept: 'application/json' };
      if (settings.tcgKey) headers['x-api-key'] = settings.tcgKey;
      const r = await request(`${TCG_BASE}/v2/cards?pageSize=12&q=` + encodeURIComponent(q), { headers, timeout: 15000 });
      if (!r.ok) return r.status === 404 ? null : undefined;
      const list = ((await r.json()).data || []).filter((c) => c.cardmarket && c.cardmarket.prices);
      if (list.length !== 1) return null; // plusieurs cartes possibles et pas de nom français pour trancher : on n'invente rien
      const c = list[0];
      if (!(lenient || setEvidence(c.set.name, plain(title)))) return null;
      const p = c.cardmarket.prices;
      const trend = Number(a.reverse ? p.reverseHoloTrend || p.trendPrice : p.trendPrice || p.avg30);
      return {
        matched: `${c.name} — ${c.set.name} ${c.number}/${c.set.printedTotal}`,
        name: c.name,
        set: c.set.name,
        image: c.images && c.images.small,
        trend: trend > 0 ? trend : null,
        url: c.cardmarket.url,
        nameChecked: false,
      };
    }

    async function resolveCard(a, title, lenient) {
      try {
        const v = await resolveTcgdex(a, title, lenient);
        if (v !== undefined) return v;
      } catch {}
      try {
        return await resolveTcgIo(a, title, lenient);
      } catch {
        return undefined;
      }
    }

    async function pool(list, n, fn) {
      const queue = [...list];
      await Promise.all(
        Array.from({ length: Math.min(n, queue.length) }, async () => {
          while (queue.length) await fn(queue.shift());
        })
      );
    }

    /* ---------- Analyse des titres (sans IA) + score de bonne affaire ---------- */
    const analysisCache = new Map();
    const MAX_LOOKUPS = 25; // appels pokemontcg.io par passage (le reste est traité au passage suivant)

    async function claude(content, maxTokens, timeout = 40000, model) {
      const r = await request(ANTHROPIC_BASE + '/v1/messages', {
        method: 'POST',
        timeout,
        headers: { 'x-api-key': settings.anthropicKey, 'anthropic-version': '2023-06-01' },
        json: { model: model || settings.model || 'claude-sonnet-5-5', max_tokens: maxTokens, messages: [{ role: 'user', content }] },
      });
      if (!r.ok) {
        let detail = '';
        try {
          detail = (await r.text()).slice(0, 160);
        } catch {}
        throw new Error(`API Claude ${r.status} ${detail}`.trim());
      }
      const j = await r.json();
      return (j.content || []).map((c) => c.text || '').join('');
    }

    const LOT_RE = /\b(lots?|bundle|bulk|collection|classeurs?|binder|decks?|boosters?|displays?|etb|coffrets?|tins?|packs?|cartons?|mystere|mystery|pochettes?|jeu complet|set complet|full set|x\s?\d{2,})\b/;
    const GRADED_RE = /\b(psa|cgc|bgs|beckett|pca|ace|graded|gradee?s?|slab)\b/;
    const FOREIGN_RE = /\b(jap|jp|japonais(e)?|japanese|korean|coreen(ne)?|chinois(e)?|chinese|thai|indonesien(ne)?)\b/;

    // Lit le titre : numéro/total (ex. 025/165), lot, gradée, langue… Pas d'IA, juste des règles.
    function parseTitle(title) {
      const t = String(title || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
      const nums = [];
      for (const m of t.matchAll(/(?<![\d/])(\d{1,3})\s*\/\s*(\d{1,3})(?![\d/])/g)) {
        const n = parseInt(m[1], 10);
        const tot = parseInt(m[2], 10);
        if (tot >= 15 && n >= 1 && n <= tot + 150) nums.push({ n, tot });
      }
      const uniq = new Map(nums.map((x) => [`${x.n}/${x.tot}`, x]));
      const cm = /(\d{2,4})\s*(?:cartes|cards)\b/.exec(t);
      const lotCount = cm ? parseInt(cm[1], 10) : 0;
      const lot = LOT_RE.test(t) || lotCount > 1 || uniq.size > 1;
      const graded = GRADED_RE.test(t);
      const foreign = FOREIGN_RE.test(t);
      const reverse = /\b(reverse|rev\.? ?holo)\b/.test(t);
      const out = { single: false, lot, graded, foreign, reverse, lotCount: lotCount || null, lang: titleLang(title) };
      if (uniq.size === 1 && !lot && !graded && !foreign) {
        const x = [...uniq.values()][0];
        Object.assign(out, { single: true, number: String(x.n), total: x.tot });
      }
      return out;
    }

    /* ---------- Lecture du texte OCR d'une carte (sans IA) ---------- */
    // Mots imprimés sur les cartes. Ignorés car identiques ou ambigus : « résistance », « Illus. », « PV » (aussi sur les cartes italiennes), « énergie ».
    const FR_WORDS = [/\bfaiblesse\b/, /\bretraite\b/, /\bevolue de\b/, /\bpokemon de base\b/, /\bstade [12]\b/, /\bdresseur\b/, /\btalent\b/, /\battaque\b/];
    const EN_WORDS = [/\bweakness\b/, /\bretreat\b/, /\bevolves from\b/, /\bbasic pokemon\b/, /\bstage [12]\b/, /\btrainer\b/, /\bhp\s*\d/, /\bability\b/, /\battack\b/, /\benergy\b/];
    const OTHER_WORDS = [
      /\bdebolezza\b/, /\britirata\b/, /\bevolve da\b/, /\bpokemon base\b/, /\bfase [12]\b/, /\ballenatore\b/, /\battacco\b/, // italien
      /\bschwache\b/, /\bruckzug\b/, /\bentwickelt sich aus\b/, /\bbasis pokemon\b/, /\bphase [12]\b/, /\bangriff\b/, // allemand
      /\bdebilidad\b/, /\bretirada\b/, /\bevoluciona de\b/, /\bpokemon basico\b/, /\bentrenador\b/, /\bataque\b/, // espagnol / portugais
      /\bfraqueza\b/, /\brecuo\b/, /\bevolui de\b/, /\btreinador\b/,
    ];
    function parseCardText(text) {
      const raw = String(text || '').replace(/(?<![A-Za-z])[Oo](?=\d{1,2}\s*\/)/g, '0'); // « O04/102 » lu par l'OCR
      const t = plain(raw);
      const nums = [];
      for (const m of t.matchAll(/(?<![\d/])(\d{1,3})\s*\/\s*(\d{1,3})(?![\d/])/g)) {
        const n = parseInt(m[1], 10);
        const tot = parseInt(m[2], 10);
        if (tot >= 15 && n >= 1 && n <= tot + 150) nums.push({ number: String(n), total: tot });
      }
      const num = nums.length ? nums[nums.length - 1] : null; // le numéro est en bas de carte : dernier lu
      const count = (list) => list.filter((r) => r.test(t)).length;
      const cjk = (raw.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length; // coréen, japonais, chinois
      const fr = count(FR_WORDS);
      const foreign = count(EN_WORDS) + count(OTHER_WORDS) + (cjk >= 6 ? 3 : 0);
      const lang = fr > foreign ? 'fr' : foreign > fr ? 'other' : 'unknown';
      return { number: num ? num.number : '', total: num ? num.total : 0, pairs: nums, lang, strong: Math.max(fr, foreign) >= 2 && fr !== foreign, frHits: fr, foreignHits: foreign, cjk };
    }

    /* ---------- Langue de la carte ---------- */
    const OTHER_LANG_WORDS = /\b(english|anglais|anglaise|japonais|japonaise|japanese|jap|jpn|korean|coreen|coreenne|allemand|allemande|deutsch|german|espagnol|espagnole|spanish|italien|italienne|italian|portugais|portugaise|chinois|chinoise|chinese|thai)\b/;
    const OTHER_LANG_CODES = new Set(['EN', 'ENG', 'JP', 'JPN', 'KR', 'KO', 'DE', 'ES', 'IT', 'PT', 'ZH', 'CN', 'TH']);
    // Lit la langue annoncée dans le titre : 'fr', 'other' ou 'unknown' (la plupart des vendeurs ne la précisent pas)
    function titleLang(title) {
      const raw = String(title || '');
      const plainT = plain(raw);
      const letters = raw.replace(/[^A-Za-zÀ-ÿ]/g, '');
      const mostlyUpper = letters.length > 6 && letters.replace(/[^A-ZÀ-Þ]/g, '').length / letters.length > 0.7;
      const fr = /\b(fr|fra|vf|francais|francaise|francaises)\b/.test(plainT);
      let other = OTHER_LANG_WORDS.test(plainT);
      if (!other && !mostlyUpper) other = raw.split(/[^A-Za-z]+/).some((w) => OTHER_LANG_CODES.has(w));
      return fr && !other ? 'fr' : other && !fr ? 'other' : 'unknown';
    }

    let langJob = null;
    const langCache = new Map(); // id d'annonce -> { v: 'fr'|'other'|'unknown', src, tries, ocr, ai }
    let langCooldownUntil = 0;
    let lastLangError = null;
    const ocrAvailable = typeof env.ocr === 'function'; // reconnaissance de texte sur le téléphone, gratuite
    const langCheckOn = () => !!(settings.langCheck && settings.anthropicKey);
    const LANG_MAX = 24; // vérifications de photo par passage

    // Langue retenue : titre explicite > photo (OCR puis IA) > nom français dans le titre > inconnue
    function langOf(it, a) {
      const t = a && a.lang;
      if (t === 'fr' || t === 'other') return { lang: t, src: 'titre' };
      const c = langCache.get(it.id);
      if (c && c.v !== 'unknown') return { lang: c.v, src: c.src };
      if (a && a.market && a.market.nameChecked) return { lang: 'fr', src: 'nom' };
      return { lang: 'unknown', src: '' };
    }
    // La photo d'un lot ne dit rien de la langue ; l'IA (payante) n'est consultée que pour les cartes identifiées
    // L'OCR lit toutes les photos de cartes (langue + nom + numéro imprimé : identifie ou recoupe le titre) ; l'IA n'est consultée que si langue inconnue
    const needsLangCheck = (it, a) => {
      if (!(a && !a.lot && it.photo)) return false;
      const e = langCache.get(it.id) || {};
      const unknown = langOf(it, a).lang === 'unknown';
      return (ocrAvailable && !e.ocr && !a.graded) || (langCheckOn() && unknown && a.single && !e.ai && (e.tries || 0) < 2);
    };

    // Deuxième méthode de reconnaissance : la photo. L'OCR lit le nom et les numéros « n/total » imprimés sur la carte.
    //  - titre sans numéro, ou numéro refusé faute de nom/extension : le nom imprimé sur la carte vérifie l'identification ;
    //  - plusieurs numéros sur la carte (ex. 038/128 + badge 16/30) : on ne garde que les identifications dont le nom est vérifié,
    //    et si plusieurs le sont, celle au plus grand total (numérotation de l'extension plutôt que d'un badge), signalée moins sûre.
    async function refineWithPhoto(it, a, text) {
      if (!a || a.lot || a.graded || a.foreign || a.reconciled) return;
      a.reconciled = true;
      const titlePair = a.single ? { number: a.number, total: a.total } : null;
      const seenPairs = new Set();
      const pairs = [];
      for (const p of [...(titlePair ? [titlePair] : []), ...parseCardText(text).pairs]) {
        const k = `${p.number}/${p.total}`;
        if (!seenPairs.has(k)) {
          seenPairs.add(k);
          pairs.push(p);
        }
      }
      const cands = [];
      for (const p of pairs.slice(0, 4)) {
        const m = await resolveCard({ number: p.number, total: p.total, reverse: a.reverse }, `${it.title} ${text}`);
        if (m) cands.push({ p, m });
      }
      const ver = cands.filter((c) => c.m.nameChecked).sort((x, y) => y.p.total - x.p.total);
      if (!ver.length) return;
      const best = ver[0];
      const viaPhoto = !a.single || !a.market;
      a.single = true;
      a.number = best.p.number;
      a.total = best.p.total;
      a.market = ver.length > 1 ? { ...best.m, multi: true } : best.m;
      if (viaPhoto) a.via = 'photo';
    }

    // Filtre « cartes françaises » : strict = langue française confirmée ; loose = pas de langue étrangère confirmée ; off = tout.
    // Les lots (langue invérifiable) restent visibles sauf s'ils annoncent une autre langue.
    function frKeep(it, a) {
      const m = settings.frMode;
      if (m === 'off') return true;
      const l = langOf(it, a).lang;
      if (l === 'fr') return true;
      if (l === 'other') return false;
      return m === 'loose' || !!(a && a.lot);
    }

    async function checkLangPhoto(it) {
      const entry = langCache.get(it.id) || { v: 'unknown', tries: 0 };
      langCache.set(it.id, entry);
      if (ocrAvailable && !entry.ocr) {
        try {
          const a0 = analysisCache.get(it.id);
          const text = await env.ocr(it.photo, { deep: langOf(it, a0).lang === 'unknown' });
          entry.ocrText = String(text || '').slice(0, 3000);
          const r = parseCardText(text);
          await refineWithPhoto(it, a0, text);
          if (r.strong) {
            entry.v = r.lang === 'fr' ? 'fr' : 'other';
            entry.src = 'ocr';
          }
          entry.ocr = 'ok';
        } catch {
          entry.ocr = 'err';
        }
        if (entry.v !== 'unknown') return;
      }
      if (!langCheckOn() || entry.ai) return;
      entry.ai = true;
      entry.tries++;
      const text = await claude(
        [
          { type: 'image', source: { type: 'url', url: it.photo } },
          { type: 'text', text: "Photo d'une annonce Vinted pour une carte Pokémon. Quelle est la langue du texte imprimé sur la carte (nom, capacités, bas de carte) ? Réponds par UN seul mot : FR, EN, JP, DE, ES, IT, KO, ZH, PT, AUTRE, ou INCONNU si la photo ne permet pas de lire la carte (floue, plusieurs cartes, dos de carte)." },
        ],
        10,
        30000,
        settings.langModel || 'claude-haiku-4-5-20251001'
      );
      const w = (/[A-Za-z]+/.exec(text) || [''])[0].toUpperCase();
      entry.v = w === 'FR' ? 'fr' : ['EN', 'JP', 'DE', 'ES', 'IT', 'KO', 'ZH', 'PT', 'AUTRE'].includes(w) ? 'other' : 'unknown';
      entry.src = 'photo';
    }

    async function checkLanguages(items) {
      if (Date.now() < langCooldownUntil) return;
      const todo = items.filter((it) => needsLangCheck(it, analysisCache.get(it.id))).slice(0, LANG_MAX);
      if (!todo.length) return;
      await pool(todo, 3, async (it) => {
        try {
          await checkLangPhoto(it);
          lastLangError = null;
        } catch (e) {
          lastLangError = e.message;
          langCooldownUntil = Date.now() + 60000;
        }
      });
      if (langCache.size > 3000) [...langCache.keys()].slice(0, 800).forEach((k) => langCache.delete(k));
    }

    async function analyzeItems(items) {
      for (const it of items) if (!analysisCache.has(it.id)) analysisCache.set(it.id, { ...parseTitle(it.title), tries: 0 });
      const todo = items
        .map((i) => ({ a: analysisCache.get(i.id), title: i.title }))
        .filter((x) => x.a.single && x.a.market === undefined && x.a.tries < 3)
        .slice(0, MAX_LOOKUPS);
      await pool(todo, 4, async ({ a, title }) => {
        const v = await resolveCard(a, title);
        if (v === undefined) a.tries++;
        else a.market = v;
      });
      // titre sans numéro : essai « nom + extension » cités dans le titre
      const noNum = items
        .map((i) => ({ a: analysisCache.get(i.id), title: i.title }))
        .filter((x) => x.a && !x.a.single && !x.a.lot && !x.a.graded && !x.a.foreign && !x.a.nameSetTried)
        .slice(0, MAX_LOOKUPS);
      await pool(noNum, 4, async ({ a, title }) => {
        let m;
        try {
          m = await resolveByNameSet(a, title);
        } catch {
          m = undefined;
        }
        if (m === undefined) return;
        a.nameSetTried = true;
        if (m) {
          a.single = true;
          a.number = m.number;
          a.total = m.total;
          a.market = m;
          a.via = 'extension';
        }
      });
      // photo déjà lue (cache) : on réapplique la lecture si l'analyse a été recalculée
      for (const it of items) {
        const e = langCache.get(it.id);
        const a = analysisCache.get(it.id);
        if (e && e.ocrText && a && !a.reconciled && (!a.single || a.market !== undefined)) await refineWithPhoto(it, a, e.ocrText);
      }
      if (analysisCache.size > 3000) [...analysisCache.keys()].slice(0, 800).forEach((k) => analysisCache.delete(k));
    }

    // Une annonce est « prête » quand son prix de référence est connu (ou inutile).
    const isReady = (a, it) => !!a && (!a.single || a.market !== undefined || a.tries >= 3) && !(it && needsLangCheck(it, a));

    /* Formule de score
     *   coût       = prix payé (frais Vinted inclus) + frais d'envoi de ta revente d'achat
     *   revente    = prix Cardmarket × décote prudente (0,9) × (1 − frais de vente)
     *   marge      = revente − coût
     *   ROI        = marge / coût
     *   score /100 = ROI × 50, borné à [0 ; 100]   (ROI +200 % = 100)
     *   🔥 top : score ≥ 50 et marge ≥ 5 €  ·  👍 bien : score ≥ 25 et marge ≥ 2 €  (plafonné à « bien » si le nom n'est pas dans le titre)
     *   écart = prix payé / prix marché − 1 (info : un score de 0 veut dire « pas de marge », l'écart dit à quel point) */
    const refKeyOf = (it, a) => (a && a.single ? `${a.number}/${a.total}` : `id:${it.id}`);

    function dealFor(item, a) {
      if (item.price == null) return null;
      const manual = num(state.refPrices && state.refPrices[refKeyOf(item, a)], 0);
      let mkt = 0;
      let source = '';
      if (manual > 0) {
        mkt = manual;
        source = 'manuel';
      } else if (a && a.single && a.market && a.market.trend) {
        mkt = a.market.trend;
        source = 'cardmarket';
      }
      if (!mkt) return null;
      const paid = item.totalPrice != null ? item.totalPrice : item.price;
      const ship = num(settings.shipIn, 3);
      const cost = paid + ship;
      // prix saisi à la main = ton prix de revente réel : pas de décote ; prix Cardmarket (tendance) = décote prudente
      const cut = source === 'manuel' ? 0 : Math.min(50, Math.max(0, num(settings.haircut, 10))) / 100;
      const sell = mkt * (1 - cut) * (1 - num(settings.feeOut, 0.05));
      const margin = sell - cost;
      const roi = margin / cost;
      const score = Math.max(0, Math.min(100, Math.round(roi * 50)));
      let level = score >= 50 && margin >= 5 ? 'top' : score >= 25 && margin >= 2 ? 'good' : 'none';
      const m = (source === 'cardmarket' && a.market) || null;
      const unverified = !!m && (m.nameChecked === false || !!m.multi); // identification moins sûre
      if (unverified && level === 'top') level = 'good';
      const gap = Math.round((paid / mkt - 1) * 100); // écart du prix payé vs prix de référence, en %
      return { market: r2(mkt), source, paid: r2(paid), ship: r2(ship), cost: r2(cost), sell: r2(sell), margin: r2(margin), roi: r2(roi), score, gap, level, unverified, via: (a && a.via) || 'titre', matched: m ? m.matched : a && a.market ? a.market.matched : '', cmUrl: (a && a.market && a.market.url) || '', image: (m && m.image) || '' };
    }

    // Pourquoi pas de score ? (l'interface l'affiche : un score doit toujours être là, ou expliquer son absence)
    function scoreReason(it, a) {
      if (!a) return 'analyse en cours';
      if (a.lot) return a.lotCount ? `lot de ${a.lotCount} cartes : pas de score` : 'lot : pas de score';
      if (a.graded) return 'carte gradée : prix à vérifier à la main';
      if (a.foreign) return 'carte étrangère : pas de score';
      if (ocrAvailable && needsLangCheck(it, a)) return 'lecture de la photo en cours';
      if (!a.single) return 'carte non reconnue (ni numéro, ni nom + extension, ni photo lisible)';
      if (a.market === undefined) return 'prix en cours de recherche';
      if (a.market === null) return 'carte non identifiée de façon sûre (nom introuvable sur le titre et la photo)';
      return 'pas de prix Cardmarket pour cette carte';
    }

    // Texte de recherche pour vérifier à la main (Cardmarket FR near mint, ventes eBay réalisées)
    function refSearchFor(it, a) {
      if (a && a.single && a.market) return `${a.market.name} ${a.number}/${a.total} ${a.market.set || ''}`.trim();
      return String(it.title || '').replace(/\s+/g, ' ').slice(0, 80);
    }

    function decorate(it) {
      const a = analysisCache.get(it.id);
      const m = a && a.market;
      const analysis = a && a.single ? { name: m ? m.name : '', number: `${a.number}/${a.total}`, set: m ? m.set : '' } : null;
      const lot = a && a.lotCount && it.price != null ? { count: a.lotCount, perCard: r2((it.totalPrice != null ? it.totalPrice : it.price) / a.lotCount) } : null;
      const lg = langOf(it, a);
      const deal = dealFor(it, a);
      return { ...it, analysis, lot, isLot: !!(a && a.lot), graded: !!(a && a.graded), lang: lg.lang, langSrc: lg.src, refKey: refKeyOf(it, a), deal, scoreReason: deal ? '' : scoreReason(it, a), refSearch: refSearchFor(it, a) };
    }

    /* ---------- Identification d'une carte photographiée ---------- */
    async function identifyCard(dataUrl) {
      if (!canIdentify()) throw bad("Ajoute ta clé Anthropic dans l'onglet Stock > Réglages.");
      const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl || '');
      if (!m) throw bad('Image invalide.');
      const text = await claude(
        [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          {
            type: 'text',
            text:
              'Identifie cette carte Pokémon. Réponds UNIQUEMENT par un JSON : ' +
              '{"name":"nom anglais de la carte","name_fr":"nom français","set":"nom de l\'extension si visible","number":"numéro comme 025/165 si visible","language":"FR|EN|JP|autre","rarity":"rareté si visible","condition":"Neuf|Très bon état|Bon état|Satisfaisant","condition_notes":"défauts visibles en une phrase"}. ' +
              "Mets une chaîne vide quand tu ne sais pas, n'invente rien.",
          },
        ],
        400,
        60000
      );
      const jm = /\{[\s\S]*\}/.exec(text);
      if (!jm) throw new Error("Réponse d'identification illisible.");
      return JSON.parse(jm[0]);
    }

    function buildListing(card, price) {
      const cond = card.condition || 'Très bon état';
      const name = card.name_fr || card.name || 'Carte Pokémon';
      const bits = [card.number, card.set].filter(Boolean).join(' ');
      const lang = card.language ? ` ${card.language}` : '';
      const title = `Carte Pokémon ${name}${bits ? ' ' + bits : ''}${lang}`.slice(0, 80);
      const lines = [
        `Carte Pokémon ${name}${card.name && card.name_fr && card.name !== card.name_fr ? ' (' + card.name + ')' : ''}.`,
        card.set ? `Extension : ${card.set}` : '',
        card.number ? `Numéro : ${card.number}` : '',
        card.rarity ? `Rareté : ${card.rarity}` : '',
        card.language ? `Langue : ${card.language}` : '',
        `État : ${cond}${card.condition_notes ? ' — ' + card.condition_notes : ''}`,
        '',
        'Envoi soigné en pochette rigide, sous 48 h.',
        "N'hésite pas à poser tes questions ou à demander d'autres photos.",
      ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i < a.length - 1));
      return { title, description: lines.join('\n'), suggestedPrice: price ? r2(price) : null };
    }

    /* ---------- Stock, budget, bénéfices ---------- */
    const costOf = (i) => (Number(i.buyPrice) || 0) + (Number(i.buyShip) || 0);

    function stats() {
      const d0 = new Date();
      const ym = `${d0.getFullYear()}-${d0.getMonth()}`;
      let spentMonth = 0, invested = 0, revenue = 0, profit = 0, stockCost = 0, sold = 0;
      for (const i of state.inventory) {
        const c = costOf(i);
        invested += c;
        const d = new Date(i.boughtAt);
        if (`${d.getFullYear()}-${d.getMonth()}` === ym) spentMonth += c;
        if (i.status === 'sold') {
          sold++;
          const net = (Number(i.sellPrice) || 0) - (Number(i.sellFees) || 0);
          revenue += net;
          profit += net - c;
        } else stockCost += c;
      }
      const monthly = state.budget.monthly || 0;
      return {
        monthly,
        spentMonth: r2(spentMonth),
        remaining: monthly > 0 ? r2(monthly - spentMonth) : null,
        invested: r2(invested),
        revenue: r2(revenue),
        profit: r2(profit),
        stockCost: r2(stockCost),
        count: state.inventory.length,
        sold,
      };
    }

    function addItem(b) {
      const name = String(b.name || '').trim().slice(0, 120);
      const buyPrice = num(b.buyPrice, NaN);
      if (!name) throw bad('Nom manquant');
      if (!Number.isFinite(buyPrice) || buyPrice < 0 || buyPrice > 100000) throw bad('Prix invalide');
      const item = {
        id: state.nextId++,
        name,
        buyPrice: r2(buyPrice),
        buyShip: r2(Math.max(0, num(b.buyShip, 0))),
        url: typeof b.url === 'string' && /^https?:\/\//.test(b.url) ? b.url.slice(0, 500) : '',
        marketAtBuy: b.marketAtBuy != null ? r2(num(b.marketAtBuy, 0)) : null,
        status: 'stock',
        boughtAt: Date.now(),
        sellPrice: null,
        sellFees: 0,
        soldAt: null,
      };
      state.inventory.unshift(item);
      save();
      return item;
    }

    function updateItem(id, b) {
      const it = state.inventory.find((x) => x.id === id);
      if (!it) throw bad('Introuvable', 404);
      if (b.name != null) it.name = String(b.name).trim().slice(0, 120) || it.name;
      if (b.buyPrice != null) it.buyPrice = r2(Math.max(0, num(b.buyPrice, it.buyPrice)));
      if (b.buyShip != null) it.buyShip = r2(Math.max(0, num(b.buyShip, it.buyShip)));
      if (b.sellPrice != null) it.sellPrice = r2(Math.max(0, num(b.sellPrice, 0)));
      if (b.sellFees != null) it.sellFees = r2(Math.max(0, num(b.sellFees, 0)));
      if (b.status === 'sold' || b.status === 'stock') {
        it.status = b.status;
        it.soldAt = b.status === 'sold' ? Date.now() : null;
        if (b.status === 'stock') it.sellPrice = null;
      }
      save();
      return it;
    }

    function exportData() {
      return { app: 'pokedeals', version: 1, exportedAt: new Date().toISOString(), state: { watch: state.watch, budget: state.budget, refPrices: state.refPrices, inventory: state.inventory, nextId: state.nextId } };
    }

    function importData(obj) {
      const s = obj && obj.app === 'pokedeals' ? obj.state : null;
      if (!s || !Array.isArray(s.inventory)) throw bad('Fichier invalide');
      const inv = s.inventory
        .filter((i) => i && typeof i.name === 'string' && Number.isFinite(Number(i.buyPrice)))
        .map((i) => ({
          id: Number(i.id) || 0,
          name: i.name.slice(0, 120),
          buyPrice: r2(Math.max(0, Number(i.buyPrice))),
          buyShip: r2(Math.max(0, num(i.buyShip, 0))),
          url: typeof i.url === 'string' && /^https?:\/\//.test(i.url) ? i.url.slice(0, 500) : '',
          marketAtBuy: i.marketAtBuy != null ? r2(num(i.marketAtBuy, 0)) : null,
          status: i.status === 'sold' ? 'sold' : 'stock',
          boughtAt: num(i.boughtAt, Date.now()),
          sellPrice: i.sellPrice != null ? r2(num(i.sellPrice, 0)) : null,
          sellFees: r2(Math.max(0, num(i.sellFees, 0))),
          soldAt: i.soldAt != null ? num(i.soldAt, null) : null,
        }));
      let next = inv.reduce((m, i) => Math.max(m, i.id), 0);
      const seenIds = new Set();
      for (const i of inv) if (!i.id || seenIds.has(i.id)) i.id = ++next; else seenIds.add(i.id);
      state.inventory = inv;
      state.nextId = inv.reduce((m, i) => Math.max(m, i.id), 0) + 1;
      state.budget = { monthly: r2(Math.max(0, num(s.budget && s.budget.monthly, 0))) };
      if (s.refPrices && typeof s.refPrices === 'object') {
        state.refPrices = {};
        for (const [k, v] of Object.entries(s.refPrices).slice(0, 2000)) if (num(v, 0) > 0) state.refPrices[String(k).slice(0, 40)] = r2(num(v, 0));
      }
      save();
      return inv.length;
    }

    /* ---------- Alertes : notification locale + Telegram (optionnel) ---------- */
    async function telegram(text) {
      if (!canTelegram()) throw bad('Telegram non configuré');
      const r = await request(`${TG_BASE}/bot${settings.tgToken}/sendMessage`, { method: 'POST', json: { chat_id: settings.tgChat, text } });
      if (!r.ok) throw new Error(`Telegram ${r.status}`);
    }

    function dealTexts(it, d) {
      const icon = d && d.level === 'top' ? '🔥' : d && d.level === 'good' ? '👍' : '🆕';
      const head = d ? `${icon} Score ${d.score}/100 · marge ${d.margin >= 0 ? '+' : ''}${eur(d.margin)}` : `${icon} Nouvelle annonce`;
      return { title: head, body: `${it.title} — ${eur(it.price)}`, text: `${icon} ${it.title}\n${eur(it.price)}${d ? ` · score ${d.score}/100 · Cardmarket ~${eur(d.market)} · marge ~${d.margin >= 0 ? '+' : ''}${eur(d.margin)}` : ''}\n${it.url}`, url: it.url };
    }

    let gen = 0;
    let watchTimer = null;
    const notified = new Set();
    let primed = false; // 1er passage silencieux : on mémorise l'existant sans notifier
    const watchStatus = { running: false, lastRun: null, lastError: null, sent: 0 };

    async function watchTick(myGen) {
      const w = state.watch;
      try {
        const items = await searchMany(w.queries, { max: w.maxPrice });
        await analyzeItems(items);
        await checkLanguages(items);
        const firstPass = !primed;
        for (const it of items) {
          if (notified.has(it.id)) continue;
          if (firstPass) {
            notified.add(it.id);
            continue;
          }
          if (!isReady(analysisCache.get(it.id), it)) continue; // prix de référence pas encore connu : au prochain passage
          notified.add(it.id);
          if (!frKeep(it, analysisCache.get(it.id))) continue; // pas (confirmée) une carte française
          const d = dealFor(it, analysisCache.get(it.id));
          if (w.onlyDeals && !(d && d.level !== 'none')) continue;
          const t = dealTexts(it, d);
          try {
            await notifyLocal({ title: t.title, body: t.body, url: t.url });
          } catch {}
          if (canTelegram()) {
            try {
              await telegram(t.text);
            } catch {}
          }
          watchStatus.sent++;
        }
        primed = true;
        if (notified.size > 3000) [...notified].slice(0, 2000).forEach((x) => notified.delete(x));
        watchStatus.lastRun = Date.now();
        watchStatus.lastError = null;
      } catch (e) {
        watchStatus.lastError = e.message;
      } finally {
        if (myGen === gen && state.watch.enabled) {
          watchTimer = setTimeout(() => watchTick(myGen), Math.max(MIN_WATCH, state.watch.intervalSec || 60) * 1000);
        }
      }
    }

    function restartWatch() {
      gen++;
      clearTimeout(watchTimer);
      notified.clear();
      watchStatus.running = !!state.watch.enabled;
      if (watchStatus.running) {
        const g = gen;
        watchTimer = setTimeout(() => watchTick(g), 300);
      }
    }

    async function setWatch(b) {
      const w = { ...state.watch };
      if (Array.isArray(b.queries)) {
        w.queries = b.queries.map((q) => String(q).trim().slice(0, 60)).filter(Boolean).slice(0, 6);
        if (!w.queries.length) throw bad('Au moins un mot-clé');
      }
      if ('maxPrice' in b) w.maxPrice = b.maxPrice === null || b.maxPrice === '' ? null : Math.max(0, num(b.maxPrice, 0)) || null;
      if ('onlyDeals' in b) w.onlyDeals = !!b.onlyDeals;
      if ('intervalSec' in b) w.intervalSec = Math.min(3600, Math.max(MIN_WATCH, num(b.intervalSec, 60)));
      if ('enabled' in b) w.enabled = !!b.enabled;
      if (w.enabled && !state.watch.enabled && env.ensureNotifyPermission) {
        const ok = await env.ensureNotifyPermission();
        if (ok === false) throw bad("Autorise les notifications pour PokéDeals dans les réglages Android, sinon tu ne verras pas les alertes.");
      }
      state.watch = w;
      save();
      restartWatch();
    }

    /* ---------- Routeur local (mêmes routes que l'ancien serveur) ---------- */
    async function apiRaw(path, method = 'GET', body) {
      const url = new URL(path, 'http://local');
      const p = url.pathname;
      method = method.toUpperCase();

      if (p === '/api/recent' && method === 'GET') {
        const queries = (url.searchParams.get('q') || 'carte pokemon').split('|').map((s) => s.trim()).filter(Boolean);
        const items = await searchMany(queries.length ? queries : ['carte pokemon'], { min: url.searchParams.get('min'), max: url.searchParams.get('max') });
        await analyzeItems(items);
        // la lecture des photos (OCR) tourne en arrière-plan : les annonces en attente apparaissent au rafraîchissement suivant
        const needNow = items.filter((i) => needsLangCheck(i, analysisCache.get(i.id))).length;
        if (needNow && !langJob) {
          langJob = checkLanguages(items).catch(() => {}).finally(() => {
            langJob = null;
          });
        }
        const all = items.map(decorate);
        const kept = all.filter((i) => frKeep(i, analysisCache.get(i.id)));
        const pending = needNow + (langJob ? 1 : 0); // lecture en cours = pas fini
        const hidden = { other: all.filter((i) => i.lang === 'other').length };
        hidden.unverified = all.length - kept.length - hidden.other;
        return { items: kept, hidden, hiddenOther: hidden.other, pending, fetchedAt: Date.now(), scoring: true, langError: lastLangError };
      }
      if (p === '/api/state' && method === 'GET') {
        return {
          watch: state.watch,
          watchStatus: { ...watchStatus },
          budget: state.budget,
          inventory: state.inventory,
          stats: stats(),
          settings: { hasAnthropicKey: !!settings.anthropicKey, hasTelegram: canTelegram(), hasTcgKey: !!settings.tcgKey, model: settings.model, shipIn: settings.shipIn, feeOut: settings.feeOut, haircut: settings.haircut, frMode: settings.frMode, langCheck: !!settings.langCheck },
          config: { canIdentify: canIdentify(), canScore: true, canNotify: true, canTelegram: canTelegram() },
        };
      }
      if (p === '/api/settings' && method === 'POST') {
        const b = body || {};
        for (const k of ['anthropicKey', 'tgToken', 'tgChat', 'tcgKey', 'model']) if (typeof b[k] === 'string' && b[k].trim()) settings[k] = b[k].trim();
        for (const k of Array.isArray(b.clear) ? b.clear : []) if (['anthropicKey', 'tgToken', 'tgChat', 'tcgKey'].includes(k)) settings[k] = '';
        if (typeof b.langCheck === 'boolean') settings.langCheck = b.langCheck;
        if (b.haircut != null && b.haircut !== '') settings.haircut = r2(Math.min(50, Math.max(0, num(b.haircut, 10))));
        if (['strict', 'loose', 'off'].includes(b.frMode)) settings.frMode = b.frMode;
        if (typeof b.frOnly === 'boolean') settings.frMode = b.frOnly ? 'strict' : 'off'; // ancien réglage
        if (b.shipIn != null && b.shipIn !== '') settings.shipIn = r2(Math.max(0, num(b.shipIn, 3)));
        if (b.feeOut != null && b.feeOut !== '') settings.feeOut = Math.min(0.5, Math.max(0, num(b.feeOut, 0.05)));
        saveSettings();
        analysisCache.clear(); // les marges dépendent des réglages
        return { ok: true };
      }
      if (p === '/api/identify' && method === 'POST') {
        const card = await identifyCard(body && body.image);
        const nm = /(\d{1,3})\s*\/\s*(\d{1,3})/.exec(card.number || '');
        const market = nm ? await resolveCard({ number: String(parseInt(nm[1], 10)), total: parseInt(nm[2], 10) }, `${card.name_fr || ''} ${card.name || ''}`, true) : null;
        return { card, market, listing: buildListing(card, market ? market.trend : null) };
      }
      if (p === '/api/ref' && method === 'POST') {
        // Prix de référence saisi à la main pour une carte (clé « n/total » ou « id:… ») ; vide ou 0 = effacer
        const key = String((body && body.key) || '').slice(0, 40);
        if (!key) throw bad('Carte inconnue');
        const price = num(body && body.price, 0);
        if (price > 0) state.refPrices[key] = r2(price);
        else delete state.refPrices[key];
        save();
        return { ok: true, refPrices: state.refPrices };
      }
      if (p === '/api/scan' && method === 'POST') {
        // Carte scannée par OCR sur le téléphone (ou numéro saisi à la main) : aucune IA
        const b = body || {};
        const parsed = parseCardText(b.text);
        let number = parsed.number;
        let total = parsed.total;
        const man = /(\d{1,3})\s*\/\s*(\d{1,3})/.exec(String(b.number || ''));
        if (man) {
          number = String(parseInt(man[1], 10));
          total = parseInt(man[2], 10);
        }
        const condition = ['Neuf', 'Très bon état', 'Bon état', 'Satisfaisant'].includes(b.condition) ? b.condition : 'Très bon état';
        const language = parsed.lang === 'fr' ? 'FR' : '';
        const ocr = { number: parsed.number ? `${parsed.number}/${parsed.total}` : '', lang: parsed.lang };
        const base = { language, condition, rarity: '', condition_notes: '' };
        if (!number || !total) {
          const card = { ...base, name_fr: String(b.name || '').trim(), name: '', set: '', number: '' };
          return { found: false, card, market: null, listing: buildListing(card, null), ocr };
        }
        const market = await resolveCard({ number, total }, `${b.text || ''} ${b.name || ''}`, true);
        if (market === undefined) throw new Error('Prix indisponibles pour le moment, réessaie dans un instant.');
        const card = { ...base, name_fr: market ? market.name : String(b.name || '').trim(), name: '', set: market ? market.set : '', number: `${number}/${total}` };
        return { found: !!market, card, market, listing: buildListing(card, market ? market.trend : null), ocr };
      }
      if (p === '/api/budget' && method === 'POST') {
        state.budget.monthly = r2(Math.max(0, num(body && body.monthly, 0)));
        save();
        return { stats: stats() };
      }
      if (p === '/api/watch' && method === 'POST') {
        await setWatch(body || {});
        return { watch: state.watch, watchStatus: { ...watchStatus } };
      }
      if (p === '/api/watch/test' && method === 'POST') {
        await notifyLocal({ title: '✅ PokéDeals', body: 'Les notifications fonctionnent.', url: '' });
        if (canTelegram()) await telegram('✅ PokéDeals : les notifications fonctionnent.');
        return { ok: true, telegram: canTelegram() };
      }
      if (p === '/api/inventory' && method === 'POST') {
        const item = addItem(body || {});
        return { item, stats: stats() };
      }
      const m = /^\/api\/inventory\/(\d+)$/.exec(p);
      if (m && method === 'POST') {
        const item = updateItem(Number(m[1]), body || {});
        return { item, stats: stats() };
      }
      if (m && method === 'DELETE') {
        const before = state.inventory.length;
        state.inventory = state.inventory.filter((x) => x.id !== Number(m[1]));
        if (state.inventory.length === before) throw bad('Introuvable', 404);
        save();
        return { stats: stats() };
      }
      if (p === '/api/export' && method === 'GET') return exportData();
      if (p === '/api/import' && method === 'POST') return { imported: importData(body), stats: stats() };
      throw bad('Route inconnue', 404);
    }

    // L'interface reçoit toujours des copies : elle ne peut pas modifier l'état interne par erreur
    const api = async (path, method, body) => JSON.parse(JSON.stringify(await apiRaw(path, method, body)));

    if (state.watch.enabled) restartWatch();

    return { api, parseTitle, parseCardText };
  }

  const api = { createCore, makeRequest, parseSetCookie };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
