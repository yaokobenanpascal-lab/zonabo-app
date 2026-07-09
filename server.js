// Zonako — serveur backend (Express + PostgreSQL)
// Sert l'API (/api/...) ET le fichier de l'appli (public/index.html) depuis le même
// serveur, pour éviter tout problème de CORS et n'avoir qu'un seul déploiement.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // CinetPay envoie sa notification en POST classique (formulaire), pas en JSON

const PORT = process.env.PORT || 3000;
const OWNER_PASSCODE = process.env.OWNER_PASSCODE || "";
if (!OWNER_PASSCODE) {
  console.warn("⚠️  OWNER_PASSCODE n'est pas défini dans les variables d'environnement — l'espace propriétaire sera inaccessible tant que ce n'est pas réglé.");
}

// Identifiants marchand CinetPay, nécessaires pour appeler l'API de vérification
// de transaction (jamais pour initier un paiement — ça, c'est le rôle du frontend).
const CINETPAY_APIKEY = process.env.CINETPAY_APIKEY || "";
const CINETPAY_SITE_ID = process.env.CINETPAY_SITE_ID || "";
if (!CINETPAY_APIKEY || !CINETPAY_SITE_ID) {
  console.warn("⚠️  CINETPAY_APIKEY / CINETPAY_SITE_ID non définis — la vérification serveur des paiements ne fonctionnera pas tant que ce n'est pas réglé.");
}

// Twilio Verify (SMS OTP) — facultatif : si absent, un code de secours s'affiche
// dans les logs du serveur (utile pour tester avant de payer pour de vrais SMS).
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID || "";
const TWILIO_CONFIGURED = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID;
if (!TWILIO_CONFIGURED) {
  console.warn("⚠️  Twilio Verify non configuré — les codes SMS s'afficheront dans les logs du serveur au lieu d'être envoyés par SMS (mode test).");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

// Au démarrage, on s'assure que toutes les tables existent (schema.sql est
// entièrement idempotent grâce à IF NOT EXISTS) — évite d'avoir à le relancer
// à la main à chaque mise à jour du projet.
async function ensureSchema() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(sql);
    console.log("Schéma de base de données vérifié/à jour.");
  } catch (e) {
    console.error("Erreur lors de la vérification du schéma:", e.message);
  }
}

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

// --- Auth propriétaire (token en mémoire, simple et suffisant pour un seul admin) ---
const ownerTokens = new Map(); // token -> expiresAt
function issueOwnerToken() {
  const token = crypto.randomBytes(24).toString("hex");
  ownerTokens.set(token, Date.now() + 12 * 3600 * 1000); // 12h
  return token;
}
function requireOwner(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const expiresAt = token && ownerTokens.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    return res.status(401).json({ error: "Non autorisé. Reconnecte-toi à l'espace propriétaire." });
  }
  next();
}

