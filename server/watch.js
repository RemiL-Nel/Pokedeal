#!/usr/bin/env node
// Surveillance Vinted 24 h/24 sur un PC / Raspberry / mini-serveur : mêmes calculs que l'appli,
// alertes sur Telegram. Usage : node server/watch.js   (config dans server/config.json)
const fs = require('fs');
const path = require('path');
const { createCore, makeRequest } = require('../www/js/core.js');

const CFG = path.join(__dirname, 'config.json');
const DATA = path.join(__dirname, 'data.json');
if (!fs.existsSync(CFG)) {
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), CFG);
  console.log('server/config.json créé : renseigne tgToken et tgChat, puis relance.');
  process.exit(0);
}
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
if (!cfg.tgToken || !cfg.tgChat) { console.error('Renseigne tgToken et tgChat dans server/config.json'); process.exit(1); }

// stockage fichier compatible localStorage
let mem = {};
try { mem = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
const storage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); fs.writeFileSync(DATA, JSON.stringify(mem)); },
  removeItem: (k) => { delete mem[k]; fs.writeFileSync(DATA, JSON.stringify(mem)); },
};

const log = (...a) => console.log(new Date().toLocaleString('fr-FR'), ...a);
const core = createCore({
  request: makeRequest(globalThis),
  storage,
  notify: async (n) => log('ALERTE', n.title),
  ensureNotifyPermission: async () => true,
  minWatch: 20,
});

(async () => {
  await core.api('/api/settings', 'POST', {
    tgToken: cfg.tgToken, tgChat: String(cfg.tgChat),
    frMode: cfg.frMode || 'loose', // pas d'OCR sur le serveur : on s'appuie sur le titre
    shipIn: cfg.shipIn ?? 3, feeOut: cfg.feeOut ?? 0.05, haircut: cfg.haircut ?? 10,
  });
  await core.api('/api/watch', 'POST', {
    enabled: true, queries: cfg.queries || ['carte pokemon'], maxPrice: cfg.maxPrice ?? null,
    onlyDeals: cfg.onlyDeals !== false, intervalSec: cfg.intervalSec || 60,
  });
  try { await core.api('/api/watch/test', 'POST', {}); log('Message test envoyé sur Telegram'); } catch (e) { log('Test Telegram impossible :', e.message); }
  log('Surveillance lancée');
  setInterval(async () => {
    const st = (await core.api('/api/state')).watchStatus;
    log(`passage ${st.lastRun ? new Date(st.lastRun).toLocaleTimeString('fr-FR') : '-'} · ${st.sent} alerte(s)` + (st.lastError ? ` · erreur : ${st.lastError}` : ''));
  }, 5 * 60 * 1000);
})();
