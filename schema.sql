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
  PRIMARY KEY (role, phone)
);

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

CREATE INDEX IF NOT EXISTS idx_products_zone ON products(zone);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_courier ON orders(courier_phone);
CREATE INDEX IF NOT EXISTS idx_orders_vendor_zone ON orders(zone);