// --- Auth par téléphone (OTP SMS) : un jeton prouve "j'ai reçu le code envoyé à ce numéro" ---
const phoneTokens = new Map(); // token -> { phone, expiresAt }
function issuePhoneToken(phone) {
  const token = crypto.randomBytes(24).toString("hex");
  phoneTokens.set(token, { phone, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); // 30 jours
  return token;
}
function getTokenPhone(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const entry = token && phoneTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.phone;
}
// À utiliser sur toute route où quelqu'un agit "en tant que" tel numéro de téléphone
// (créer une commande, proposer un prix, confirmer une réception...). Compare le
// téléphone du jeton envoyé à celui que la requête prétend utiliser.
function requirePhone(expectedPhoneOf) {
  return (req, res, next) => {
    const tokenPhone = getTokenPhone(req);
    if (!tokenPhone) return res.status(401).json({ error: "Numéro non vérifié. Vérifie ton téléphone par SMS d'abord." });
    const expected = expectedPhoneOf(req);
    if (expected && tokenPhone !== expected) {
      return res.status(403).json({ error: "Ce numéro de téléphone ne correspond pas à celui vérifié." });
    }
    req.verifiedPhone = tokenPhone;
    next();
  };
}

// ---------- Mappers ligne SQL -> objet JS (camelCase, comme dans le front) ----------
function mapProduct(r) {
  return {
    id: r.id, name: r.name, price: Number(r.price), category: r.category, zone: r.zone,
    stock: r.stock, imageUrl: r.image_url, deliveryTime: r.delivery_time,
    vendorName: r.vendor_name, vendorPhone: r.vendor_phone, createdAt: Number(r.created_at),
  };
}
function mapOrder(r) {
  return {
    id: r.id, buyerName: r.buyer_name, buyerPhone: r.buyer_phone, zone: r.zone,
    items: r.items, total: Number(r.total), deliveryFee: Number(r.delivery_fee),
    feeRate: Number(r.fee_rate), commission: Number(r.commission), status: r.status,
    courierName: r.courier_name, courierPhone: r.courier_phone, createdAt: Number(r.created_at),
    paymentMethod: r.payment_method, paid: r.paid, cinetpayTransactionId: r.cinetpay_transaction_id,
    shippingMethod: r.shipping_method, transportCompany: r.transport_company, trackingNumber: r.tracking_number,
    courierBids: r.courier_bids || [], courierConfirmed: r.courier_confirmed, courierConfirmedAt: r.courier_confirmed_at ? Number(r.courier_confirmed_at) : null,
    buyerConfirmed: r.buyer_confirmed, buyerConfirmedAt: r.buyer_confirmed_at ? Number(r.buyer_confirmed_at) : null,
  };
}
function mapProfile(r) {
  return {
    role: r.role, phone: r.phone, name: r.name,
    trialStartedAt: r.trial_started_at ? Number(r.trial_started_at) : null,
    subscriptionStatus: r.subscription_status,
    subscriptionExpiresAt: r.subscription_expires_at ? Number(r.subscription_expires_at) : null,
  };
}
function mapSettings(r) {
  return { feeRate: Number(r.fee_rate), accessFee: Number(r.access_fee), trialDays: r.trial_days, ownerPayoutInfo: r.owner_payout_info || "" };
}

// ==================== VÉRIFICATION SMS (inscription/connexion) ====================
async function twilioSendCode(phone) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const r = await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/Verifications`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: phone, Channel: "sms" }),
  });
  if (!r.ok) throw new Error(`Twilio (envoi) a répondu ${r.status}`);
}
async function twilioCheckCode(phone, code) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const r = await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: phone, Code: code }),
  });
  if (!r.ok) return false;
  const data = await r.json();
  return data.status === "approved";
}

app.post("/api/auth/send-code", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Numéro de téléphone requis." });
  try {
    if (TWILIO_CONFIGURED) {
      await twilioSendCode(phone);
    } else {
      // Mode test sans Twilio : code à 6 chiffres, valable 10 min, affiché dans les logs serveur.
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await pool.query(
        `INSERT INTO otp_codes (phone, code, expires_at, attempts) VALUES ($1,$2,$3,0)
         ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, attempts = 0`,
        [phone, code, Date.now() + 10 * 60 * 1000]
      );
      console.log(`[MODE TEST — pas de Twilio configuré] Code de vérification pour ${phone} : ${code}`);
    }
    res.json({ ok: true, testMode: !TWILIO_CONFIGURED });
  } catch (e) {
    console.error("Erreur d'envoi du code:", e);
    res.status(500).json({ error: "Impossible d'envoyer le code. Réessaie." });
  }
});

app.post("/api/auth/verify-code", async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: "Numéro et code requis." });
  try {
    let ok = false;
    if (TWILIO_CONFIGURED) {
      ok = await twilioCheckCode(phone, code);
    } else {
      const { rows } = await pool.query("SELECT * FROM otp_codes WHERE phone = $1", [phone]);
      const row = rows[0];
      if (row && row.expires_at > Date.now() && row.attempts < 5) {
        ok = row.code === String(code);
        await pool.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1", [phone]);
      }
    }
    if (!ok) return res.status(401).json({ error: "Code incorrect ou expiré." });
    await pool.query(
      "INSERT INTO verified_phones (phone, verified_at) VALUES ($1,$2) ON CONFLICT (phone) DO UPDATE SET verified_at = $2",
      [phone, Date.now()]
    );
    res.json({ token: issuePhoneToken(phone) });
  } catch (e) {
    console.error("Erreur de vérification du code:", e);
    res.status(500).json({ error: "Erreur serveur pendant la vérification." });
  }
});


app.get("/api/products", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY created_at DESC");
  res.json(rows.map(mapProduct));
});

app.post("/api/products", requirePhone((req) => req.body.vendorPhone), async (req, res) => {
  const p = req.body;
  const id = uid();
  const createdAt = Date.now();
  await pool.query(
    `INSERT INTO products (id, name, price, category, zone, stock, image_url, delivery_time, vendor_name, vendor_phone, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, p.name, p.price, p.category, p.zone, p.stock || 0, p.imageUrl || "", p.deliveryTime || "Non précisé", p.vendorName, p.vendorPhone, createdAt]
  );
  const { rows } = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
  res.json(mapProduct(rows[0]));
});

