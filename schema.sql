-- Zonako — schéma PostgreSQL
-- À exécuter une fois sur ta base (voir README.md pour comment).

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  category TEXT,
  zone TEXT,
  stock INTEGER DEFAULT 0,
  image_url TEXT,
  delivery_time TEXT,
  vendor_name TEXT,
  vendor_phone TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  buyer_name TEXT,
  buyer_phone TEXT,
  zone TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  total NUMERIC NOT NULL DEFAULT 0,
  delivery_fee NUMERIC NOT NULL DEFAULT 0,
  fee_rate NUMERIC NOT NULL DEFAULT 0,
  commission NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'nouvelle',
  courier_name TEXT,
  courier_phone TEXT,
  created_at BIGINT NOT NULL,
  payment_method TEXT DEFAULT 'cod',
  paid BOOLEAN DEFAULT false,
  cinetpay_transaction_id TEXT,
  shipping_method TEXT DEFAULT 'livreur',
  transport_company TEXT,
  tracking_number TEXT,
  courier_bids JSONB NOT NULL DEFAULT '[]',
  courier_confirmed BOOLEAN DEFAULT false,
  courier_confirmed_at BIGINT,
  buyer_confirmed BOOLEAN DEFAULT false,
  buyer_confirmed_at BIGINT
);

CREATE TABLE IF NOT EXISTS profiles (
  role TEXT NOT NULL,        -- 'vendor' ou 'courier'
  phone TEXT NOT NULL,
  name TEXT,
  trial_started_at BIGINT,
  subscription_status TEXT DEFAULT 'trial',
  subscription_expires_at BIGINT,
  suspended BOOLEAN NOT NULL DEFAULT false,
  suspended_reason TEXT,
  suspended_at BIGINT,
  PRIMARY KEY (role, phone)
);

-- Migration pour les bases déjà existantes : CREATE TABLE IF NOT EXISTS ne
-- modifie pas une table déjà créée, donc on ajoute les nouvelles colonnes ici.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suspended_at BIGINT;

