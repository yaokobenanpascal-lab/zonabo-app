# Zonako — backend partagé

Ce dossier contient un serveur Node.js/Express + PostgreSQL qui remplace le
`localStorage` de la version précédente : produits, commandes, profils
vendeur/livreur et réglages sont maintenant partagés entre **tous les
appareils**, en vrai, sur internet.

## Ce que contient ce dossier

- `server.js` — le serveur (API + sert aussi le fichier de l'appli)
- `public/index.html` — l'appli (identique à avant, mais parle à l'API au lieu du localStorage)
- `schema.sql` — les tables PostgreSQL (le serveur les crée/vérifie automatiquement au démarrage)
- `package.json` — les dépendances (Express, pg)
- `.env.example` — modèle des réglages secrets

## Nouveau : vérification des paiements et des comptes

Deux failles de la version précédente sont maintenant corrigées :

1. **Paiement CinetPay vérifié par le serveur.** Avant, le navigateur de
   l'acheteur disait lui-même "j'ai payé" et le serveur le croyait sur parole.
   Maintenant, une commande démarre toujours non payée ; c'est la route
   `/api/cinetpay/notify` (appelée par CinetPay lui-même après le paiement)
   qui interroge directement l'API de CinetPay pour connaître le VRAI statut,
   avant de marquer une commande payée. Pareil pour les abonnements
   vendeur/livreur — impossible de s'activer un abonnement sans payer.
2. **Comptes vérifiés par SMS.** Acheteur, vendeur et livreur doivent
   maintenant confirmer leur numéro avec un code reçu par SMS avant de
   pouvoir publier un produit, commander, proposer un prix de livraison, etc.
   Le jeton reçu après vérification prouve "j'agis bien en tant que ce
   numéro" pour toutes les actions sensibles.
3. **Changement de numéro sécurisé.** Un vendeur ou livreur peut changer son
   numéro depuis son espace ("changer de numéro") — le nouveau numéro doit
   lui aussi être vérifié par SMS. Le serveur met à jour ses produits et
   l'historique de ses commandes pour que rien ne se retrouve bloqué sous
   l'ancien numéro.
4. **Contenu modifiable sans redéploiement.** Depuis l'espace propriétaire,
   section "Contenu de la plateforme", tu peux changer le titre de la page
   d'accueil, les descriptions des trois rôles, un conseil affiché dans
   chaque espace, ainsi que la liste des zones et des catégories de
   produits — tout est enregistré en base de données et visible par tout le
   monde en quelques secondes, sans passer par GitHub ni Render.
5. **Détection des vendeurs à risque.** Un acheteur peut signaler un problème
   sur une commande (produit non conforme, jamais reçu, arnaque suspectée...).
   L'espace propriétaire affiche les signalements en attente et calcule un
   indicateur de risque par vendeur (taux d'annulation, nombre de
   signalements). Le propriétaire peut suspendre un vendeur en un clic — ses
   produits disparaissent immédiatement du site pour tout le monde, et il ne
   peut plus en publier de nouveaux, jusqu'à levée de la suspension.
6. **Réputation (notes 1-5 étoiles).** Une fois une commande livrée,
   l'acheteur peut noter le vendeur et le livreur. La moyenne s'affiche sur
   les fiches produits et dans la liste des propositions de livreurs, pour
   aider les acheteurs à choisir en connaissance de cause.
7. **Vérification manuelle des livreurs.** Le propriétaire peut marquer un
   livreur comme "vérifié" (après avoir contrôlé son identité, par exemple
   via WhatsApp) — un badge de confiance apparaît alors partout où son nom
   est visible.
8. **Suivi des remboursements.** CinetPay n'a pas d'API de remboursement
   automatique. Quand une commande déjà payée est annulée, elle apparaît
   automatiquement dans une liste "Remboursements à traiter" côté
   propriétaire, à traiter manuellement depuis le back-office CinetPay puis
   à cocher "fait" dans Zonako.
9. **Notifications SMS.** L'acheteur reçoit un SMS quand le vendeur confirme
   sa commande ; le livreur reçoit un SMS quand il est choisi. Nécessite
   `TWILIO_FROM_NUMBER` en plus de Twilio Verify (voir plus bas).
10. **Anti-abus sur les codes SMS.** Maximum 3 demandes de code par numéro
    et par heure, pour éviter le spam et limiter les coûts SMS.