app.patch("/api/products/:id", async (req, res) => {
  const tokenPhone = getTokenPhone(req);
  const { rows: existing } = await pool.query("SELECT vendor_phone FROM products WHERE id = $1", [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: "Produit introuvable." });
  if (!tokenPhone || tokenPhone !== existing[0].vendor_phone) return res.status(403).json({ error: "Tu ne peux modifier que tes propres produits." });
  const patch = req.body;
  const sets = [];
  const vals = [];
  let i = 1;
  if (patch.price !== undefined) { sets.push(`price = $${i++}`); vals.push(patch.price); }
  if (patch.stock !== undefined) { sets.push(`stock = $${i++}`); vals.push(patch.stock); }
  if (patch.deliveryTime !== undefined) { sets.push(`delivery_time = $${i++}`); vals.push(patch.deliveryTime); }
  if (patch.imageUrl !== undefined) { sets.push(`image_url = $${i++}`); vals.push(patch.imageUrl); }
  if (sets.length === 0) return res.status(400).json({ error: "Rien à mettre à jour." });
  vals.push(req.params.id);
  await pool.query(`UPDATE products SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  const { rows } = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
  res.json(rows[0] ? mapProduct(rows[0]) : null);
});

app.delete("/api/products/:id", async (req, res) => {
  const tokenPhone = getTokenPhone(req);
  const { rows: existing } = await pool.query("SELECT vendor_phone FROM products WHERE id = $1", [req.params.id]);
  if (!existing[0]) return res.json({ ok: true }); // déjà supprimé, rien à faire
  if (!tokenPhone || tokenPhone !== existing[0].vendor_phone) return res.status(403).json({ error: "Tu ne peux supprimer que tes propres produits." });
  await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ==================== COMMANDES ====================
app.get("/api/orders", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
  res.json(rows.map(mapOrder));
});

app.post("/api/orders", requirePhone((req) => req.body.buyerPhone), async (req, res) => {
  const o = req.body; // { buyerName, buyerPhone, zone, items, total, deliveryFee, paymentMethod, cinetpayTransactionId, shippingMethod }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: settingsRows } = await client.query("SELECT * FROM settings WHERE id = 1");
    const feeRate = Number(settingsRows[0].fee_rate);
    const goodsAmount = Number(o.total) - Number(o.deliveryFee || 0);
    const commission = Math.round(goodsAmount * feeRate);
    const id = uid();
    const createdAt = Date.now();
    // "paid" n'est JAMAIS pris depuis le corps de la requête : une commande démarre
    // toujours non payée. Pour CinetPay, c'est /api/cinetpay/notify (après vérification
    // auprès de CinetPay) qui la marquera payée — voir plus bas.
    await client.query(
      `INSERT INTO orders (id, buyer_name, buyer_phone, zone, items, total, delivery_fee, fee_rate, commission, status,
         courier_name, courier_phone, created_at, payment_method, paid, cinetpay_transaction_id, shipping_method,
         transport_company, tracking_number, courier_bids, courier_confirmed, buyer_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'nouvelle',NULL,NULL,$10,$11,false,$12,$13,NULL,NULL,'[]',false,false)`,
      [id, o.buyerName, o.buyerPhone, o.zone, JSON.stringify(o.items || []), o.total, o.deliveryFee || 0, feeRate, commission,
        createdAt, o.paymentMethod || "cod", o.cinetpayTransactionId || null, o.shippingMethod || "livreur"]
    );
    // Déduction du stock vendu, dans la même transaction
    for (const item of (o.items || [])) {
      await client.query("UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2", [item.qty, item.id]);
    }
    await client.query("COMMIT");
    const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
    res.json(mapOrder(rows[0]));
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Erreur lors de la création de la commande." });
  } finally {
    client.release();
  }
});

// Mise à jour générique (confirmer, annuler, expédier via transport, changer un statut)
// — réservé au(x) vendeur(s) des articles de la commande, ou à l'acheteur pour
// annuler sa propre commande (ex : paiement CinetPay refusé/annulé).
app.patch("/api/orders/:id", async (req, res) => {
  const tokenPhone = getTokenPhone(req);
  const { rows: existing } = await pool.query("SELECT items, buyer_phone FROM orders WHERE id = $1", [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: "Commande introuvable." });
  const vendorPhones = (existing[0].items || []).map((it) => it.vendorPhone).filter(Boolean);
  const isVendor = tokenPhone && vendorPhones.includes(tokenPhone);
  const isBuyer = tokenPhone && tokenPhone === existing[0].buyer_phone;
  if (!isVendor && !isBuyer) {
    return res.status(403).json({ error: "Tu n'es ni le vendeur ni l'acheteur de cette commande." });
  }
  const patch = req.body;
  const colMap = { status: "status", transportCompany: "transport_company", trackingNumber: "tracking_number" };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const key of Object.keys(colMap)) {
    if (patch[key] !== undefined) { sets.push(`${colMap[key]} = $${i++}`); vals.push(patch[key]); }
  }
  if (sets.length === 0) return res.status(400).json({ error: "Rien à mettre à jour." });
  vals.push(req.params.id);
  await pool.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(rows[0] ? mapOrder(rows[0]) : null);
});

// Un livreur propose (ou met à jour) son prix — seulement en son propre nom.
app.post("/api/orders/:id/bids", requirePhone((req) => req.body.courierPhone), async (req, res) => {
  const { courierName, courierPhone, fee } = req.body;
  const { rows } = await pool.query("SELECT courier_bids FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  const bids = (rows[0].courier_bids || []).filter((b) => b.courierPhone !== courierPhone);
  bids.push({ courierName, courierPhone, fee: Number(fee) || 0, proposedAt: Date.now() });
  await pool.query("UPDATE orders SET courier_bids = $1 WHERE id = $2", [JSON.stringify(bids), req.params.id]);
  const { rows: r2 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r2[0]));
});

// L'acheteur choisit un livreur parmi les propositions reçues — seulement sur ses propres commandes.
app.post("/api/orders/:id/choose-courier", async (req, res) => {
  const tokenPhone = getTokenPhone(req);
  const { rows: existing } = await pool.query("SELECT buyer_phone FROM orders WHERE id = $1", [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (!tokenPhone || tokenPhone !== existing[0].buyer_phone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  const { courierName, courierPhone, fee } = req.body;
  await pool.query(
    "UPDATE orders SET status = 'en_livraison', courier_name = $1, courier_phone = $2, delivery_fee = $3 WHERE id = $4",
    [courierName, courierPhone, Number(fee) || 0, req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(rows[0]));
});

// Double confirmation de réception — chacun ne peut confirmer que son propre rôle sur SA commande.
app.post("/api/orders/:id/confirm-courier", async (req, res) => {
  const tokenPhone = getTokenPhone(req);
  const { rows } = await pool.query("SELECT buyer_confirmed, courier_phone FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (!tokenPhone || tokenPhone !== rows[0].courier_phone) return res.status(403).json({ error: "Tu n'es pas le livreur de cette commande." });
  const status = rows[0].buyer_confirmed ? "livree" : undefined;
  await pool.query(
    `UPDATE orders SET courier_confirmed = true, courier_confirmed_at = $1 ${status ? ", status = 'livree'" : ""} WHERE id = $2`,
    [Date.now(), req.params.id]
  );
  const { rows: r2 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r2[0]));
});
app.post("/api/orders/:id/confirm-buyer", async (req, res) => {
  const tokenPhone = getTokenPhone(req);
  const { rows } = await pool.query("SELECT courier_confirmed, buyer_phone FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (!tokenPhone || tokenPhone !== rows[0].buyer_phone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  const status = rows[0].courier_confirmed ? "livree" : undefined;
  await pool.query(
    `UPDATE orders SET buyer_confirmed = true, buyer_confirmed_at = $1 ${status ? ", status = 'livree'" : ""} WHERE id = $2`,

    [Date.now(), req.params.id]
  );
  const { rows: r2 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r2[0]));
});

// ==================== PROFILS (vendeur / livreur) ====================
app.get("/api/profiles/:role/:phone", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [req.params.role, req.params.phone]);
  if (!rows[0]) return res.status(404).json({ error: "Profil introuvable." });
  res.json(mapProfile(rows[0]));
});

// Crée le profil s'il n'existe pas (essai gratuit démarré maintenant), ou met juste à jour le nom sinon
app.put("/api/profiles/:role/:phone", requirePhone((req) => req.params.phone), async (req, res) => {
  const { role, phone } = req.params;
  const { name } = req.body;
  const { rows } = await pool.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [role, phone]);
  if (rows[0]) {
    await pool.query("UPDATE profiles SET name = $1 WHERE role = $2 AND phone = $3", [name, role, phone]);
  } else {
    await pool.query(
      "INSERT INTO profiles (role, phone, name, trial_started_at, subscription_status) VALUES ($1,$2,$3,$4,'trial')",
      [role, phone, name, Date.now()]
    );
  }
  const { rows: r2 } = await pool.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [role, phone]);
  res.json(mapProfile(r2[0]));
});

// Changement de numéro : il faut prouver qu'on possède ET l'ancien numéro (jeton
// dans l'en-tête Authorization, comme d'habitude) ET le nouveau (un jeton fraîchement
// obtenu via /api/auth/send-code + /api/auth/verify-code sur le nouveau numéro).
// Met aussi à jour les produits et l'historique des commandes pour que rien ne se
// retrouve orphelin sous l'ancien numéro.
app.post("/api/profiles/:role/change-phone", async (req, res) => {
  const { role } = req.params;
  const { newPhone, newToken, name } = req.body;
  const oldPhone = getTokenPhone(req);
  if (!oldPhone) return res.status(401).json({ error: "Numéro actuel non vérifié. Reconnecte-toi." });
  if (!newPhone || !newToken) return res.status(400).json({ error: "Nouveau numéro et code de vérification requis." });
  if (oldPhone === newPhone) return res.status(400).json({ error: "C'est déjà ton numéro actuel." });
  const entry = phoneTokens.get(newToken);
  if (!entry || entry.expiresAt < Date.now() || entry.phone !== newPhone) {
    return res.status(403).json({ error: "Le nouveau numéro n'a pas été vérifié correctement." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingNew } = await client.query("SELECT 1 FROM profiles WHERE role = $1 AND phone = $2", [role, newPhone]);
    if (existingNew[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Ce numéro est déjà utilisé par un autre compte." });
    }
    const { rows: existingOld } = await client.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [role, oldPhone]);
    if (!existingOld[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Profil introuvable." });
    }
    await client.query(
      "UPDATE profiles SET phone = $1, name = $2 WHERE role = $3 AND phone = $4",
      [newPhone, name || existingOld[0].name, role, oldPhone]
    );

    if (role === "vendor") {
      await client.query("UPDATE products SET vendor_phone = $1 WHERE vendor_phone = $2", [newPhone, oldPhone]);
      // Met à jour vendorPhone dans les articles des commandes déjà passées, pour
      // que les autorisations (vendeur propriétaire d'une commande) continuent de marcher.
      const { rows: ordersToFix } = await client.query(
        "SELECT id, items FROM orders WHERE items @> $1::jsonb",
        [JSON.stringify([{ vendorPhone: oldPhone }])]
      );
      for (const o of ordersToFix) {
        const newItems = (o.items || []).map((it) => (it.vendorPhone === oldPhone ? { ...it, vendorPhone: newPhone } : it));
        await client.query("UPDATE orders SET items = $1 WHERE id = $2", [JSON.stringify(newItems), o.id]);
      }
    } else if (role === "courier") {
      await client.query("UPDATE orders SET courier_phone = $1 WHERE courier_phone = $2", [newPhone, oldPhone]);
      const { rows: ordersToFix } = await client.query(
        "SELECT id, courier_bids FROM orders WHERE courier_bids @> $1::jsonb",
        [JSON.stringify([{ courierPhone: oldPhone }])]
      );
      for (const o of ordersToFix) {
        const newBids = (o.courier_bids || []).map((b) => (b.courierPhone === oldPhone ? { ...b, courierPhone: newPhone } : b));
        await client.query("UPDATE orders SET courier_bids = $1 WHERE id = $2", [JSON.stringify(newBids), o.id]);
      }
    }

    await client.query("COMMIT");
    const { rows } = await pool.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [role, newPhone]);
    res.json(mapProfile(rows[0]));
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Erreur changement de numéro:", e);
    res.status(500).json({ error: "Erreur serveur pendant le changement de numéro." });
  } finally {
    client.release();
  }
});

// NB : il n'y a volontairement plus de route "activer l'abonnement" appelable
// directement — un client pourrait sinon s'activer un abonnement sans payer.
// L'activation se fait uniquement dans /api/cinetpay/notify, après vérification
// réelle du paiement auprès de CinetPay (voir plus bas).

// ==================== RÉGLAGES (propriétaire) ====================
app.get("/api/settings", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM settings WHERE id = 1");
  res.json(mapSettings(rows[0]));
});

app.put("/api/settings", requireOwner, async (req, res) => {
  const { feeRate, accessFee, trialDays, ownerPayoutInfo } = req.body;
  const sets = [];
  const vals = [];
  let i = 1;
  if (feeRate !== undefined) { sets.push(`fee_rate = $${i++}`); vals.push(feeRate); }
  if (accessFee !== undefined) { sets.push(`access_fee = $${i++}`); vals.push(accessFee); }
  if (trialDays !== undefined) { sets.push(`trial_days = $${i++}`); vals.push(trialDays); }
  if (ownerPayoutInfo !== undefined) { sets.push(`owner_payout_info = $${i++}`); vals.push(ownerPayoutInfo); }
  if (sets.length) await pool.query(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`, vals);
  const { rows } = await pool.query("SELECT * FROM settings WHERE id = 1");
  res.json(mapSettings(rows[0]));
});

