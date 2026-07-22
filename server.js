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

// Connexion par email (en plus du téléphone) — envoie un code par email via
// l'API HTTP de Brevo (pas le SMTP classique : Render bloque les ports SMTP
// 25/465/587 sur le plan gratuit depuis septembre 2025, l'API HTTP passe par
// le port 443 comme n'importe quel site web, donc pas de souci). Facultatif :
// sans réglage, les codes email s'affichent dans les logs du serveur.
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || "";
const EMAIL_CONFIGURED = BREVO_API_KEY && BREVO_FROM_EMAIL;
if (!EMAIL_CONFIGURED) {
  console.warn("⚠️  Brevo non configuré (BREVO_API_KEY/BREVO_FROM_EMAIL) — les codes envoyés par email s'afficheront dans les logs du serveur (mode test).");
}
async function sendEmailCode(email, code) {
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
    body: JSON.stringify({
      sender: { email: BREVO_FROM_EMAIL, name: "Zonako" },
      to: [{ email }],
      subject: "Ton code de vérification Zonako",
      textContent: `Ton code de vérification Zonako est : ${code}\n\nIl est valable 10 minutes.`,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Brevo a répondu ${r.status} : ${detail}`);
  }
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

// --- Auth propriétaire (jeton stocké en base — survit aux redémarrages du serveur) ---
async function issueOwnerToken() {
  const token = crypto.randomBytes(24).toString("hex");
  await pool.query("INSERT INTO owner_tokens (token, expires_at) VALUES ($1,$2)", [token, Date.now() + 12 * 3600 * 1000]); // 12h
  return token;
}
async function requireOwner(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non autorisé. Reconnecte-toi à l'espace propriétaire." });
  try {
    const { rows } = await pool.query("SELECT expires_at FROM owner_tokens WHERE token = $1", [token]);
    if (!rows[0] || Number(rows[0].expires_at) < Date.now()) {
      return res.status(401).json({ error: "Non autorisé. Reconnecte-toi à l'espace propriétaire." });
    }
    next();
  } catch (e) {
    console.error("Erreur de vérification du jeton propriétaire:", e);
    res.status(500).json({ error: "Erreur serveur." });
  }
}
// Journal des actions du propriétaire — jamais bloquant : une erreur ici n'empêche
// pas l'action elle-même de réussir.
async function logAdminAction(action, target, details) {
  try {
    await pool.query(
      "INSERT INTO admin_actions (id, action, target, details, created_at) VALUES ($1,$2,$3,$4,$5)",
      [uid(), action, target || null, details || null, Date.now()]
    );
  } catch (e) {
    console.error("Erreur d'écriture du journal admin (non bloquant):", e.message);
  }
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
    description: r.description || "", vendorLandmark: r.vendor_landmark || "",
    imageUrls: r.image_urls && r.image_urls.length ? r.image_urls : (r.image_url ? [r.image_url] : []),
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
    refundStatus: r.refund_status || "none",
    courierLat: r.courier_lat !== null && r.courier_lat !== undefined ? Number(r.courier_lat) : null,
    courierLng: r.courier_lng !== null && r.courier_lng !== undefined ? Number(r.courier_lng) : null,
    locationUpdatedAt: r.location_updated_at ? Number(r.location_updated_at) : null,
    courierVehicleType: r.courier_vehicle_type || "",
    courierVehiclePlate: r.courier_vehicle_plate || "",
    transportFee: r.transport_fee !== null && r.transport_fee !== undefined ? Number(r.transport_fee) : null,
    transportProposedBy: r.transport_proposed_by || null,
    transportConfirmedByBuyer: r.transport_confirmed_by_buyer || false,
    transportConfirmedByVendor: r.transport_confirmed_by_vendor || false,
    buyerAddress: r.buyer_address || "",
    orderSeq: r.order_seq || null,
  };
}
function mapProfile(r) {
  return {
    role: r.role, phone: r.phone, name: r.name,
    trialStartedAt: r.trial_started_at ? Number(r.trial_started_at) : null,
    subscriptionStatus: r.subscription_status,
    subscriptionExpiresAt: r.subscription_expires_at ? Number(r.subscription_expires_at) : null,
    suspended: r.suspended || false,
    suspendedReason: r.suspended_reason || null,
    suspendedAt: r.suspended_at ? Number(r.suspended_at) : null,
    verified: r.verified || false,
    landmark: r.landmark || "",
    available: r.available !== false,
    vehicleType: r.vehicle_type || "",
    vehiclePlate: r.vehicle_plate || "",
  };
}
function mapReport(r) {
  return {
    id: r.id, orderId: r.order_id, vendorPhone: r.vendor_phone, buyerPhone: r.buyer_phone,
    reason: r.reason, details: r.details, status: r.status, createdAt: Number(r.created_at),
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

// Envoi d'un SMS "libre" (pas un code OTP) — utilisé pour notifier les
// utilisateurs des changements de statut de commande. Nécessite en plus
// TWILIO_FROM_NUMBER (un numéro Twilio acheté, différent du Verify Service).
// Si non configuré, la notification est simplement ignorée (pas d'erreur).
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
async function sendSmsNotification(phone, message) {
  if (!TWILIO_CONFIGURED || !TWILIO_FROM_NUMBER || !phone) return;
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: TWILIO_FROM_NUMBER, To: phone, Body: message }),
    });
  } catch (e) {
    console.error("Erreur d'envoi SMS de notification (non bloquant):", e.message);
  }
}

// Anti-abus : au plus 3 demandes de code par numéro et par heure, pour éviter
// le spam/harcèlement d'un numéro et limiter les coûts SMS.
const otpRateLimit = new Map(); // phone -> [timestamps]
function isRateLimited(phone) {
  const now = Date.now();
  const hourAgo = now - 3600 * 1000;
  const hits = (otpRateLimit.get(phone) || []).filter((t) => t > hourAgo);
  otpRateLimit.set(phone, hits);
  return hits.length >= 3;
}
function recordOtpAttempt(phone) {
  const hits = otpRateLimit.get(phone) || [];
  hits.push(Date.now());
  otpRateLimit.set(phone, hits);
}

app.post("/api/auth/send-code", async (req, res) => {
  const { phone } = req.body; // "phone" reste le nom du champ pour rester compatible, mais peut être un email
  if (!phone) return res.status(400).json({ error: "Numéro de téléphone ou email requis." });
  if (isRateLimited(phone)) {
    return res.status(429).json({ error: "Trop de demandes de code pour cet identifiant. Réessaie dans une heure." });
  }
  const isEmail = phone.includes("@");
  try {
    if (isEmail) {
      // Connexion par email : toujours via notre propre code à 6 chiffres (Twilio Verify ne gère pas l'email).
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await pool.query(
        `INSERT INTO otp_codes (phone, code, expires_at, attempts) VALUES ($1,$2,$3,0)
         ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, attempts = 0`,
        [phone, code, Date.now() + 10 * 60 * 1000]
      );
      if (EMAIL_CONFIGURED) {
        await sendEmailCode(phone, code);
      } else {
        console.log(`[MODE TEST — pas de Brevo configuré] Code de vérification pour ${phone} : ${code}`);
      }
      recordOtpAttempt(phone);
      return res.json({ ok: true, testMode: !EMAIL_CONFIGURED });
    }
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
    recordOtpAttempt(phone);
    res.json({ ok: true, testMode: !TWILIO_CONFIGURED });
  } catch (e) {
    console.error("Erreur d'envoi du code:", e);
    res.status(500).json({ error: "Impossible d'envoyer le code. Réessaie." });
  }
});

app.post("/api/auth/verify-code", async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: "Identifiant et code requis." });
  const isEmail = phone.includes("@");
  try {
    let ok = false;
    if (!isEmail && TWILIO_CONFIGURED) {
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
  // Les produits des vendeurs suspendus (signalés/vérifiés arnaqueurs) sont
  // masqués de la liste publique, sans être supprimés (le vendeur les retrouve
  // si sa suspension est levée).
  const { rows } = await pool.query(
    `SELECT p.* FROM products p
     LEFT JOIN profiles pr ON pr.role = 'vendor' AND pr.phone = p.vendor_phone
     WHERE COALESCE(pr.suspended, false) = false
     ORDER BY p.created_at DESC`
  );
  res.json(rows.map(mapProduct));
});

app.post("/api/products", requirePhone((req) => req.body.vendorPhone), async (req, res) => {
  const p = req.body;
  const { rows: prof } = await pool.query("SELECT suspended, landmark FROM profiles WHERE role = 'vendor' AND phone = $1", [p.vendorPhone]);
  if (prof[0]?.suspended) return res.status(403).json({ error: "Ton compte vendeur est suspendu. Contacte le propriétaire de la plateforme." });
  const id = uid();
  const createdAt = Date.now();
  // Le point de repère : celui donné pour ce produit, sinon celui par défaut du profil vendeur.
  const landmark = p.vendorLandmark || prof[0]?.landmark || "";
  // Jusqu'à 5 photos par produit. La première sert de photo de couverture (image_url).
  const imageUrls = Array.isArray(p.imageUrls) ? p.imageUrls.slice(0, 5) : (p.imageUrl ? [p.imageUrl] : []);
  const coverImage = imageUrls[0] || p.imageUrl || "";
  await pool.query(
    `INSERT INTO products (id, name, price, category, zone, stock, image_url, delivery_time, vendor_name, vendor_phone, created_at, description, vendor_landmark, image_urls)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, p.name, p.price, p.category, p.zone, p.stock || 0, coverImage, p.deliveryTime || "Non précisé", p.vendorName, p.vendorPhone, createdAt, p.description || "", landmark, JSON.stringify(imageUrls)]
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
  if (patch.description !== undefined) { sets.push(`description = $${i++}`); vals.push(patch.description); }
  if (patch.vendorLandmark !== undefined) { sets.push(`vendor_landmark = $${i++}`); vals.push(patch.vendorLandmark); }
  if (Array.isArray(patch.imageUrls)) {
    const imageUrls = patch.imageUrls.slice(0, 5);
    sets.push(`image_urls = $${i++}`); vals.push(JSON.stringify(imageUrls));
    sets.push(`image_url = $${i++}`); vals.push(imageUrls[0] || "");
  } else if (patch.imageUrl !== undefined) {
    sets.push(`image_url = $${i++}`); vals.push(patch.imageUrl);
  }
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
  const o = req.body; // { buyerName, buyerPhone, zone, items, total, deliveryFee, paymentMethod, cinetpayTransactionId, shippingMethod, clientKey }
  // Anti-doublon : si ce même clientKey a déjà créé une commande il y a moins de
  // 30 secondes (double-clic, mauvaise connexion qui fait réessayer...), on renvoie
  // la commande déjà créée au lieu d'en recréer une deuxième.
  if (o.clientKey) {
    const { rows: existing } = await pool.query("SELECT order_id, created_at FROM order_idempotency WHERE client_key = $1", [o.clientKey]);
    if (existing[0] && Date.now() - Number(existing[0].created_at) < 30000) {
      const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [existing[0].order_id]);
      if (rows[0]) return res.json(mapOrder(rows[0]));
    }
  }
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
    // Si l'acheteur choisit l'expédition par compagnie de transport et propose une
    // compagnie, c'est enregistré comme sa proposition initiale — le vendeur devra
    // la confirmer (avec des frais) ou en proposer une autre.
    const initialTransportCompany = o.shippingMethod === "transport" && o.transportCompany ? o.transportCompany : null;
    await client.query(
      `INSERT INTO orders (id, buyer_name, buyer_phone, zone, items, total, delivery_fee, fee_rate, commission, status,
         courier_name, courier_phone, created_at, payment_method, paid, cinetpay_transaction_id, shipping_method,
         transport_company, tracking_number, courier_bids, courier_confirmed, buyer_confirmed,
         transport_proposed_by, transport_confirmed_by_buyer, buyer_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'nouvelle',NULL,NULL,$10,$11,false,$12,$13,$14,NULL,'[]',false,false,$15,$16,$17)`,
      [id, o.buyerName, o.buyerPhone, o.zone, JSON.stringify(o.items || []), o.total, o.deliveryFee || 0, feeRate, commission,
        createdAt, o.paymentMethod || "cod", o.cinetpayTransactionId || null, o.shippingMethod || "livreur",
        initialTransportCompany, initialTransportCompany ? "buyer" : null, !!initialTransportCompany, o.buyerAddress || ""]
    );
    if (o.clientKey) {
      await client.query(
        "INSERT INTO order_idempotency (client_key, order_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (client_key) DO NOTHING",
        [o.clientKey, id, createdAt]
      );
    }
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
  const { rows: existing } = await pool.query("SELECT items, buyer_phone, paid, status AS old_status FROM orders WHERE id = $1", [req.params.id]);
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
  // Une commande déjà payée qui est annulée doit être remboursée — CinetPay
  // n'offre pas d'API de remboursement automatique, donc on la place dans une
  // file "à rembourser manuellement" que le propriétaire traite depuis son espace.
  if (patch.status === "annulee" && existing[0].paid) {
    sets.push(`refund_status = $${i++}`);
    vals.push("pending");
  }
  if (sets.length === 0) return res.status(400).json({ error: "Rien à mettre à jour." });
  vals.push(req.params.id);
  await pool.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const updated = rows[0] ? mapOrder(rows[0]) : null;
  if (updated && patch.status === "confirmee" && existing[0].old_status !== "confirmee") {
    sendSmsNotification(updated.buyerPhone, `Zonako : ta commande #${updated.id.slice(-6)} a été confirmée par le vendeur, elle est en préparation.`);
  }
  res.json(updated);
});

