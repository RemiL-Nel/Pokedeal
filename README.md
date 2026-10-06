# PokéDeals — appli Android

Appli native (Capacitor) qui fait tout **dans le téléphone** : plus de serveur, plus rien à mettre sur Internet. Les requêtes vers Vinted partent directement de ton Pixel (IP mobile, pas d'IP de datacenter).

- **Récent** : annonces Vinted récentes, avec score de bonne affaire /100 (marge estimée vs Cardmarket, calculée par formule, sans IA), bouton **Acheter ↗** (ouvre l'annonce dans l'appli Vinted) et **J'ai acheté** (journal + budget).
- **Affaires** : toutes les annonces dont le score est d'au moins 1/100, triées par score (ou marge, ou dernières vues). Elles restent 24 h même quand elles sortent de la liste Récent (mention « plus dans les récents »), ou jusqu'à ce que tu les retires (✕). Une annonce dont le score retombe à 0 (prix de référence modifié, prix baissé…) disparaît de l'onglet.
- **Vendre** : photo d'une carte, lue **sur le téléphone par OCR (Google ML Kit, gratuit, hors ligne, sans IA)** : numéro, nom, langue, puis prix Cardmarket, annonce prête, partage de la photo vers Vinted. Si le numéro n'est pas lu (reflets, flou), tu le tapes à la main.
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
3. Optionnel : clé pokemontcg.io (plus de requêtes de prix), Telegram (token + chat id), et clé API Anthropic **uniquement** pour le bouton « Essayer avec l'IA » dans Vendre et la vérification de langue de secours (payant, fixe une limite de dépense dans la console).

## Ce qu'il faut savoir

- **Alertes en arrière-plan** : quand la surveillance est activée (Stock › Alertes), l'appli lance un **service Android de premier plan** (notification discrète permanente « PokéDeals surveille Vinted ») + un wake-lock, ce qui garde la surveillance active écran éteint ou appli en fond. À faire une fois : appuie sur **Autoriser en arrière-plan** (exemption d'optimisation de batterie) et, sur Xiaomi/Samsung/OnePlus etc., mets la batterie de l'appli sur « Sans restriction ». Si tu fermes l'appli en la balayant, certains constructeurs tuent le service : laisse-la juste en arrière-plan. Coût : un peu plus de batterie. Non testé sur un vrai téléphone depuis le bac à sable.
- **Non testé sur un vrai téléphone** : la logique est testée (tests automatiques, interface simulée, réponses au format Capacitor lues dans son code source), mais pas l'APK lui-même. Les points à surveiller au premier lancement : la liste Vinted se remplit, la caméra s'ouvre, une notification test arrive (Stock › Alertes › Notification test), le partage de la photo vers Vinted.
- **Vinted** : pas d'API publique, le scraping est contraire à leurs CGU et peut être bloqué ou casser. Le paiement reste chez Vinted : « Acheter ↗ » ouvre l'annonce, tu valides toi-même.
- **Score de bonne affaire (/100)** : calculé par formule, sans IA, **affiché sur chaque annonce** : soit le score, soit « Score — » avec la raison (lot, carte gradée, pas de numéro `n/total` dans le titre, carte non identifiée de façon sûre…).
  `coût = prix payé (frais Vinted inclus) + port d'achat` · `revente nette = prix de référence × (1 − décote) × (1 − commission)` · `marge = revente nette − coût` · `score = marge / coût × 50`, borné à 0-100 (🔥 : score ≥ 50 et marge ≥ 5 € ; 👍 : score ≥ 25 et marge ≥ 2 €). Le détail du calcul est affiché sur la carte ; port, commission et **décote** (défaut 10 %) se règlent dans Stock › Réglages.
  **Prix de référence** : par défaut la *tendance Cardmarket* de la carte reconnue (via TCGdex), qui mélange toutes les langues et tous les états : c'est une approximation, d'où la décote. Le prix « minimum near mint français » de Cardmarket et les ventes eBay réalisées **ne sont pas récupérables automatiquement** (Cardmarket bloque les requêtes automatisées, eBay interdit ces pages aux robots, leurs API de prix vendus sont réservées à des partenaires). À la place, chaque annonce a trois boutons : **Cardmarket ↗** et **eBay vendus ↗** ouvrent la recherche, et **Mon prix** te laisse saisir le prix de revente réel : il est mémorisé pour cette carte, remplace la tendance (sans décote) et recalcule le score.
  **Trois méthodes de reconnaissance**, dans cet ordre : (1) numéro/total du titre validé par le nom français ou l'extension cités dans le titre ; (2) **nom + extension** cités dans le titre sans numéro (« Spectrum fossile » → Fossile 21/62) si le nom est unique dans l'extension ; (3) **la photo** lue par l'OCR : le nom et le numéro imprimés sur la carte identifient (ou valident) l'annonce quand le titre ne suffit pas. Les noms sont comparés mot entier (« Mew » ne valide pas « Mewtwo »). Chaque carte indique comment elle a été reconnue.
  Recoupement avec les numéros imprimés sur la photo (OCR) quand la carte en porte plusieurs (ex. `038/128` + badge `16/30` : le plus grand total est retenu, signalé « moins sûr »).