// ==================== PAIEMENTS CINETPAY (vérifiés côté serveur) ====================
// Le frontend appelle ceci juste AVANT de lancer le guichet CinetPay, pour relier
// un transaction_id à la commande ou à l'abonnement concerné. Comme ça, quand
// CinetPay confirme le paiement via notify_url, le serveur sait quoi valider.
app.post("/api/payments/pending", async (req, res) => {
  const { transactionId, kind, orderId, role, phone, amount } = req.body;
  if (!transactionId || !kind) return res.status(400).json({ error: "transactionId et kind requis." });
  await pool.query(
    `INSERT INTO pending_payments (transaction_id, kind, order_id, role, phone, amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [transactionId, kind, orderId || null, role || null, phone || null, amount || 0, Date.now()]
  );
  res.json({ ok: true });
});

// Interroge CinetPay pour connaître le VRAI statut d'une transaction — on ne fait
// jamais confiance au contenu du webhook lui-même (voir doc CinetPay : c'est
// justement pour empêcher qu'un attaquant fabrique une fausse notification).
async function cinetpayCheckTransaction(transactionId) {
  const r = await fetch("https://api-checkout.cinetpay.com/v2/payment/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_id: transactionId, site_id: CINETPAY_SITE_ID, apikey: CINETPAY_APIKEY }),
  });
  return r.json();
}

// Webhook CinetPay (notify_url). CinetPay POSTe cpm_trans_id après chaque
// changement de statut d'une transaction — on ignore tout le reste du corps de
// la requête et on va vérifier nous-mêmes le vrai statut auprès de CinetPay.
app.post("/api/cinetpay/notify", async (req, res) => {
  const transactionId = req.body.cpm_trans_id || req.body.transaction_id;
  if (!transactionId) return res.status(400).send("cpm_trans_id manquant");
  try {
    const { rows } = await pool.query("SELECT * FROM pending_payments WHERE transaction_id = $1", [transactionId]);
    const pending = rows[0];
    if (!pending) {
      // Transaction inconnue de nous (ou déjà nettoyée) — on répond quand même 200
      // pour que CinetPay arrête de réessayer, mais on ne valide rien.
      console.warn("Webhook CinetPay pour une transaction inconnue:", transactionId);
      return res.status(200).send("OK");
    }
    if (pending.status === "confirmed") return res.status(200).send("OK"); // déjà traité, on ne rejoue pas

    const result = await cinetpayCheckTransaction(transactionId);
    const status = result?.data?.status;

    if (status === "ACCEPTED") {
      if (pending.kind === "order" && pending.order_id) {
        await pool.query("UPDATE orders SET paid = true WHERE id = $1", [pending.order_id]);
      } else if (pending.kind === "subscription" && pending.role && pending.phone) {
        const expiresAt = Date.now() + 30 * 86400000;
        await pool.query(
          "UPDATE profiles SET subscription_status = 'active', subscription_expires_at = $1 WHERE role = $2 AND phone = $3",
          [expiresAt, pending.role, pending.phone]
        );
      }
      await pool.query("UPDATE pending_payments SET status = 'confirmed' WHERE transaction_id = $1", [transactionId]);
    } else {
      await pool.query("UPDATE pending_payments SET status = 'failed' WHERE transaction_id = $1", [transactionId]);
    }
    res.status(200).send("OK");
  } catch (e) {
    console.error("Erreur webhook CinetPay:", e);
    res.status(200).send("OK"); // on renvoie 200 quand même pour éviter un flot de réessais ; l'erreur reste dans les logs
  }
});

// ==================== AUTH PROPRIÉTAIRE ====================
app.post("/api/owner/login", (req, res) => {
  const { code } = req.body;
  if (!OWNER_PASSCODE) return res.status(500).json({ error: "OWNER_PASSCODE non configuré sur le serveur." });
  if (code !== OWNER_PASSCODE) return res.status(401).json({ error: "Code incorrect." });
  res.json({ token: issueOwnerToken() });
});

// ==================== Frontend statique ====================
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Zonako backend en écoute sur le port ${PORT}`));
ensureSchema();