-- Signalements des acheteurs contre un vendeur (produit non conforme, jamais
-- reçu, arnaque suspectée...) — sert à repérer les vendeurs à risque.
CREATE TABLE IF NOT EXISTS vendor_reports (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  vendor_phone TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | reviewed
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_vendor ON vendor_reports(vendor_phone);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  fee_rate NUMERIC NOT NULL DEFAULT 0.05,
  access_fee NUMERIC NOT NULL DEFAULT 2000,
  trial_days INTEGER NOT NULL DEFAULT 7,
  owner_payout_info TEXT DEFAULT '',
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Paiements en attente de confirmation par CinetPay (webhook notify_url). On y relie
-- un transaction_id à soit une commande, soit un abonnement, AVANT de lancer le
-- guichet de paiement — c'est ce qui permet au webhook de savoir quoi valider une
-- fois que CinetPay confirme le paiement de son côté.
CREATE TABLE IF NOT EXISTS pending_payments (
  transaction_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'order' ou 'subscription'
  order_id TEXT,
  role TEXT,                      -- 'vendor' ou 'courier' (abonnement)
  phone TEXT,
  amount NUMERIC,
  notify_token TEXT,              -- jeton renvoyé par CinetPay à l'initialisation, pour authentifier le webhook (nouvelle API Aurore)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | failed
  created_at BIGINT NOT NULL
);

-- Vérification par téléphone (OTP SMS) à l'inscription/connexion.
CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS verified_phones (
  phone TEXT PRIMARY KEY,
  verified_at BIGINT NOT NULL
);

-- Contenu modifiable par le propriétaire sans redéploiement : textes affichés
-- aux trois rôles, plus la liste des zones et des catégories de produits.
CREATE TABLE IF NOT EXISTS site_content (
  id INTEGER PRIMARY KEY DEFAULT 1,
  home_headline TEXT,
  home_subheadline TEXT,
  role_desc_buyer TEXT,
  role_desc_vendor TEXT,
  role_desc_courier TEXT,
  tip_buyer TEXT,
  tip_vendor TEXT,
  tip_courier TEXT,
  zones JSONB,
  categories JSONB,
  CONSTRAINT single_row_content CHECK (id = 1)
);

INSERT INTO site_content (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Annonce/bannière que le propriétaire peut publier pour tous les acheteurs
-- inscrits (nouveau vendeur, nouveau produit...) — une seule à la fois,
-- affichée jusqu'à ce que l'acheteur la ferme ou qu'une nouvelle la remplace.
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS announcement_message TEXT;
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS announcement_product_id TEXT;
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS announcement_created_at BIGINT;
-- Vidéo courte "en direct" qu'un vendeur peut pousser lui-même dans la
-- bannière — permet une pub vidéo rapide sans vrai streaming en temps réel.
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS announcement_video_url TEXT;

-- Migration pour les bases déjà existantes.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT 'none'; -- none | pending | done
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;

-- Notes laissées par l'acheteur sur le vendeur et/ou le livreur, une fois la
-- commande livrée — sert à afficher une réputation et à repérer les problèmes tôt.
CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  ratee_phone TEXT NOT NULL,
  ratee_role TEXT NOT NULL, -- 'vendor' ou 'courier'
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (order_id, ratee_phone)
);
CREATE INDEX IF NOT EXISTS idx_ratings_ratee ON ratings(ratee_phone);

CREATE INDEX IF NOT EXISTS idx_products_zone ON products(zone);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_courier ON orders(courier_phone);
CREATE INDEX IF NOT EXISTS idx_orders_vendor_zone ON orders(zone);

-- Migration pour les bases déjà existantes.
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_landmark TEXT; -- quartier / point de repère du vendeur, visible par le livreur
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS landmark TEXT; -- point de repère par défaut du vendeur, réutilisé à chaque nouveau produit
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT true; -- disponibilité du livreur

-- Jeton de connexion propriétaire, stocké en base plutôt qu'en mémoire — reste
-- valide même si le serveur redémarre (déploiement, veille du plan gratuit...).
CREATE TABLE IF NOT EXISTS owner_tokens (
  token TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);

-- Jetons de connexion acheteur/vendeur/livreur (après vérification SMS/email),
-- stockés en base plutôt qu'en mémoire — même raison que owner_tokens ci-dessus :
-- sans ça, tout le monde est déconnecté à chaque redémarrage du serveur.
CREATE TABLE IF NOT EXISTS phone_tokens (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phone_tokens_phone ON phone_tokens(phone);

-- Empêche la création de deux commandes identiques en cas de double-clic /
-- mauvaise connexion : le client envoie une clé unique par tentative d'achat,
-- et le serveur ignore les doublons envoyés dans les 30 secondes.
CREATE TABLE IF NOT EXISTS order_idempotency (
  client_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Historique des actions du propriétaire (suspension, vérification, remboursement
-- marqué fait...) — utile pour retracer ce qui a été fait et quand.
CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_date ON admin_actions(created_at DESC);

-- Informations sur l'engin du livreur — affichées à l'acheteur et au vendeur
-- pour sécuriser l'enlèvement et la remise du colis (savoir qui reconnaître).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vehicle_type TEXT; -- ex: moto, vélo, voiture, tricycle
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vehicle_plate TEXT; -- immatriculation / repère de l'engin

-- Suivi en direct du colis : dernière position connue du livreur pendant une
-- livraison en cours, partagée volontairement depuis son téléphone.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_lng DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_updated_at BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_vehicle_type TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_vehicle_plate TEXT;

-- Plusieurs photos par produit (galerie) — image_url reste la photo de
-- couverture (affichée sur la carte produit), image_urls contient toutes les
-- photos dans l'ordre, y compris la première.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_urls JSONB DEFAULT '[]';

-- Négociation acheteur ↔ vendeur sur la compagnie de transport (expédition
-- intercité) et ses frais : chacun peut proposer une compagnie, l'autre
-- confirme ou contre-propose, jusqu'à accord des deux côtés.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_fee NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_proposed_by TEXT; -- 'buyer' ou 'vendor'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_confirmed_by_buyer BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_confirmed_by_vendor BOOLEAN DEFAULT false;

-- Adresse / point de repère de l'acheteur pour cette commande — affichée sur le
-- bon de commande du vendeur (comme le point de repère du vendeur l'est pour l'acheteur).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_address TEXT;

-- Numéro de commande auto-incrémenté (1, 2, 3...) — utilisé pour numéroter les
-- reçus/bons de commande de façon lisible (syllabe du nom + ce compteur),
-- plutôt qu'un identifiant technique.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_seq SERIAL;

-- Espace notes/tâches partagé de l'équipe propriétaire — accessible avec le
-- même code propriétaire, pour préparer l'arrivée de futurs collaborateurs.
CREATE TABLE IF NOT EXISTS owner_notes (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_notes_date ON owner_notes(created_at DESC);

-- Mot de passe facultatif pour acheteur/vendeur/livreur — permet de se
-- reconnecter directement sans redemander un code SMS/email à chaque fois.
-- Le code SMS/email reste utilisé pour la première inscription et pour
-- réinitialiser le mot de passe en cas d'oubli.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Portefeuille prépayé du vendeur : la commission de la commande est déduite
-- automatiquement de ce solde dès que la commande est livrée (jamais avant,
-- pour ne pas demander au vendeur de payer sur une vente pas encore aboutie).
-- Le propriétaire crédite ce solde manuellement pour l'instant (en attendant
-- un vrai rechargement en ligne via CinetPay).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC NOT NULL DEFAULT 0;

-- Demandes de retrait du propriétaire (commissions encaissées → banque/Mobile
-- Money). Enregistrées ici pour préparer le terrain ; l'exécution réelle du
-- transfert dépend du service "Transfert d'argent" de CinetPay (contrat séparé,
-- pas encore actif) — en attendant, le propriétaire les traite lui-même
-- manuellement et les marque "faites" une fois l'argent envoyé.
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id TEXT PRIMARY KEY,
  amount NUMERIC NOT NULL,
  method TEXT NOT NULL, -- 'bank' ou 'mobile_money'
  account_info TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done
  created_at BIGINT NOT NULL,
  done_at BIGINT,
  vendor_phone TEXT -- NULL = retrait du propriétaire ; rempli = retrait de ce vendeur
);
-- Retrait d'un agent de recrutement (commissions de parrainage gagnées).
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS agent_phone TEXT;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS vendor_phone TEXT;

-- Vidéo de présentation d'un produit/boutique (marketing) — nécessite Cloudinary
-- configuré côté vendeur (les vidéos ne peuvent pas être stockées en base64
-- comme les photos, bien trop volumineuses).
ALTER TABLE products ADD COLUMN IF NOT EXISTS video_url TEXT;

-- Jusqu'à 5 vidéos par produit (même principe que les 5 photos) —
-- video_url reste la première/vidéo de couverture.
ALTER TABLE products ADD COLUMN IF NOT EXISTS video_urls JSONB DEFAULT '[]';

-- Litige de non-conformité : l'acheteur peut refuser de confirmer une
-- réception s'il estime que l'article reçu ne correspond pas aux
-- photos/vidéos annoncées. Bloque le déblocage des fonds du vendeur (le
-- statut de la commande ne passe pas à "livree") jusqu'à tranchage par le
-- propriétaire.
CREATE TABLE IF NOT EXISTS order_disputes (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  vendor_phone TEXT,
  description TEXT,
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved_buyer | resolved_vendor
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON order_disputes(status);

-- Photo "reçue" jointe par l'acheteur à son avis — preuve visible par les
-- futurs acheteurs, à côté des photos/vidéos du vendeur.
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Acompte de garantie facultatif (expédition par compagnie de transport) : le
-- vendeur peut demander un acompte, montant de son choix, payé par l'acheteur
-- via CinetPay et bloqué chez le propriétaire. Si l'acheteur annule APRÈS que
-- le vendeur a déjà expédié (frais engagés), l'acompte compense le vendeur au
-- lieu d'être remboursé.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_deposit_amount NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_deposit_paid BOOLEAN NOT NULL DEFAULT false;

-- Marque une annulation "tardive" : l'acheteur a annulé après que le vendeur
-- avait déjà confirmé la commande (donc engagé du temps/argent), pas pendant
-- la fenêtre de réflexion gratuite. Sert au score de fiabilité acheteur.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS late_cancellation BOOLEAN NOT NULL DEFAULT false;

-- Horodatage du moment où acheteur ET vendeur ont tous deux confirmé la
-- compagnie de transport et les frais — sert de départ à une deuxième
-- fenêtre de réflexion (10 min) avant que le vendeur puisse expédier.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_settled_at BIGINT;

-- Confirmation automatique de réception si l'acheteur reste inactif : évite
-- que le vendeur reste bloqué indéfiniment si l'acheteur oublie ou néglige de
-- confirmer. in_transit_at = quand la commande est passée "en livraison"/
-- "en transit" ; auto_confirmed = true si la confirmation a été automatique
-- (pas un vrai clic de l'acheteur), affiché pour rester transparent.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS in_transit_at BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_confirmed BOOLEAN NOT NULL DEFAULT false;

-- ==================== NOTIFICATIONS COMPORTEMENTALES (EMAIL) ====================
-- Nécessite que l'acheteur se soit inscrit par email (le seul canal fiable
-- actuellement — SMS bloqué tant que Twilio/Africa's Talking ne sont pas actifs).

-- Favoris : produits qu'un acheteur a mis de côté. last_known_price sert à
-- détecter une baisse de prix sans notifier deux fois pour la même baisse.
CREATE TABLE IF NOT EXISTS favorites (
  buyer_phone TEXT NOT NULL,
  product_id TEXT NOT NULL,
  last_known_price NUMERIC,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (buyer_phone, product_id)
);

-- Historique de vues : pour relancer un acheteur qui a regardé un produit
-- sans jamais commander. "reminded" évite de relancer plusieurs fois pour la
-- même vue.
CREATE TABLE IF NOT EXISTS product_views (
  id TEXT PRIMARY KEY,
  buyer_phone TEXT NOT NULL,
  product_id TEXT NOT NULL,
  viewed_at BIGINT NOT NULL,
  reminded BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_product_views_buyer ON product_views(buyer_phone);

-- Suivi de catégories : l'acheteur veut être notifié des nouveautés dans une catégorie.
CREATE TABLE IF NOT EXISTS category_follows (
  buyer_phone TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (buyer_phone, category)
);

-- Historique des notifications envoyées — sert d'anti-spam (pas plus d'une
-- notif d'un même type par acheteur toutes les 24h).
CREATE TABLE IF NOT EXISTS notification_log (
  id TEXT PRIMARY KEY,
  buyer_phone TEXT NOT NULL,
  type TEXT NOT NULL, -- 'view_reminder' | 'price_drop' | 'category_new_product'
  reference_id TEXT,
  sent_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_log_buyer_type ON notification_log(buyer_phone, type, sent_at);

-- Accroche publicitaire courte (générée par l'IA en même temps que la
-- description) — affichée en surimpression animée sur la photo du produit.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tagline TEXT;

-- ==================== AGENTS DE RECRUTEMENT (PARRAINAGE) ====================
-- Des agents commerciaux recrutent de nouveaux inscrits (acheteur, vendeur,
-- livreur) via un code personnel, et gagnent une commission — payée
-- seulement quand la personne recrutée devient réellement active (première
-- commande livrée, premier produit publié, première livraison confirmée),
-- pas à la simple inscription, pour limiter les faux comptes.
CREATE TABLE IF NOT EXISTS referral_agents (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  rate_buyer NUMERIC NOT NULL DEFAULT 0,
  rate_vendor NUMERIC NOT NULL DEFAULT 0,
  rate_courier NUMERIC NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_signups (
  id TEXT PRIMARY KEY,
  agent_phone TEXT NOT NULL,
  new_user_phone TEXT NOT NULL,
  role TEXT NOT NULL, -- buyer | vendor | courier
  activated BOOLEAN NOT NULL DEFAULT false,
  activated_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE (new_user_phone, role) -- une seule personne = un seul agent crédité, par rôle
);
CREATE INDEX IF NOT EXISTS idx_referral_signups_agent ON referral_signups(agent_phone);

-- ==================== SÉCURITÉ : JOURNAL D'ÉVÉNEMENTS SUSPECTS ====================
-- Trace les tentatives de connexion échouées et autres signaux suspects, pour
-- que le propriétaire puisse détecter une attaque en cours, pas juste la bloquer
-- silencieusement.
CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- failed_owner_login | owner_login_blocked | failed_password_login | password_login_blocked
  detail TEXT,
  ip TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);

-- Suivi des photos générées par IA (mannequin/présentation) parmi les photos
-- d'un produit — sert à afficher un badge "Photo stylisée" côté acheteur, et
-- à empêcher qu'un produit n'ait QUE des photos générées (au moins une vraie
-- photo doit toujours rester).
ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_photo_urls JSONB DEFAULT '[]';

-- Code de confirmation de livraison (4 chiffres) — connu seulement de
-- l'acheteur, exigé du livreur pour valider la remise. Empêche un livreur de
-- prétendre avoir livré sans l'avoir fait, et protège contre l'interception
-- du colis par une autre personne que l'acheteur.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_pin TEXT;

-- Paiement en ligne des frais de livreur (en plus de l'espèces déjà
-- possible) — l'argent reste bloqué chez le propriétaire jusqu'à la
-- confirmation de livraison (même code à 4 chiffres), puis rejoint le
-- portefeuille du livreur automatiquement.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_fee_payment_method TEXT DEFAULT 'cash'; -- 'cash' | 'cinetpay'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_fee_paid BOOLEAN NOT NULL DEFAULT false;
-- Confirmation écrite du livreur qu'il a bien reçu son paiement (espèces ou
-- en ligne) — donnée au même moment que le code de livraison.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_payment_confirmed BOOLEAN NOT NULL DEFAULT false;
-- Retrait d'un livreur (frais de livraison payés en ligne) — même principe
-- que pour les vendeurs et les agents.
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS courier_phone TEXT;

-- ==================== NÉGOCIATION DE PRIX ====================
-- Le vendeur choisit produit par produit s'il accepte la négociation — comme
-- dans un vrai marché, tout ne se discute pas.
ALTER TABLE products ADD COLUMN IF NOT EXISTS negotiable BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS price_negotiations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  vendor_phone TEXT NOT NULL,
  original_price NUMERIC NOT NULL,
  proposed_price NUMERIC NOT NULL,
  proposed_by TEXT NOT NULL, -- 'buyer' | 'vendor'
  status TEXT NOT NULL DEFAULT 'open', -- open | accepted | rejected | expired
  accepted_price NUMERIC,
  accepted_at BIGINT,
  expires_at BIGINT, -- accepted_at + 24h — passé ce délai, le prix négocié n'est plus valable
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (product_id, buyer_phone)
);
CREATE INDEX IF NOT EXISTS idx_negotiations_vendor ON price_negotiations(vendor_phone, status);
CREATE INDEX IF NOT EXISTS idx_negotiations_buyer ON price_negotiations(buyer_phone, status);

-- Migration vers la nouvelle API CinetPay "Aurore" (v1) — jeton d'authenticité du webhook.
ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS notify_token TEXT;

-- Suivi anonyme des visiteurs du site (pas de compte, pas d'inscription) — un
-- identifiant généré côté navigateur, sans aucune donnée personnelle. Sert à
-- repérer les visiteurs qui reviennent sans s'être inscrits, pour leur
-- afficher un rappel bienveillant, et à donner une vue d'ensemble au
-- propriétaire dans son tableau de bord.
CREATE TABLE IF NOT EXISTS site_visitors (
  visitor_id TEXT PRIMARY KEY,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1
);

-- "Vitrine de magasin" — image générée par IA regroupant plusieurs produits
-- réels du vendeur, arrangés comme dans une vraie vitrine de boutique.
-- Affichée en bannière sur sa page boutique publique.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vitrine_image_url TEXT;