// Un livreur propose (ou met à jour) son prix — seulement en son propre nom.
// Même logique que côté client (getAccessState) : jours restants sur l'essai
// gratuit, ou sur l'abonnement payant s'il est actif.
function computeDaysLeft(profile, trialDays) {
  const trialStartedAt = profile.trial_started_at ? Number(profile.trial_started_at) : Date.now();
  const daysUsed = Math.floor((Date.now() - trialStartedAt) / 86400000);
  const trialDaysLeft = Math.max(0, trialDays - daysUsed);
  const subscriptionActive = profile.subscription_status === "active" && profile.subscription_expires_at && Number(profile.subscription_expires_at) > Date.now();
  if (subscriptionActive) return Math.ceil((Number(profile.subscription_expires_at) - Date.now()) / 86400000);
  return trialDaysLeft;
}

app.post("/api/orders/:id/bids", requirePhone((req) => req.body.courierPhone), async (req, res) => {
  const { courierName, courierPhone, fee } = req.body;
  const { rows: prof } = await pool.query("SELECT * FROM profiles WHERE role = 'courier' AND phone = $1", [courierPhone]);
  if (prof[0] && prof[0].available === false) return res.status(403).json({ error: "Tu es marqué indisponible — réactive-toi depuis ton espace pour proposer un prix." });
  if (prof[0]) {
    const { rows: settingsRows } = await pool.query("SELECT trial_days FROM settings WHERE id = 1");
    const daysLeft = computeDaysLeft(prof[0], settingsRows[0].trial_days);
    if (daysLeft <= 3) return res.status(403).json({ error: "Ton accès Zonako expire bientôt — renouvelle ton abonnement avant de proposer un prix sur une nouvelle livraison." });
  }
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
  const { rows: courierProf } = await pool.query("SELECT vehicle_type, vehicle_plate FROM profiles WHERE role = 'courier' AND phone = $1", [courierPhone]);
  await pool.query(
    "UPDATE orders SET status = 'en_livraison', courier_name = $1, courier_phone = $2, delivery_fee = $3, courier_vehicle_type = $4, courier_vehicle_plate = $5 WHERE id = $6",
    [courierName, courierPhone, Number(fee) || 0, courierProf[0]?.vehicle_type || "", courierProf[0]?.vehicle_plate || "", req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const updated = mapOrder(rows[0]);
  sendSmsNotification(courierPhone, `Zonako : tu as été choisi pour livrer la commande #${updated.id.slice(-6)} (${updated.zone}). Frais convenus : ${fee} F.`);
  res.json(updated);
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
  const { rows } = await pool.query("SELECT courier_confirmed, buyer_phone, shipping_method, status FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (!tokenPhone || tokenPhone !== rows[0].buyer_phone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  // Livraison par compagnie de transport : dès que l'acheteur confirme avoir
  // récupéré son colis à l'agence, la commande passe directement "livrée" —
  // il n'y a pas de livreur à faire confirmer en plus, contrairement au cas
  // "livreur" ci-dessous (double confirmation acheteur + livreur).
  const isTransportPickup = rows[0].shipping_method === "transport" && rows[0].status === "en_transit";
  const status = (isTransportPickup || rows[0].courier_confirmed) ? "livree" : undefined;
  await pool.query(
    `UPDATE orders SET buyer_confirmed = true, buyer_confirmed_at = $1 ${status ? ", status = 'livree'" : ""} WHERE id = $2`,

    [Date.now(), req.params.id]
  );
  const { rows: r2 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r2[0]));
});

// ==================== NÉGOCIATION COMPAGNIE DE TRANSPORT ====================
// L'acheteur propose une compagnie à la commande (voir création). Ensuite,
// acheteur et vendeur peuvent chacun "proposer" (changer la compagnie et/ou
// les frais — seul le vendeur peut fixer des frais) ou "confirmer" la
// proposition en cours de l'autre, jusqu'à accord des deux côtés.
app.post("/api/orders/:id/transport-propose", requirePhone((req) => req.body.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  const order = rows[0];
  const phone = req.body.phone;
  const isBuyer = phone === order.buyer_phone;
  const isVendor = (order.items || []).some((it) => it.vendorPhone === phone);
  if (!isBuyer && !isVendor) return res.status(403).json({ error: "Non autorisé sur cette commande." });
  const role = isBuyer ? "buyer" : "vendor";
  const company = (req.body.company || "").trim();
  if (!company) return res.status(400).json({ error: "Indique une compagnie de transport." });
  let fee = order.transport_fee;
  if (role === "vendor") {
    if (req.body.fee === undefined || req.body.fee === null || Number(req.body.fee) < 0) {
      return res.status(400).json({ error: "Indique des frais d'expédition." });
    }
    fee = Number(req.body.fee);
  } else {
    fee = null; // l'acheteur propose une compagnie, pas des frais — le vendeur les fixera
  }
  await pool.query(
    `UPDATE orders SET transport_company = $1, transport_fee = $2, transport_proposed_by = $3,
       transport_confirmed_by_buyer = $4, transport_confirmed_by_vendor = $5 WHERE id = $6`,
    [company, fee, role, role === "buyer", role === "vendor", req.params.id]
  );
  const { rows: r2 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r2[0]));
});
app.post("/api/orders/:id/transport-confirm", requirePhone((req) => req.body.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  const order = rows[0];
  const phone = req.body.phone;
  const isBuyer = phone === order.buyer_phone;
  const isVendor = (order.items || []).some((it) => it.vendorPhone === phone);
  if (!isBuyer && !isVendor) return res.status(403).json({ error: "Non autorisé sur cette commande." });
  const role = isBuyer ? "buyer" : "vendor";
  if (!order.transport_company) return res.status(400).json({ error: "Aucune proposition à confirmer pour l'instant." });
  if (order.transport_proposed_by === role) return res.status(400).json({ error: "Tu ne peux pas confirmer ta propre proposition — attends la réponse de l'autre partie." });
  if (role === "buyer" && (order.transport_fee === null || order.transport_fee === undefined)) {
    return res.status(400).json({ error: "Le vendeur n'a pas encore fixé les frais d'expédition." });
  }
  const field = role === "buyer" ? "transport_confirmed_by_buyer" : "transport_confirmed_by_vendor";
  await pool.query(`UPDATE orders SET ${field} = true WHERE id = $1`, [req.params.id]);
  const { rows: r2 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const updated = r2[0];
  // Accord des deux côtés : les frais négociés deviennent les frais de livraison officiels de la commande.
  if (updated.transport_confirmed_by_buyer && updated.transport_confirmed_by_vendor) {
    await pool.query("UPDATE orders SET delivery_fee = $1 WHERE id = $2", [Number(updated.transport_fee) || 0, req.params.id]);
  }
  const { rows: r3 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r3[0]));
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

// Point de repère par défaut du vendeur (quartier, repère) — réutilisé pour
// chaque nouveau produit publié, visible par les livreurs.
app.put("/api/vendors/:phone/landmark", requirePhone((req) => req.params.phone), async (req, res) => {
  await pool.query("UPDATE profiles SET landmark = $1 WHERE role = 'vendor' AND phone = $2", [req.body.landmark || "", req.params.phone]);
  res.json({ ok: true });
});

// Disponibilité du livreur : quand désactivée, il ne peut plus proposer de prix
// sur de nouvelles commandes (vérifié aussi côté serveur, pas juste à l'écran).
app.put("/api/couriers/:phone/availability", requirePhone((req) => req.params.phone), async (req, res) => {
  await pool.query("UPDATE profiles SET available = $1 WHERE role = 'courier' AND phone = $2", [!!req.body.available, req.params.phone]);
  res.json({ ok: true });
});

// Informations sur l'engin du livreur — vues par l'acheteur et le vendeur pour
// reconnaître qui vient enlever/livrer le colis.
app.put("/api/couriers/:phone/vehicle", requirePhone((req) => req.params.phone), async (req, res) => {
  await pool.query(
    "UPDATE profiles SET vehicle_type = $1, vehicle_plate = $2 WHERE role = 'courier' AND phone = $3",
    [req.body.vehicleType || "", req.body.vehiclePlate || "", req.params.phone]
  );
  res.json({ ok: true });
});

// Position en direct du livreur pendant une livraison en cours — partagée
// volontairement depuis son téléphone, uniquement sur SA propre commande active.
app.put("/api/orders/:id/location", requirePhone((req) => req.body.courierPhone), async (req, res) => {
  const { courierPhone, lat, lng } = req.body;
  const { rows } = await pool.query("SELECT courier_phone, status FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (rows[0].courier_phone !== courierPhone) return res.status(403).json({ error: "Ce n'est pas ta livraison." });
  if (rows[0].status !== "en_livraison") return res.status(400).json({ error: "Cette livraison n'est plus active." });
  await pool.query(
    "UPDATE orders SET courier_lat = $1, courier_lng = $2, location_updated_at = $3 WHERE id = $4",
    [lat, lng, Date.now(), req.params.id]
  );
  res.json({ ok: true });
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

// ==================== SÉCURITÉ / SIGNALEMENTS DE VENDEURS ====================
// L'acheteur signale un problème sur une de ses propres commandes (produit non
// conforme, jamais reçu, arnaque suspectée...). Le vendeur concerné est déduit
// des articles de la commande.
app.post("/api/reports", async (req, res) => {
  const tokenPhone = getTokenPhone(req);
  const { orderId, reason, details } = req.body;
  if (!tokenPhone) return res.status(401).json({ error: "Numéro non vérifié." });
  if (!orderId || !reason) return res.status(400).json({ error: "Commande et motif requis." });
  const { rows } = await pool.query("SELECT buyer_phone, items FROM orders WHERE id = $1", [orderId]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (rows[0].buyer_phone !== tokenPhone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  const vendorPhone = (rows[0].items || []).find((it) => it.vendorPhone)?.vendorPhone;
  if (!vendorPhone) return res.status(400).json({ error: "Impossible d'identifier le vendeur de cette commande." });
  const id = uid();
  await pool.query(
    "INSERT INTO vendor_reports (id, order_id, vendor_phone, buyer_phone, reason, details, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'open',$7)",
    [id, orderId, vendorPhone, tokenPhone, reason, details || "", Date.now()]
  );
  res.json({ ok: true });
});

// Liste des signalements — réservée au propriétaire.
app.get("/api/reports", requireOwner, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM vendor_reports ORDER BY created_at DESC");
  res.json(rows.map(mapReport));
});

app.post("/api/reports/:id/review", requireOwner, async (req, res) => {
  await pool.query("UPDATE vendor_reports SET status = 'reviewed' WHERE id = $1", [req.params.id]);
  logAdminAction("Signalement traité", req.params.id);
  res.json({ ok: true });
});

// Indicateurs de risque par vendeur (taux d'annulation, signalements...) —
// réservé au propriétaire, pour repérer les comptes à surveiller.
app.get("/api/vendors/risk", requireOwner, async (req, res) => {
  const { rows: orders } = await pool.query("SELECT items, status FROM orders");
  const { rows: reports } = await pool.query("SELECT vendor_phone, status FROM vendor_reports");
  const { rows: vendorProfiles } = await pool.query("SELECT * FROM profiles WHERE role = 'vendor'");

  const stats = {}; // phone -> { total, annulee, livree, name }
  for (const o of orders) {
    for (const it of (o.items || [])) {
      if (!it.vendorPhone) continue;
      stats[it.vendorPhone] = stats[it.vendorPhone] || { total: 0, annulee: 0, livree: 0 };
      stats[it.vendorPhone].total += 1;
      if (o.status === "annulee") stats[it.vendorPhone].annulee += 1;
      if (o.status === "livree") stats[it.vendorPhone].livree += 1;
      break; // ne compte la commande qu'une fois par vendeur, même avec plusieurs articles du même vendeur
    }
  }
  const openReportsByVendor = {};
  for (const r of reports) {
    if (r.status !== "open") continue;
    openReportsByVendor[r.vendor_phone] = (openReportsByVendor[r.vendor_phone] || 0) + 1;
  }

  const result = vendorProfiles.map((v) => {
    const s = stats[v.phone] || { total: 0, annulee: 0, livree: 0 };
    const cancelRate = s.total > 0 ? s.annulee / s.total : 0;
    const openReports = openReportsByVendor[v.phone] || 0;
    // Score de risque simple : signalements ouverts pèsent lourd, plus un taux
    // d'annulation élevé sur un volume suffisant pour être significatif.
    const risky = openReports > 0 || (s.total >= 5 && cancelRate > 0.4);
    return {
      phone: v.phone, name: v.name, suspended: v.suspended, suspendedReason: v.suspended_reason,
      totalOrders: s.total, cancelledOrders: s.annulee, deliveredOrders: s.livree,
      cancelRate: Math.round(cancelRate * 100), openReports, risky,
      trialStartedAt: v.trial_started_at ? Number(v.trial_started_at) : null,
      subscriptionStatus: v.subscription_status,
      subscriptionExpiresAt: v.subscription_expires_at ? Number(v.subscription_expires_at) : null,
    };
  }).sort((a, b) => (b.openReports - a.openReports) || (b.cancelRate - a.cancelRate));

  res.json(result);
});

app.post("/api/vendors/:phone/suspend", requireOwner, async (req, res) => {
  const { reason } = req.body;
  await pool.query(
    "UPDATE profiles SET suspended = true, suspended_reason = $1, suspended_at = $2 WHERE role = 'vendor' AND phone = $3",
    [reason || "", Date.now(), req.params.phone]
  );
  logAdminAction("Vendeur suspendu", req.params.phone, reason || "");
  res.json({ ok: true });
});

app.post("/api/vendors/:phone/unsuspend", requireOwner, async (req, res) => {
  await pool.query(
    "UPDATE profiles SET suspended = false, suspended_reason = NULL, suspended_at = NULL WHERE role = 'vendor' AND phone = $1",
    [req.params.phone]
  );
  logAdminAction("Suspension levée", req.params.phone);
  res.json({ ok: true });
});

// ==================== NOTES (réputation vendeur/livreur) ====================
// L'acheteur note le vendeur et/ou le livreur, uniquement sur une commande
// qu'il a lui-même passée et une fois qu'elle est livrée.
app.post("/api/ratings", async (req, res) => {
  const tokenPhone = getTokenPhone(req);
  const { orderId, rateePhone, rateeRole, stars, comment } = req.body;
  if (!tokenPhone) return res.status(401).json({ error: "Numéro non vérifié." });
  if (!orderId || !rateePhone || !rateeRole || !stars) return res.status(400).json({ error: "Informations manquantes." });
  const { rows } = await pool.query("SELECT buyer_phone, status FROM orders WHERE id = $1", [orderId]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (rows[0].buyer_phone !== tokenPhone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  if (rows[0].status !== "livree") return res.status(400).json({ error: "Tu ne peux noter qu'une commande livrée." });
  const id = uid();
  await pool.query(
    `INSERT INTO ratings (id, order_id, buyer_phone, ratee_phone, ratee_role, stars, comment, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (order_id, ratee_phone) DO UPDATE SET stars = $6, comment = $7`,
    [id, orderId, tokenPhone, rateePhone, rateeRole, Math.max(1, Math.min(5, Number(stars))), comment || "", Date.now()]
  );
  res.json({ ok: true });
});

// Moyenne + nombre de notes pour un vendeur ou un livreur — public (visible par
// les acheteurs avant de choisir), pas besoin d'être connecté.
app.get("/api/ratings/:phone", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count, COALESCE(AVG(stars), 0) AS avg FROM ratings WHERE ratee_phone = $1",
    [req.params.phone]
  );
  res.json({ count: rows[0].count, average: Math.round(Number(rows[0].avg) * 10) / 10 });
});

// ==================== VÉRIFICATION DES LIVREURS ====================
// Vérification manuelle (ex: pièce d'identité envoyée par WhatsApp) — le
// propriétaire coche "vérifié" une fois qu'il a contrôlé l'identité du livreur.
// N'empêche pas le livreur de travailler, mais affiche un badge de confiance
// aux acheteurs quand ils comparent les propositions de prix.
app.post("/api/couriers/:phone/verify", requireOwner, async (req, res) => {
  await pool.query("UPDATE profiles SET verified = true WHERE role = 'courier' AND phone = $1", [req.params.phone]);
  logAdminAction("Livreur vérifié", req.params.phone);
  res.json({ ok: true });
});
app.post("/api/couriers/:phone/unverify", requireOwner, async (req, res) => {
  await pool.query("UPDATE profiles SET verified = false WHERE role = 'courier' AND phone = $1", [req.params.phone]);
  logAdminAction("Vérification retirée", req.params.phone);
  res.json({ ok: true });
});
app.get("/api/couriers", requireOwner, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM profiles WHERE role = 'courier' ORDER BY trial_started_at DESC");
  res.json(rows.map(mapProfile));
});

// Le propriétaire peut accorder manuellement un accès gratuit (essai prolongé)
// à un vendeur ou un livreur précis — utile pour faire découvrir la plateforme
// sans attendre un vrai paiement (nouveaux partenaires, démonstration...).
app.post("/api/access/:role/:phone/grant", requireOwner, async (req, res) => {
  const { role, phone } = req.params;
  const days = Number(req.body.days) || 30;
  if (!["vendor", "courier"].includes(role)) return res.status(400).json({ error: "Rôle invalide." });
  const expiresAt = Date.now() + days * 24 * 3600 * 1000;
  const result = await pool.query(
    "UPDATE profiles SET subscription_status = 'active', subscription_expires_at = $1 WHERE role = $2 AND phone = $3",
    [expiresAt, role, phone]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Ce profil est introuvable — le numéro a peut-être changé." });
  logAdminAction("Accès gratuit accordé", `${role} · ${phone}`, `${days} jours`);
  res.json({ ok: true });
});

// ==================== REMBOURSEMENTS À TRAITER ====================
// CinetPay n'offre pas d'API de remboursement automatique : cette liste
// recense les commandes payées puis annulées, à rembourser manuellement
// depuis le back-office CinetPay. Une fois fait, le propriétaire la marque "traité".
// Journal des actions du propriétaire — les 100 plus récentes.
app.get("/api/admin-actions", requireOwner, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM admin_actions ORDER BY created_at DESC LIMIT 100");
  res.json(rows.map((r) => ({ id: r.id, action: r.action, target: r.target, details: r.details, createdAt: Number(r.created_at) })));
});

// Notes/tâches partagées — même code propriétaire, en vue de futurs collaborateurs.
app.get("/api/owner-notes", requireOwner, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM owner_notes ORDER BY done ASC, created_at DESC");
  res.json(rows.map((r) => ({ id: r.id, text: r.text, done: r.done, createdAt: Number(r.created_at) })));
});
app.post("/api/owner-notes", requireOwner, async (req, res) => {
  const text = (req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "La note ne peut pas être vide." });
  const id = uid();
  await pool.query("INSERT INTO owner_notes (id, text, done, created_at) VALUES ($1,$2,false,$3)", [id, text, Date.now()]);
  res.json({ id, text, done: false, createdAt: Date.now() });
});
app.patch("/api/owner-notes/:id", requireOwner, async (req, res) => {
  const sets = [];
  const vals = [];
  let i = 1;
  if (req.body.done !== undefined) { sets.push(`done = $${i++}`); vals.push(!!req.body.done); }
  if (req.body.text !== undefined) { sets.push(`text = $${i++}`); vals.push(req.body.text); }
  if (sets.length === 0) return res.status(400).json({ error: "Rien à mettre à jour." });
  vals.push(req.params.id);
  await pool.query(`UPDATE owner_notes SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  res.json({ ok: true });
});
app.delete("/api/owner-notes/:id", requireOwner, async (req, res) => {
  await pool.query("DELETE FROM owner_notes WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/refunds", requireOwner, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE refund_status != 'none' ORDER BY created_at DESC");
  res.json(rows.map(mapOrder));
});
app.post("/api/orders/:id/refund-done", requireOwner, async (req, res) => {
  await pool.query("UPDATE orders SET refund_status = 'done' WHERE id = $1", [req.params.id]);
  logAdminAction("Remboursement marqué fait", req.params.id);
  res.json({ ok: true });
});

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

// ==================== CONTENU DE LA PLATEFORME (propriétaire) ====================
// Textes affichés aux trois rôles, zones et catégories de produits — modifiables
// depuis l'espace propriétaire, sans jamais toucher au code ni redéployer.
function mapContent(r) {
  return {
    homeHeadline: r.home_headline,
    homeSubheadline: r.home_subheadline,
    roleDescBuyer: r.role_desc_buyer,
    roleDescVendor: r.role_desc_vendor,
    roleDescCourier: r.role_desc_courier,
    tipBuyer: r.tip_buyer,
    tipVendor: r.tip_vendor,
    tipCourier: r.tip_courier,
    zones: r.zones || [],
    categories: r.categories || [],
  };
}

app.get("/api/content", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM site_content WHERE id = 1");
  res.json(mapContent(rows[0]));
});

app.put("/api/content", requireOwner, async (req, res) => {
  const b = req.body;
  const colMap = {
    homeHeadline: "home_headline", homeSubheadline: "home_subheadline",
    roleDescBuyer: "role_desc_buyer", roleDescVendor: "role_desc_vendor", roleDescCourier: "role_desc_courier",
    tipBuyer: "tip_buyer", tipVendor: "tip_vendor", tipCourier: "tip_courier",
  };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const key of Object.keys(colMap)) {
    if (b[key] !== undefined) { sets.push(`${colMap[key]} = $${i++}`); vals.push(b[key] || null); }
  }
  if (b.zones !== undefined) { sets.push(`zones = $${i++}`); vals.push(JSON.stringify(b.zones)); }
  if (b.categories !== undefined) { sets.push(`categories = $${i++}`); vals.push(JSON.stringify(b.categories)); }
  if (sets.length) await pool.query(`UPDATE site_content SET ${sets.join(", ")} WHERE id = 1`, vals);
  const { rows } = await pool.query("SELECT * FROM site_content WHERE id = 1");
  res.json(mapContent(rows[0]));
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
app.post("/api/owner/login", async (req, res) => {
  const { code } = req.body;
  if (!OWNER_PASSCODE) return res.status(500).json({ error: "OWNER_PASSCODE non configuré sur le serveur." });
  if (code !== OWNER_PASSCODE) return res.status(401).json({ error: "Code incorrect." });
  res.json({ token: await issueOwnerToken() });
});

// ==================== Frontend statique ====================
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Zonako backend en écoute sur le port ${PORT}`));
ensureSchema();