- **Langue (cartes françaises)** : le bouton de filtre de l'onglet Récent a trois états : **🇫🇷 FR confirmées** (défaut : seules les annonces dont le français est établi restent), **FR + non vérifiées** (tout sauf ce qui est confirmé étranger), **Toutes langues**. S'applique aussi aux alertes. Le français est établi par : (1) le titre (FR, française) ; (2) le **nom français de la carte dans le titre** (« Dracaufeu ») ; (3) la **photo lue par l'OCR du téléphone** (gratuit) : « Faiblesse / Retraite / Attaque / Talent » = français ; « Weakness / Retreat », « debolezza / ritirata », « Schwäche », coréen / japonais… = autre langue (les mots identiques en français et en anglais, ou ambigus comme « PV », sont ignorés) ; (4) optionnellement l'IA (Réglages, clé Anthropic, modèle Haiku, seulement pour les cartes que l'OCR n'a pas su lire). Les lots (langue invérifiable) restent affichés. La lecture des photos se fait en arrière-plan : les annonces apparaissent au fur et à mesure.
- **Identification de la carte** : numéro/total du titre → extensions possibles → il faut **le nom français de la carte** *ou* **le nom de l'extension** dans le titre (« Haunter 21/62 set fossil » → Fossile). Un numéro seul n'est pas assez sûr (les sets coréens/japonais réutilisent les mêmes totaux) : pas de score plutôt qu'un faux.
- **API Vinted** : depuis septembre 2026, Vinted a remplacé `/api/v2/catalog/items` par `api.vinted.fr/svc-catalogue/items` avec un jeton anonyme. L'appli utilise le nouvel endpoint ; s'il change encore, la liste affichera l'erreur reçue.
- **Sauvegarde** : stock et budget sont stockés sur le téléphone. Utilise Stock › Réglages › Exporter avant de désinstaller. Les clés API ne sont pas incluses dans l'export. La sauvegarde cloud Android est désactivée pour que les clés ne partent pas chez Google.
- **OCR** : la lecture est bonne sur une photo nette, à plat et bien cadrée ; elle peut rater le numéro avec des reflets (cartes holo), du flou ou une photo de travers. Les modèles de lecture sont embarqués : l'APK est plus gros (quelques dizaines de Mo).
- L'icône est celle par défaut de Capacitor.

## Développement

```bash
npm ci
npm test        # 31 tests de la logique embarquée (www/js/core.js)
```

Le projet Android n'est pas dans le dépôt : il est généré à chaque build par `npx cap add android`, puis ajusté par `scripts/patch-android.js` (permission caméra, pas de sauvegarde cloud).
