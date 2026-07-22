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