11. **Photos produit via Cloudinary.** L'envoi de photo utilise maintenant
    Cloudinary quand configuré (lien hébergé, plus léger que l'ancien
    système d'image encodée directement en base de données) — avec repli
    automatique sur l'ancien système si Cloudinary n'est pas configuré.
    Voir `CLOUDINARY_CONFIG` en haut de `public/index.html`.
12. **Connexion par email.** En plus du téléphone, acheteurs, vendeurs et
    livreurs peuvent s'inscrire et se connecter avec une adresse email —
    même mécanisme de code à usage unique, envoyé par email au lieu d'un SMS.

**En attendant de configurer Twilio**, les codes SMS s'affichent dans les
logs du serveur (utile pour tester gratuitement) — regarde les logs Render
pendant que tu testes l'inscription.

### Configurer la vérification des paiements

1. Dans ton espace CinetPay (Réglages > Intégration), récupère `apikey` et `site_id`.
2. Ajoute-les comme variables d'environnement sur Render : `CINETPAY_APIKEY`, `CINETPAY_SITE_ID`.
3. Mets aussi ces mêmes valeurs dans `CINETPAY_CONFIG` en haut de `public/index.html`.
4. Remplace `notify_url` dans ce même bloc par ton URL Render + `/api/cinetpay/notify`
   (ex: `https://zonako-backend.onrender.com/api/cinetpay/notify`).

### Configurer les SMS (Twilio Verify)

1. Crée un compte sur [twilio.com](https://www.twilio.com) (offre d'essai gratuite avec crédit).
2. Dans le tableau de bord, active **Verify** puis crée un **Verify Service** (donne-lui un nom, ex. "Zonako").
3. Récupère : ton **Account SID**, ton **Auth Token** (page d'accueil du compte), et le **Service SID** du Verify Service créé.
4. Ajoute-les sur Render : `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`.
5. Vérifie que Twilio Verify couvre bien la Côte d'Ivoire pour le canal SMS (c'est le cas pour la grande majorité des opérateurs, mais vérifie dans leur documentation si un numéro particulier ne reçoit rien).

### Configurer les notifications SMS (facultatif, en plus de Twilio Verify)

1. Dans Twilio, achète un numéro (quelques dollars/mois) : **Phone Numbers → Buy a number**.
2. Ajoute-le sur Render en variable `TWILIO_FROM_NUMBER` (format international, ex. `+2250X...`).
3. Sans cette variable, les notifications sont simplement désactivées — le reste de l'appli continue de fonctionner normalement.

### Configurer la connexion par email

Acheteurs, vendeurs et livreurs peuvent maintenant s'inscrire avec un email
au lieu d'un numéro de téléphone (bouton "📧 Email" sur l'écran d'inscription).

⚠️ **Important** : ceci utilise l'API HTTP de Brevo, pas le SMTP classique.
Render bloque les connexions SMTP (ports 25/465/587) sur son plan gratuit
depuis septembre 2025 — Gmail SMTP, Brevo SMTP, ou tout autre SMTP classique
ne fonctionnera donc plus depuis un service Render gratuit. L'API HTTP de
Brevo, elle, passe par le port 443 (comme n'importe quel site web) et n'est
pas concernée par ce blocage.

1. Crée un compte gratuit sur [brevo.com](https://www.brevo.com) (300 emails/jour gratuits)
2. Une fois connecté, va dans **Transactionnel → Email → Paramètres de l'API** (onglet "Paramètres de l'API", pas "Paramètres SMTP")
3. Génère ou copie ta **clé API** (commence généralement par `xkeysib-...`)
4. Ajoute sur Render :
   - `BREVO_API_KEY` = ta clé API Brevo
   - `BREVO_FROM_EMAIL` = une adresse email que tu as validée dans Brevo (ex: ton adresse d'inscription Brevo)
5. Sans cette configuration, les codes email s'affichent dans les logs du
   serveur (même principe que les SMS en mode test).

### Configurer les photos produit (Cloudinary)

1. Crée un compte gratuit sur [cloudinary.com](https://cloudinary.com).
2. Sur le tableau de bord, note ton **Cloud name** (en haut de la page).
3. Va dans **Settings → Upload**, clique **Add upload preset**, mets **Signing mode** sur **Unsigned**, note le nom du preset créé.
4. Ouvre `public/index.html`, cherche `CLOUDINARY_CONFIG` (tout en haut), et remplace `cloudName` et `uploadPreset` par tes valeurs.
5. Sans cette configuration, l'envoi de photo continue de fonctionner via l'ancien système (image compressée et stockée directement en base) — moins performant à grande échelle, mais fonctionnel.

## Déploiement sur Render.com (gratuit pour démarrer)

Render propose un plan gratuit pour un petit projet comme celui-ci : un service
web + une base PostgreSQL gratuite (attention : la base gratuite Render expire
après 90 jours, il faudra alors passer sur un plan payant ou changer d'hébergeur
une fois Zonako lancé pour de vrai — voir "Pour la suite" en bas).

### 1. Créer un compte et un dépôt

1. Va sur [render.com](https://render.com) et crée un compte (gratuit).
2. Mets ce dossier (`server.js`, `package.json`, `schema.sql`, `public/`) dans
   un dépôt GitHub (crée un compte GitHub si besoin, c'est gratuit aussi).
   Le plus simple : crée un nouveau dépôt sur github.com, puis dans ce dossier
   sur ton ordinateur :
   ```
   git init
   git add .
   git commit -m "Zonako backend"
   git branch -M main
   git remote add origin https://github.com/TON-COMPTE/zonako-backend.git
   git push -u origin main
   ```

### 2. Créer la base de données

1. Sur Render : **New +** → **PostgreSQL**.
2. Donne-lui un nom (ex. `zonako-db`), région la plus proche (Europe pour la CI).
3. Une fois créée, ouvre-la et copie la valeur **"Internal Database URL"**
   (tu en auras besoin à l'étape 4).

C'est tout — pas besoin d'exécuter `schema.sql` toi-même : le serveur crée/vérifie
automatiquement toutes les tables à chaque démarrage (utile aussi si tu mets à
jour le projet plus tard avec de nouvelles tables).

### 3. Créer le service web

1. Sur Render : **New +** → **Web Service**.
2. Connecte ton dépôt GitHub `zonako-backend`.
3. Render détecte Node.js automatiquement. Réglages :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Plan** : Free
4. Dans l'onglet **Environment**, ajoute ces variables :
   - `DATABASE_URL` → colle la "Internal Database URL" copiée à l'étape 2
   - `OWNER_PASSCODE` → choisis un vrai code secret, solide, que toi seul connais
   - `CINETPAY_APIKEY`, `CINETPAY_SITE_ID` → tes identifiants marchand CinetPay
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` → si tu as configuré Twilio (sinon les codes SMS s'afficheront juste dans les logs)
5. Clique **Create Web Service**. Render installe, démarre, et te donne une
   URL du style `https://zonako-backend.onrender.com` — **c'est ton site en ligne**.

### 4. Vérifier que ça marche

- Ouvre l'URL donnée par Render : tu dois voir l'écran d'accueil Zonako.
- Teste un parcours complet : inscris-toi comme vendeur sur un appareil,
  publie un produit, puis ouvre la même URL sur un **autre** appareil (ou
  navigation privée) en tant qu'acheteur — le produit doit apparaître. C'est
  la preuve que le partage fonctionne, contrairement à la version localStorage.
- Va dans l'espace propriétaire, entre le code que tu as mis dans
  `OWNER_PASSCODE` — ça doit fonctionner.

## Avant d'ouvrir au public

- [ ] Remplace `apikey` / `site_id` dans `CINETPAY_CONFIG` (dans
      `public/index.html`) par tes vrais identifiants marchand CinetPay,
      passe `mode` à `"PRODUCTION"`, et mets `notify_url` sur ton vrai domaine.
- [ ] Ajoute `CINETPAY_APIKEY` / `CINETPAY_SITE_ID` (mêmes valeurs) comme
      variables d'environnement Render, pour la vérification serveur.
- [ ] Configure Twilio Verify (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
      `TWILIO_VERIFY_SERVICE_SID`) pour que les codes partent en vrais SMS.
- [ ] Vérifie que ton URL Render est bien en **https://** (c'est automatique
      chez Render — nécessaire pour que CinetPay fonctionne).
- [ ] Choisis un `OWNER_PASSCODE` que toi seul connais (pas "zonako2026" !).
- [ ] Fais un tour complet acheteur → vendeur → livreur → propriétaire pour
      confirmer que tout répond bien une fois en ligne, y compris un vrai
      paiement CinetPay en mode SANDBOX pour vérifier que le webhook
      `/api/cinetpay/notify` marque bien la commande "payée".

## Limites encore présentes (à connaître)

- **Un seul code propriétaire, pas de rôle "admin" multiple** : si plusieurs
  personnes doivent gérer la plateforme, il faudrait un vrai système de
  comptes admin avec des rôles.
- **Plan gratuit Render** : le service "dort" après 15 minutes d'inactivité
  et met quelques secondes à redémarrer au premier visiteur — normal pour un
  plan gratuit, à surveiller si le trafic augmente (passer au plan payant
  réglera ça). La base Postgres gratuite Render expire aussi après 90 jours.
- **Un acheteur peut changer le statut de sa propre commande** (pas
  seulement l'annuler) via l'API, en plus du vendeur — sans conséquence sur
  l'argent ou les autres utilisateurs, mais à resserrer si tu veux un
  contrôle plus strict des statuts.

## Pour la suite

Une fois Zonako en usage réel avec des utilisateurs, il vaudra la peine de :
1. Passer sur un plan payant (Render, Railway, ou VPS) pour éviter le
   "sommeil" du service et la base gratuite à durée limitée.
2. Ajouter un vrai système de comptes admin si plusieurs personnes gèrent la plateforme.
3. Envisager un nom de domaine (ex. zonako.ci) au lieu de l'URL Render par défaut.
