# PokéDeals — appli Android

Appli native (Capacitor) qui fait tout **dans le téléphone** : plus de serveur, plus rien à mettre sur Internet. Les requêtes vers Vinted partent directement de ton Pixel (IP mobile, pas d'IP de datacenter).

- **Récent** : annonces Vinted récentes, avec score de bonne affaire /100 (marge estimée vs Cardmarket, calculée par formule, sans IA), bouton **Acheter ↗** (ouvre l'annonce dans l'appli Vinted) et **J'ai acheté** (journal + budget).
- **Vendre** : photo d'une carte, identification, prix Cardmarket, annonce prête, partage de la photo vers Vinted.
- **Stock** : achats, ventes, bénéfices, budget mensuel, alertes, réglages, sauvegarde.

## Obtenir l'APK (GitHub compile pour toi, gratuit)

1. Crée un compte sur github.com, puis un dépôt (ex. `pokedeals`). Public ou privé, les deux marchent : le dépôt ne contient aucun secret (tes clés API restent dans l'appli, la clé de signature est un secret GitHub).
2. Depuis ce dossier, sur ton PC :
   ```bash
   git init -b main
   git add .
   git commit -m "PokéDeals Android"
   git remote add origin https://github.com/TON-COMPTE/pokedeals.git
   git push -u origin main
   ```
   (Sans git : sur la page du dépôt, « uploading an existing file » et glisse tout le contenu du dossier, **y compris le dossier caché `.github`**.)
3. Onglet **Actions** du dépôt : le workflow « Build APK » démarre tout seul (5 à 10 minutes). Il lance les tests puis compile.
4. Quand il est vert : onglet **Releases** (colonne de droite de la page du dépôt) → dernier build → télécharge **PokeDeals.apk**. Tu peux le faire directement depuis le navigateur du Pixel, connecté à GitHub. L'APK est aussi dans les « Artifacts » du run.
5. Installe : ouvre le fichier téléchargé, autorise « Installer des applis inconnues » pour ton navigateur quand Android le demande. Si Play Protect avertit que l'appli n'est pas vérifiée, choisis « Installer quand même » (c'est ton propre build).

**Si le build échoue** : ouvre le run rouge dans Actions, copie les dernières lignes de l'étape en erreur et envoie-les-moi. Je n'ai pas pu compiler l'APK moi-même, donc un premier ajustement est possible.

**Mises à jour** : tu modifies, tu `git push`, un nouveau build sort. Sans réglage supplémentaire, chaque build est signé avec une clé temporaire différente : Android refuse alors de l'installer par-dessus l'ancien, il faut le désinstaller avant (exporte tes données avant, dans Stock › Réglages).

Pour que les mises à jour s'installent par-dessus sans rien perdre, crée une clé stable une fois pour toutes et mets-la dans un secret GitHub :
```bash
keytool -genkeypair -storetype JKS -keystore pokedeals.keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=PokeDeals"
base64 -w0 pokedeals.keystore        # Windows PowerShell : [Convert]::ToBase64String([IO.File]::ReadAllBytes("pokedeals.keystore"))
```
Puis sur GitHub : Settings › Secrets and variables › Actions › New repository secret, nom `KEYSTORE_B64`, valeur = le texte obtenu. Garde le fichier `pokedeals.keystore` précieusement hors du dépôt (ne le commite jamais).

## Premier lancement

1. Rien à configurer pour la liste et les scores : aucune clé nécessaire, aucun coût.
2. Autorise les notifications quand Android le demande (pour les alertes).
3. Optionnel : clé pokemontcg.io (plus de requêtes de prix), Telegram (token + chat id), et clé API Anthropic **uniquement** pour l'identification par photo dans « Vendre » (payant, fixe une limite de dépense dans la console).

## Ce qu'il faut savoir

- **Alertes en arrière-plan** : la surveillance tourne tant que l'appli est ouverte ou vient d'être mise de côté. Android suspend ensuite les applis inactives, donc ne compte pas dessus toute la nuit. Une surveillance fiable 24 h/24 demande un service dédié (ou le serveur de la v2 sur un PC allumé) ; je peux l'étudier.
- **Non testé sur un vrai téléphone** : la logique est testée (tests automatiques, interface simulée, réponses au format Capacitor lues dans son code source), mais pas l'APK lui-même. Les points à surveiller au premier lancement : la liste Vinted se remplit, la caméra s'ouvre, une notification test arrive (Stock › Alertes › Notification test), le partage de la photo vers Vinted.
- **Vinted** : pas d'API publique, le scraping est contraire à leurs CGU et peut être bloqué ou casser. Le paiement reste chez Vinted : « Acheter ↗ » ouvre l'annonce, tu valides toi-même.
- **Score de bonne affaire** : calculé par formule, sans IA. Reconnaissance : l'appli lit le numéro dans le titre (ex. `025/165`), cherche les extensions qui ont ce total (TCGdex, noms français), et **le nom de la carte doit apparaître dans le titre** pour valider (« Dracaufeu » pour 4/102). Sans nom dans le titre, la carte n'est acceptée que si une seule extension est possible (signalé « nom absent du titre ») ; sinon pas de score plutôt qu'un faux. Repli sur pokemontcg.io si TCGdex ne répond pas.
  Prix : Cardmarket (tendance) de la carte reconnue. Calcul :
  `coût = prix payé (frais Vinted inclus) + port d'achat` · `revente = prix Cardmarket × 0,9 (décote prudente) × (1 − commission)` · `marge = revente − coût` · `score = marge / coût × 50`, borné à 0-100 (🔥 : score ≥ 50 et marge ≥ 5 € ; 👍 : score ≥ 25 et marge ≥ 2 €).
  Un score de 0 veut dire « pas de marge » : c'est le cas de la plupart des annonces, vendues au prix du marché. L'écart affiché (« prix +12 % vs marché ») dit à quel point.
  Limites : il faut un numéro `n/total` dans le titre ; lots, cartes gradées et japonaises ne sont pas scorés ; le prix est celui de Cardmarket toutes langues et l'état réel compte. Regarde toujours les photos avant d'acheter.
- **Langue (cartes françaises seulement)** : le bouton « 🇫🇷 FR seulement » (actif par défaut, aussi pour les alertes) masque les annonces d'une autre langue. Ordre de décision : (1) langue écrite dans le titre (FR, française / EN, anglais, japonais…) ; (2) photo analysée par l'IA, **seulement si tu actives l'option dans Réglages** (clé Anthropic requise, modèle économique Haiku, uniquement pour les annonces de carte sans indice de langue, résultat mis en cache) ; (3) nom français de la carte dans le titre (« Dracaufeu »), pris comme indice de carte française. Sans l'option photo, une annonce « Carte neuve 4/102 » sans aucun indice reste affichée avec « langue non vérifiée ».
- **API Vinted** : depuis septembre 2026, Vinted a remplacé `/api/v2/catalog/items` par `api.vinted.fr/svc-catalogue/items` avec un jeton anonyme. L'appli utilise le nouvel endpoint ; s'il change encore, la liste affichera l'erreur reçue.
- **Sauvegarde** : stock et budget sont stockés sur le téléphone. Utilise Stock › Réglages › Exporter avant de désinstaller. Les clés API ne sont pas incluses dans l'export. La sauvegarde cloud Android est désactivée pour que les clés ne partent pas chez Google.
- L'icône est celle par défaut de Capacitor.

## Développement

```bash
npm ci
npm test        # 20 tests de la logique embarquée (www/js/core.js)
```

Le projet Android n'est pas dans le dépôt : il est généré à chaque build par `npx cap add android`, puis ajusté par `scripts/patch-android.js` (permission caméra, pas de sauvegarde cloud).
