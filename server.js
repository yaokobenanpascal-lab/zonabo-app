// Zonako — serveur backend (Express + PostgreSQL)
// Sert l'API (/api/...) ET le fichier de l'appli (public/index.html) depuis le même
// serveur, pour éviter tout problème de CORS et n'avoir qu'un seul déploiement.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
// Nécessaire derrière le proxy de Render pour que req.ip renvoie la vraie
// adresse du visiteur (pas celle du proxy) — utilisé pour le blocage anti
// force-brute sur la connexion propriétaire.
app.set("trust proxy", true);
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // CinetPay envoie sa notification en POST classique (formulaire), pas en JSON

// En-têtes de sécurité de base — protège contre le détournement de clics
// (clickjacking), le reniflage de type MIME, et limite les infos envoyées
// aux autres sites via le referrer.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

// Filet de sécurité global : une erreur non rattrapée dans une route ne doit
// jamais faire planter tout le serveur (donc couper le site pour tout le
// monde) — juste être journalisée. Node arrête le processus par défaut sur
// une "unhandled rejection" depuis la version 15 ; on désactive ça ici.
process.on("unhandledRejection", (err) => {
  console.error("Erreur non rattrapée (le serveur continue de tourner) :", err);
});

const PORT = process.env.PORT || 3000;
// Fenêtre de réflexion gratuite pour l'acheteur après avoir passé une
// commande — le vendeur ne peut pas la confirmer avant, pour ne jamais
// s'engager sur une commande que l'acheteur pourrait encore changer d'avis.
const ORDER_GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes
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

// Aide à la rédaction de descriptions de produits (IA) — via l'API Anthropic.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
if (!ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY non définie — l'aide à la rédaction IA sera indisponible tant que ce n'est pas réglé.");
}

// Photo "mannequin" générée par IA (image fixe, pas de vidéo) — via l'API Runway.
const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY || "";
if (!RUNWAY_API_KEY) {
  console.warn("⚠️  RUNWAY_API_KEY non définie — la génération de photo mannequin sera indisponible tant que ce n'est pas réglé.");
}
// Les images générées par Runway ne sont hébergées que temporairement sur
// leurs serveurs (quelques jours) — on les re-télécharge immédiatement vers
// Cloudinary (notre hébergement permanent, déjà utilisé pour les photos
// classiques) pour qu'elles ne disparaissent jamais.
async function reuploadToCloudinary(sourceUrl) {
  const imgResp = await fetch(sourceUrl);
  if (!imgResp.ok) throw new Error("Impossible de récupérer l'image générée.");
  const buffer = await imgResp.arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([buffer]), "generated.png");
  form.append("upload_preset", "zonako_uploads");
  const uploadResp = await fetch("https://api.cloudinary.com/v1_1/kylr0amb/image/upload", { method: "POST", body: form });
  if (!uploadResp.ok) {
    const detail = await uploadResp.text().catch(() => "");
    throw new Error(`Cloudinary a répondu ${uploadResp.status} : ${detail}`);
  }
  const data = await uploadResp.json();
  return data.secure_url;
}

async function sendEmail(to, subject, textContent, htmlContent) {
  if (!EMAIL_CONFIGURED) {
    console.log(`[MODE TEST — pas de Brevo configuré] Email à ${to} — "${subject}" : ${textContent}`);
    return;
  }
  const body = {
    sender: { email: BREVO_FROM_EMAIL, name: "Zonako" },
    to: [{ email: to }],
    subject,
    textContent,
  };
  if (htmlContent) body.htmlContent = htmlContent;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Brevo a répondu ${r.status} : ${detail}`);
  }
}
// Petit gabarit HTML commun, avec la photo du produit bien en avant — pour
// les relances comportementales (vu-pas-acheté, baisse de prix, nouveauté).
function productEmailHtml({ heading, bodyHtml, imageUrl, ctaText }) {
  return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#14213D;">
    <h2 style="color:#14213D;">${heading}</h2>
    ${imageUrl ? `<img src="${imageUrl}" alt="" style="width:100%;max-width:480px;border-radius:12px;object-fit:cover;margin:12px 0;" />` : ""}
    <p style="font-size:15px;line-height:1.5;">${bodyHtml}</p>
    <a href="https://zonabo-app.onrender.com" style="display:inline-block;background:#C1440E;color:#fff;text-decoration:none;padding:10px 18px;border-radius:24px;font-size:13px;margin-top:8px;">${ctaText || "Voir sur Zonako"}</a>
  </div>`;
}
async function sendEmailCode(email, code) {
  await sendEmail(email, "Ton code de vérification Zonako", `Ton code de vérification Zonako est : ${code}\n\nIl est valable 10 minutes.`);
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

// ==================== PARRAINAGE (AGENTS DE RECRUTEMENT) ====================
// Enregistre qu'une nouvelle personne s'est inscrite via le code d'un agent —
// pas encore payé à ce stade (activated=false), seulement une fois que la
// personne devient réellement active (voir activateReferral ci-dessous).
async function recordReferralSignup(code, newUserPhone, role) {
  if (!code || !code.trim()) return;
  try {
    const { rows } = await pool.query("SELECT phone FROM referral_agents WHERE code = $1 AND active = true", [code.trim().toUpperCase()]);
    if (!rows[0]) return; // code invalide ou agent désactivé — on ignore silencieusement
    await pool.query(
      "INSERT INTO referral_signups (id, agent_phone, new_user_phone, role, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (new_user_phone, role) DO NOTHING",
      [uid(), rows[0].phone, newUserPhone, role, Date.now()]
    );
  } catch (e) {
    console.error("Erreur pendant l'enregistrement du parrainage:", e);
  }
}
// Marque l'inscription comme "activée" (donc payable à l'agent) — appelé au
// premier vrai signe d'activité réelle de la personne recrutée.
async function activateReferral(newUserPhone, role) {
  try {
    await pool.query(
      "UPDATE referral_signups SET activated = true, activated_at = $1 WHERE new_user_phone = $2 AND role = $3 AND activated = false",
      [Date.now(), newUserPhone, role]
    );
  } catch (e) {
    console.error("Erreur pendant l'activation du parrainage:", e);
  }
}

// Mot de passe (facultatif) pour acheteur/vendeur/livreur — haché avec le
// module crypto natif de Node (scrypt + sel aléatoire), pas besoin d'une
// dépendance supplémentaire comme bcrypt.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  // Comparaison à temps constant pour éviter les attaques par mesure de délai.
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

// ==================== SÉCURITÉ : détection + anti force-brute ====================
async function logSecurityEvent(type, detail, ip) {
  try {
    await pool.query(
      "INSERT INTO security_events (id, type, detail, ip, created_at) VALUES ($1,$2,$3,$4,$5)",
      [uid(), type, detail || null, ip || null, Date.now()]
    );
  } catch (e) {
    console.error("Erreur d'écriture du journal de sécurité (non bloquant):", e.message);
  }
}
// Fabrique un limiteur anti force-brute réutilisable : après maxAttempts
// échecs pour une même clé (IP, numéro...), blocage temporaire.
function makeRateLimiter(maxAttempts, blockMs) {
  const attempts = new Map(); // clé -> { count, blockedUntil }
  return {
    isBlocked(key) {
      const a = attempts.get(key);
      if (a && a.blockedUntil && Date.now() < a.blockedUntil) {
        return Math.ceil((a.blockedUntil - Date.now()) / 60000);
      }
      return 0;
    },
    recordFailure(key) {
      const a = attempts.get(key);
      const count = (a?.count || 0) + 1;
      attempts.set(key, { count, blockedUntil: count >= maxAttempts ? Date.now() + blockMs : null });
      return count >= maxAttempts;
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}
const passwordLoginLimiter = makeRateLimiter(5, 15 * 60 * 1000);

// --- Auth par téléphone (OTP SMS) : un jeton prouve "j'ai reçu le code envoyé à ce numéro" ---
// Stocké en base de données (pas en mémoire) : sans ça, tout le monde serait
// déconnecté à chaque redémarrage du serveur (chaque déploiement, veille du
// plan gratuit...), avec un message confus "numéro non vérifié".
async function issuePhoneToken(phone) {
  const token = crypto.randomBytes(24).toString("hex");
  await pool.query("INSERT INTO phone_tokens (token, phone, expires_at) VALUES ($1,$2,$3)", [token, phone, Date.now() + 30 * 24 * 3600 * 1000]); // 30 jours
  return token;
}
async function getTokenPhone(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const { rows } = await pool.query("SELECT phone, expires_at FROM phone_tokens WHERE token = $1", [token]);
    if (!rows[0] || Number(rows[0].expires_at) < Date.now()) return null;
    return rows[0].phone;
  } catch (e) {
    console.error("Erreur de vérification du jeton téléphone:", e);
    return null;
  }
}
// Résout plusieurs jetons téléphone à la fois (un appareil peut avoir été
// utilisé pour plusieurs rôles — acheteur, vendeur, livreur — chacun avec son
// propre jeton) — utilisé pour ne renvoyer QUE les commandes concernant les
// numéros réellement vérifiés sur cet appareil, jamais toutes les commandes.
async function resolveTokensToPhones(tokensParam) {
  if (!tokensParam) return [];
  const tokens = [...new Set(tokensParam.split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 10);
  if (tokens.length === 0) return [];
  try {
    const { rows } = await pool.query(
      "SELECT DISTINCT phone FROM phone_tokens WHERE token = ANY($1) AND expires_at > $2",
      [tokens, Date.now()]
    );
    return rows.map((r) => r.phone);
  } catch (e) {
    console.error("Erreur de résolution des jetons téléphone:", e);
    return [];
  }
}
async function isValidOwnerToken(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return false;
  try {
    const { rows } = await pool.query("SELECT expires_at FROM owner_tokens WHERE token = $1", [token]);
    return !!(rows[0] && Number(rows[0].expires_at) >= Date.now());
  } catch (e) {
    console.error("Erreur de vérification du jeton propriétaire:", e);
    return false;
  }
}
// À utiliser sur toute route où quelqu'un agit "en tant que" tel numéro de téléphone
// (créer une commande, proposer un prix, confirmer une réception...). Compare le
// téléphone du jeton envoyé à celui que la requête prétend utiliser.
function requirePhone(expectedPhoneOf) {
  return async (req, res, next) => {
    const tokenPhone = await getTokenPhone(req);
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
    videoUrl: r.video_url || "",
    videoUrls: r.video_urls && r.video_urls.length ? r.video_urls : (r.video_url ? [r.video_url] : []),
    tagline: r.tagline || "",
    aiPhotoUrls: r.ai_photo_urls || [],
    negotiable: r.negotiable || false,
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
    courierFeePaymentMethod: r.courier_fee_payment_method || "cash", courierFeePaid: r.courier_fee_paid || false, courierPaymentConfirmed: r.courier_payment_confirmed || false,
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
    transportSettledAt: r.transport_settled_at ? Number(r.transport_settled_at) : null,
    inTransitAt: r.in_transit_at ? Number(r.in_transit_at) : null,
    autoConfirmed: r.auto_confirmed || false,
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
    walletBalance: r.wallet_balance !== null && r.wallet_balance !== undefined ? Number(r.wallet_balance) : 0,
  };
}
function mapReport(r) {
  return {
    id: r.id, orderId: r.order_id, vendorPhone: r.vendor_phone, buyerPhone: r.buyer_phone,
    reason: r.reason, details: r.details, status: r.status, createdAt: Number(r.created_at),
  };
}
function mapNegotiation(r) {
  const isValid = r.status === "accepted" && r.expires_at && Number(r.expires_at) > Date.now();
  return {
    id: r.id, productId: r.product_id, buyerPhone: r.buyer_phone, vendorPhone: r.vendor_phone,
    originalPrice: Number(r.original_price), proposedPrice: Number(r.proposed_price), proposedBy: r.proposed_by,
    status: isValid ? "accepted" : (r.status === "accepted" ? "expired" : r.status),
    acceptedPrice: r.accepted_price !== null ? Number(r.accepted_price) : null,
    acceptedAt: r.accepted_at ? Number(r.accepted_at) : null,
    expiresAt: r.expires_at ? Number(r.expires_at) : null,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
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
    res.json({ token: await issuePhoneToken(phone) });
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

// Aide à la rédaction : le vendeur donne juste le nom + quelques mots-clés,
// l'IA rédige une description attirante. Le vendeur reste libre de la
// modifier ou de l'ignorer avant de publier.
// ==================== NÉGOCIATION DE PRIX ====================
// L'acheteur propose un prix, le vendeur accepte/refuse/contre-propose — un
// peu comme discuter le prix en personne chez un vendeur. Une fois accepté,
// le prix négocié n'est valable que 24h.
const NEGOTIATION_VALID_MS = 24 * 60 * 60 * 1000;

app.post("/api/negotiations", requirePhone((req) => req.body.buyerPhone), async (req, res) => {
  const { productId, buyerPhone, proposedPrice, message } = req.body;
  if (!productId || !proposedPrice || Number(proposedPrice) <= 0) return res.status(400).json({ error: "Indique un prix valide." });
  const { rows: prodRows } = await pool.query("SELECT price, vendor_phone, negotiable, name FROM products WHERE id = $1", [productId]);
  const product = prodRows[0];
  if (!product) return res.status(404).json({ error: "Produit introuvable." });
  if (!product.negotiable) return res.status(400).json({ error: "Ce produit n'est pas négociable." });
  if (Number(proposedPrice) >= Number(product.price)) return res.status(400).json({ error: "Propose un prix inférieur au prix affiché." });
  const now = Date.now();
  await pool.query(
    `INSERT INTO price_negotiations (id, product_id, buyer_phone, vendor_phone, original_price, proposed_price, proposed_by, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'buyer','open',$7,$7)
     ON CONFLICT (product_id, buyer_phone) DO UPDATE SET
       proposed_price = $6, proposed_by = 'buyer', status = 'open', updated_at = $7,
       accepted_price = NULL, accepted_at = NULL, expires_at = NULL`,
    [uid(), productId, buyerPhone, product.vendor_phone, product.price, proposedPrice, now]
  );
  logAdminAction("Négociation de prix ouverte", product.vendor_phone, `${product.name} — proposé ${proposedPrice} F`);
  const { rows } = await pool.query("SELECT * FROM price_negotiations WHERE product_id = $1 AND buyer_phone = $2", [productId, buyerPhone]);
  res.json(mapNegotiation(rows[0]));
});

app.post("/api/negotiations/:id/respond", requirePhone((req) => req.body.phone), async (req, res) => {
  const { phone, action, counterPrice, role } = req.body;
  if (!["buyer", "vendor"].includes(role)) return res.status(400).json({ error: "Rôle invalide." });
  const { rows } = await pool.query("SELECT * FROM price_negotiations WHERE id = $1", [req.params.id]);
  const neg = rows[0];
  if (!neg) return res.status(404).json({ error: "Négociation introuvable." });
  // On se base sur le rôle explicitement déclaré (pas seulement sur le
  // numéro de téléphone) — sinon, si un même numéro sert de test à la fois
  // pour acheteur et vendeur, impossible de savoir qui répond vraiment.
  const isBuyer = role === "buyer";
  const isVendor = role === "vendor";
  if (isBuyer && phone !== neg.buyer_phone) return res.status(403).json({ error: "Cette négociation ne te concerne pas." });
  if (isVendor && phone !== neg.vendor_phone) return res.status(403).json({ error: "Cette négociation ne te concerne pas." });
  if (neg.status !== "open") return res.status(400).json({ error: "Cette négociation n'est plus ouverte." });
  // On ne peut pas répondre à sa propre dernière proposition — il faut attendre l'autre partie.
  if (neg.proposed_by === role) return res.status(400).json({ error: "En attente de la réponse de l'autre partie." });
  const now = Date.now();
  if (action === "accept") {
    const expiresAt = now + NEGOTIATION_VALID_MS;
    await pool.query(
      "UPDATE price_negotiations SET status = 'accepted', accepted_price = proposed_price, accepted_at = $1, expires_at = $2, updated_at = $1 WHERE id = $3",
      [now, expiresAt, req.params.id]
    );
  } else if (action === "reject") {
    await pool.query("UPDATE price_negotiations SET status = 'rejected', updated_at = $1 WHERE id = $2", [now, req.params.id]);
  } else if (action === "counter") {
    if (!counterPrice || Number(counterPrice) <= 0) return res.status(400).json({ error: "Indique un prix valide." });
    if (isVendor && Number(counterPrice) >= Number(neg.original_price)) return res.status(400).json({ error: "La contre-proposition doit rester sous le prix affiché." });
    await pool.query(
      "UPDATE price_negotiations SET proposed_price = $1, proposed_by = $2, updated_at = $3 WHERE id = $4",
      [counterPrice, isBuyer ? "buyer" : "vendor", now, req.params.id]
    );
  } else {
    return res.status(400).json({ error: "Action invalide." });
  }
  const { rows: r2 } = await pool.query("SELECT * FROM price_negotiations WHERE id = $1", [req.params.id]);
  res.json(mapNegotiation(r2[0]));
});

app.get("/api/negotiations/buyer/:phone", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.*, p.name AS product_name, p.image_url AS product_image
     FROM price_negotiations n JOIN products p ON p.id = n.product_id
     WHERE n.buyer_phone = $1 ORDER BY n.updated_at DESC`,
    [req.params.phone]
  );
  res.json(rows.map((r) => ({ ...mapNegotiation(r), productName: r.product_name, productImage: r.product_image })));
});
app.get("/api/negotiations/vendor/:phone", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.*, p.name AS product_name, p.image_url AS product_image
     FROM price_negotiations n JOIN products p ON p.id = n.product_id
     WHERE n.vendor_phone = $1 ORDER BY n.updated_at DESC`,
    [req.params.phone]
  );
  res.json(rows.map((r) => ({ ...mapNegotiation(r), productName: r.product_name, productImage: r.product_image })));
});

app.post("/api/products/generate-description", requirePhone((req) => req.body.vendorPhone), async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "L'aide à la rédaction IA n'est pas encore configurée sur le serveur." });
  const { name, category, keywords } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom du produit est requis." });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        messages: [{
          role: "user",
          content: `Pour un marché en ligne local en Côte d'Ivoire, rédige deux choses pour ce produit, en français, honnêtes et sans exagération. Réponds STRICTEMENT en JSON, rien d'autre, format exact : {"description": "...", "tagline": "..."}\n- description : 2-3 phrases (40-60 mots), attirante, prête à publier, pas de markdown.\n- tagline : accroche publicitaire très courte (4 à 7 mots max), percutante, pour une bannière animée.\n\nProduit : ${name}\nCatégorie : ${category || "non précisée"}\nMots-clés du vendeur : ${keywords || "aucun"}`,
        }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`Anthropic a répondu ${r.status} : ${detail}`);
    }
    const data = await r.json();
    const raw = (data.content || []).map((b) => b.text || "").join("").trim();
    let description = raw, tagline = "";
    try {
      const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, "").trim());
      description = parsed.description || raw;
      tagline = parsed.tagline || "";
    } catch {
      // si l'IA n'a pas renvoyé du JSON propre, on garde juste le texte comme description
    }
    res.json({ description, tagline });
  } catch (e) {
    console.error("Erreur pendant la génération de description IA:", e);
    res.status(500).json({ error: "Impossible de générer une description pour l'instant." });
  }
});

// Photo "mannequin" générée par IA à partir d'une photo de l'article (via
// Runway) — image fixe uniquement, pas de vidéo (bien moins coûteux).
// NOTE : intégration basée sur notre meilleure compréhension de l'API Runway
// au moment de l'écriture — à tester et ajuster ensemble avec une vraie clé,
// contrairement aux autres intégrations (Cloudinary, Anthropic) déjà vérifiées.
app.post("/api/products/generate-mannequin-photo", requirePhone((req) => req.body.vendorPhone), async (req, res) => {
  if (!RUNWAY_API_KEY) return res.status(500).json({ error: "La génération de photo mannequin n'est pas encore configurée sur le serveur." });
  const { imageUrl, displayType, pose } = req.body;
  if (!imageUrl) return res.status(400).json({ error: "Choisis d'abord une photo de l'article." });
  try {
    // Chaque type de produit demande une mise en scène différente — un
    // mannequin torse ne convient qu'aux vêtements, pas à une montre ou des
    // bijoux, qui ont besoin de leur propre présentation.
    const STUDIO_BASE = "shot in a minimal e-commerce studio setting, pure white seamless background, soft diffused front lighting with subtle fill from both sides, no shadows, clean product photography aesthetic, no extra props. CRITICAL: this must be the EXACT same item(s) as in the reference photo — do not alter, reinterpret, or invent colors, shapes, patterns, prints, textures or materials in any way. Only change the setting/framing/presentation around it, never the item itself.";
    const POSES = {
      "Face": "standing straight, facing the camera directly",
      "Trois-quarts": "standing at a slight three-quarter angle toward the camera",
      "Profil": "standing in full side profile",
      "Dos": "standing with back turned toward the camera, showing the back of the outfit",
    };
    const poseText = POSES[pose] || POSES["Trois-quarts"];
    // Vêtement femme/homme : mannequin en pied (tête aux pieds), pas juste un
    // buste — pour représenter la tenue complète (y compris un couvre-chef,
    // foulard ou voile s'il fait partie de l'article/ensemble sur la photo).
    const FULL_BODY_CLOTHING = (gender) =>
      `A white plastic full-body ${gender}-presenting display mannequin (head to toe, including a head form) wearing the complete outfit exactly as shown in the reference photo — including any headwear, veil, headscarf or hat if part of the item(s) shown, ${poseText}, ${STUDIO_BASE}`;
    const FORMAL_SUIT =
      `A white plastic full-body male-presenting display mannequin (head to toe, including a head form) wearing this exact complete formal suit exactly as shown in the reference photo (jacket, trousers, and any vest, tie or accessories included), premium tailored menswear presentation, sharp confident posture, ${poseText}, elegant upscale boutique studio lighting with a subtle soft gradient backdrop instead of flat white, refined and polished product photography aesthetic. CRITICAL: this must be the EXACT same suit as in the reference photo — do not alter, reinterpret, or invent its color, cut, pattern, texture or material in any way. Only change the setting/framing/presentation around it, never the item itself.`;
    const PROMPTS = {
      "Vêtement femme": FULL_BODY_CLOTHING("female"),
      "Vêtement homme": FULL_BODY_CLOTHING("male"),
      "Costume / Tenue formelle": FORMAL_SUIT,
      "Vêtement bébé / enfant": `This exact baby or children's garment displayed neatly on a small soft-padded infant display form or flat-laid with gentle folds, warm and clean nursery-style presentation, ${STUDIO_BASE}`,
      "Chaussures": `A pair of this exact shoes displayed on a minimal clear acrylic shoe stand, front three-quarter angle, floating slightly above a neutral ground plane, ${STUDIO_BASE}`,
      "Montre": `A close-up of this exact watch worn on a neutral light-toned wrist, arm resting naturally at a slight angle, focus sharp on the watch face and strap, ${STUDIO_BASE}`,
      "Bijoux": `This exact jewelry piece elegantly presented on a minimal white jewelry display stand (bust, ring cone, or earring card as appropriate to the item type), ${STUDIO_BASE}`,
      "Sac / Accessoire": `This exact bag or accessory placed upright on a minimal round pedestal, front three-quarter angle, ${STUDIO_BASE}`,
      "Électronique / Téléphone": `This exact electronic device or phone displayed upright on a minimal tech-style pedestal stand, screen angled slightly toward camera if applicable, ${STUDIO_BASE}`,
      "Maison / Déco": `This exact home or decor item staged naturally within a tastefully minimal, softly lit interior setting (neutral shelf, table or console), giving a sense of scale and real use, ${STUDIO_BASE.replace("pure white seamless background, ", "")}`,
      "Cuisine / Ustensiles": `This exact kitchen item staged neatly on a clean light-toned countertop, slight overhead-angled product shot, ${STUDIO_BASE}`,
      "Beauté / Cosmétique": `This exact beauty or cosmetic product displayed upright on a minimal elegant vanity-style pedestal, ${STUDIO_BASE}`,
      "Jouet / Enfant": `This exact toy or children's item displayed upright on a clean minimal surface, playful but tidy product photography style, ${STUDIO_BASE}`,
      "Véhicule / Engin": `This exact vehicle or machine (car, motorcycle, bicycle, or similar) displayed in a professional automotive showroom setting, clean reflective floor, dramatic professional dealership-style lighting, three-quarter angle that highlights its shape and condition, no people, no mannequin. CRITICAL: this must be the EXACT same vehicle as in the reference photo — do not alter, reinterpret, or invent its color, model, shape, condition or details in any way. Only change the setting/lighting/framing around it, never the vehicle itself.`,
    };
    const promptText = PROMPTS[displayType] || PROMPTS["Vêtement femme"];
    const createResp = await fetch("https://api.dev.runwayml.com/v1/text_to_image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RUNWAY_API_KEY}`,
        "X-Runway-Version": "2024-11-06",
      },
      body: JSON.stringify({
        model: "gen4_image",
        promptText,
        referenceImages: [{ uri: imageUrl }],
        ratio: "1024:1024",
      }),
    });
    if (!createResp.ok) {
      const detail = await createResp.text().catch(() => "");
      throw new Error(`Runway (création) a répondu ${createResp.status} : ${detail}`);
    }
    const created = await createResp.json();
    const taskId = created.id;
    if (!taskId) throw new Error("Runway n'a pas renvoyé d'identifiant de tâche.");

    // Le rendu n'est pas instantané — on interroge Runway toutes les 3
    // secondes, jusqu'à 60 secondes max, jusqu'à ce que l'image soit prête.
    let output = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResp = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
        headers: { "Authorization": `Bearer ${RUNWAY_API_KEY}`, "X-Runway-Version": "2024-11-06" },
      });
      if (!pollResp.ok) continue;
      const poll = await pollResp.json();
      if (poll.status === "SUCCEEDED") { output = poll.output?.[0] || null; break; }
      if (poll.status === "FAILED") throw new Error(poll.failure || "La génération Runway a échoué.");
    }
    if (!output) throw new Error("La génération prend plus de temps que prévu — réessaie dans un instant.");
    const permanentUrl = await reuploadToCloudinary(output);
    res.json({ imageUrl: permanentUrl });
  } catch (e) {
    console.error("Erreur pendant la génération de photo mannequin (Runway):", e);
    res.status(500).json({ error: e.message || "Impossible de générer la photo mannequin pour l'instant." });
  }
});

// Change uniquement le décor derrière l'article (jamais l'article lui-même)
// — plus sûr que la photo mannequin puisque ça ne touche pas au produit,
// juste ce qu'il y a autour. Utile pour une photo prise sur un lit, un sol
// ou un fond encombré, à rendre professionnelle sans rien changer à l'article.
app.post("/api/products/change-background", requirePhone((req) => req.body.vendorPhone), async (req, res) => {
  if (!RUNWAY_API_KEY) return res.status(500).json({ error: "Le changement de fond n'est pas encore configuré sur le serveur." });
  const { imageUrl, backgroundStyle } = req.body;
  if (!imageUrl) return res.status(400).json({ error: "Choisis d'abord une photo de l'article." });
  try {
    const FIDELITY = "CRITICAL: keep the exact same product completely unchanged — same angle, same proportions, same colors, same shadows falling on the product itself, same reflections on it. Do not alter, reinterpret, or invent anything about the product. Only replace what is BEHIND and AROUND it — the backdrop, floor and surrounding environment — never the product itself.";
    const BACKGROUNDS = {
      "Studio blanc épuré": `Completely remove and erase everything from the original photo except the product itself — the floor, bed, table, walls, furniture, shadows, reflections and any other surrounding object or clutter must be entirely gone, with zero trace or blending of the original background left behind. Replace all of it with a pure, seamless, uniform white studio backdrop (RGB 255,255,255), soft even professional front lighting, a clean subtle contact shadow directly under the product only, minimal e-commerce product photography look, sharp clean edges around the product with no leftover fragments of the old scene. ${FIDELITY}`,
      "Extérieur naturel": `Replace the background behind this exact product with a softly blurred natural outdoor setting (warm daylight, greenery or open sky, shallow depth of field), lifestyle product photography look. ${FIDELITY}`,
      "Intérieur chaleureux": `Replace the background behind this exact product with a softly blurred warm home interior setting (wooden surface, soft natural window light), cozy lifestyle product photography look. ${FIDELITY}`,
      "Dégradé de couleur": `Replace the background behind this exact product with a smooth elegant navy-to-gold gradient studio backdrop, soft professional lighting, premium e-commerce product photography look. ${FIDELITY}`,
    };
    const promptText = BACKGROUNDS[backgroundStyle] || BACKGROUNDS["Studio blanc épuré"];
    const createResp = await fetch("https://api.dev.runwayml.com/v1/text_to_image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RUNWAY_API_KEY}`,
        "X-Runway-Version": "2024-11-06",
      },
      body: JSON.stringify({
        model: "gen4_image",
        promptText,
        referenceImages: [{ uri: imageUrl }],
        ratio: "1024:1024",
      }),
    });
    if (!createResp.ok) {
      const detail = await createResp.text().catch(() => "");
      throw new Error(`Runway (création) a répondu ${createResp.status} : ${detail}`);
    }
    const created = await createResp.json();
    const taskId = created.id;
    if (!taskId) throw new Error("Runway n'a pas renvoyé d'identifiant de tâche.");
    let output = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResp = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
        headers: { "Authorization": `Bearer ${RUNWAY_API_KEY}`, "X-Runway-Version": "2024-11-06" },
      });
      if (!pollResp.ok) continue;
      const poll = await pollResp.json();
      if (poll.status === "SUCCEEDED") { output = poll.output?.[0] || null; break; }
      if (poll.status === "FAILED") throw new Error(poll.failure || "La génération Runway a échoué.");
    }
    if (!output) throw new Error("La génération prend plus de temps que prévu — réessaie dans un instant.");
    const permanentUrl = await reuploadToCloudinary(output);
    res.json({ imageUrl: permanentUrl });
  } catch (e) {
    console.error("Erreur pendant le changement de fond (Runway):", e);
    res.status(500).json({ error: e.message || "Impossible de changer le fond pour l'instant." });
  }
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
  const aiPhotoUrls = Array.isArray(p.aiPhotoUrls) ? p.aiPhotoUrls : [];
  const realPhotosLeft = imageUrls.filter((url) => !aiPhotoUrls.includes(url));
  if (imageUrls.length > 0 && realPhotosLeft.length === 0) {
    return res.status(400).json({ error: "Il doit rester au moins une vraie photo de l'article (pas seulement des photos générées par IA)." });
  }
  const coverImage = imageUrls[0] || p.imageUrl || "";
  // Jusqu'à 5 vidéos par produit (même principe que les photos).
  const videoUrls = Array.isArray(p.videoUrls) ? p.videoUrls.slice(0, 5) : (p.videoUrl ? [p.videoUrl] : []);
  const coverVideo = videoUrls[0] || p.videoUrl || "";
  await pool.query(
    `INSERT INTO products (id, name, price, category, zone, stock, image_url, delivery_time, vendor_name, vendor_phone, created_at, description, vendor_landmark, image_urls, video_url, video_urls, tagline, ai_photo_urls, negotiable)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [id, p.name, p.price, p.category, p.zone, p.stock || 0, coverImage, p.deliveryTime || "Non précisé", p.vendorName, p.vendorPhone, createdAt, p.description || "", landmark, JSON.stringify(imageUrls), coverVideo, JSON.stringify(videoUrls), p.tagline || "", JSON.stringify(Array.isArray(p.aiPhotoUrls) ? p.aiPhotoUrls : []), !!p.negotiable]
  );
  // Annonce automatique aux acheteurs — pas besoin que le propriétaire soit
  // connecté pour que les nouveautés se fassent connaître. Premier produit
  // du vendeur = "nouveau vendeur" ; sinon = "nouveau produit" tout court.
  try {
    const { rows: countRows } = await pool.query("SELECT COUNT(*)::int AS n FROM products WHERE vendor_phone = $1", [p.vendorPhone]);
    const isFirstProduct = countRows[0].n <= 1;
    if (isFirstProduct) activateReferral(p.vendorPhone, "vendor");
    const message = isFirstProduct
      ? `🎉 ${p.vendorName} vient de rejoindre Zonako ! Découvre "${p.name}".`
      : `🆕 Nouveau chez ${p.vendorName} : "${p.name}".`;
    await pool.query(
      "UPDATE site_content SET announcement_message = $1, announcement_product_id = $2, announcement_created_at = $3, announcement_video_url = NULL WHERE id = 1",
      [message, id, Date.now()]
    );
  } catch (e) {
    console.error("Erreur pendant la génération de l'annonce automatique:", e);
  }
  // Notifie par email les acheteurs qui suivent cette catégorie — ne bloque
  // pas la réponse (peut concerner plusieurs personnes à la fois).
  notifyCategoryFollowers(p.category, id, p.name, p.vendorName, coverImage);
  const { rows } = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
  res.json(mapProduct(rows[0]));
});

app.patch("/api/products/:id", async (req, res) => {
  const tokenPhone = await getTokenPhone(req);
  const { rows: existing } = await pool.query("SELECT vendor_phone, ai_photo_urls FROM products WHERE id = $1", [req.params.id]);
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
  if (patch.tagline !== undefined) { sets.push(`tagline = $${i++}`); vals.push(patch.tagline); }
  if (patch.negotiable !== undefined) { sets.push(`negotiable = $${i++}`); vals.push(!!patch.negotiable); }
  if (patch.vendorLandmark !== undefined) { sets.push(`vendor_landmark = $${i++}`); vals.push(patch.vendorLandmark); }
  if (Array.isArray(patch.videoUrls)) {
    const videoUrls = patch.videoUrls.slice(0, 5);
    sets.push(`video_urls = $${i++}`); vals.push(JSON.stringify(videoUrls));
    sets.push(`video_url = $${i++}`); vals.push(videoUrls[0] || "");
  } else if (patch.videoUrl !== undefined) {
    sets.push(`video_url = $${i++}`); vals.push(patch.videoUrl);
  }
  if (Array.isArray(patch.imageUrls)) {
    const imageUrls = patch.imageUrls.slice(0, 5);
    const aiPhotoUrls = Array.isArray(patch.aiPhotoUrls) ? patch.aiPhotoUrls : (existing[0].ai_photo_urls || []);
    // Au moins une vraie photo (non générée par IA) doit toujours rester —
    // sinon l'acheteur ne voit jamais l'article réel, seulement une version stylisée.
    const realPhotosLeft = imageUrls.filter((url) => !aiPhotoUrls.includes(url));
    if (imageUrls.length > 0 && realPhotosLeft.length === 0) {
      return res.status(400).json({ error: "Il doit rester au moins une vraie photo de l'article (pas seulement des photos générées par IA)." });
    }
    sets.push(`image_urls = $${i++}`); vals.push(JSON.stringify(imageUrls));
    sets.push(`image_url = $${i++}`); vals.push(imageUrls[0] || "");
    if (patch.aiPhotoUrls !== undefined) { sets.push(`ai_photo_urls = $${i++}`); vals.push(JSON.stringify(aiPhotoUrls.filter((u) => imageUrls.includes(u)))); }
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
  const tokenPhone = await getTokenPhone(req);
  const { rows: existing } = await pool.query("SELECT vendor_phone FROM products WHERE id = $1", [req.params.id]);
  if (!existing[0]) return res.json({ ok: true }); // déjà supprimé, rien à faire
  if (!tokenPhone || tokenPhone !== existing[0].vendor_phone) return res.status(403).json({ error: "Tu ne peux supprimer que tes propres produits." });
  await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ==================== COMMANDES ====================
// SÉCURITÉ : ne renvoie plus toutes les commandes de tout le monde sans
// vérification — jamais aux acheteurs/vendeurs/livreurs anonymes. Le
// propriétaire voit tout ; les autres ne voient que les commandes liées aux
// numéros de téléphone qu'ils ont réellement vérifiés sur cet appareil.
app.get("/api/orders", async (req, res) => {
  if (await isValidOwnerToken(req)) {
    const { rows } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    return res.json(rows.map(mapOrder));
  }
  const phones = await resolveTokensToPhones(req.query.phoneTokens);
  if (phones.length === 0) return res.json([]);
  const { rows } = await pool.query(
    `SELECT * FROM orders
     WHERE buyer_phone = ANY($1) OR courier_phone = ANY($1)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(items) it WHERE it->>'vendorPhone' = ANY($1))
     ORDER BY created_at DESC`,
    [phones]
  );
  res.json(rows.map(mapOrder));
});

// Code de confirmation de livraison — volontairement JAMAIS inclus dans
// mapOrder/GET /api/orders (accessible largement) : uniquement récupérable
// ici, par l'acheteur lui-même, pour qu'il ne fuite jamais vers le livreur.
app.get("/api/orders/:id/pin", requirePhone((req) => req.query.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT buyer_phone, delivery_pin FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (req.query.phone !== rows[0].buyer_phone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  res.json({ pin: rows[0].delivery_pin });
});

app.post("/api/orders", requirePhone((req) => req.body.buyerPhone), async (req, res) => {
  const o = req.body; // { buyerName, buyerPhone, zone, items, total, deliveryFee, paymentMethod, cinetpayTransactionId, shippingMethod, clientKey }
  // Le paiement à la livraison n'a pas de sens pour une expédition par
  // compagnie de transport : personne n'est présent à l'agence pour encaisser
  // au moment où l'acheteur récupère son colis. Seul le paiement en ligne
  // (bloqué chez le propriétaire jusqu'à confirmation de réception) protège
  // vraiment le vendeur dans ce cas.
  if (o.shippingMethod === "transport" && o.paymentMethod !== "cinetpay") {
    return res.status(400).json({ error: "Le paiement à la livraison n'est pas disponible pour l'expédition par compagnie de transport — un paiement en ligne est requis." });
  }
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
    // SÉCURITÉ : on ne fait jamais confiance aux prix envoyés par le client.
    // Chaque article doit soit correspondre au prix affiché du produit, soit
    // à un prix négocié accepté (et toujours valable) pour cet acheteur —
    // sinon la commande est rejetée. Empêche de modifier le prix payé en
    // trafiquant la requête réseau.
    const validatedItems = [];
    for (const item of (o.items || [])) {
      const { rows: prodRows } = await client.query("SELECT price FROM products WHERE id = $1", [item.id]);
      const realPrice = prodRows[0] ? Number(prodRows[0].price) : null;
      if (realPrice !== null && Number(item.price) === realPrice) {
        validatedItems.push(item);
        continue;
      }
      const { rows: negRows } = await client.query(
        "SELECT * FROM price_negotiations WHERE product_id = $1 AND buyer_phone = $2 AND status = 'accepted' AND expires_at > $3",
        [item.id, o.buyerPhone, Date.now()]
      );
      const neg = negRows[0];
      if (neg && Number(item.price) === Number(neg.accepted_price)) {
        validatedItems.push(item);
        // Le prix négocié est consommé après usage — ne peut pas resservir sur une autre commande.
        await client.query("DELETE FROM price_negotiations WHERE id = $1", [neg.id]);
        continue;
      }
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Le prix de "${item.name || "un article"}" ne correspond plus à l'offre actuelle — actualise la page et réessaie.` });
    }
    o.items = validatedItems;
    // Le total des articles est recalculé à partir des prix vérifiés
    // ci-dessus, jamais repris tel quel du corps de la requête.
    const validatedGoodsAmount = validatedItems.reduce((s, it) => s + Number(it.price) * Number(it.qty), 0);
    const { rows: settingsRows } = await client.query("SELECT * FROM settings WHERE id = 1");
    const feeRate = Number(settingsRows[0].fee_rate);
    const goodsAmount = validatedGoodsAmount;
    const commission = Math.round(goodsAmount * feeRate);
    o.total = goodsAmount + Number(o.deliveryFee || 0);
    const id = uid();
    const createdAt = Date.now();
    // "paid" n'est JAMAIS pris depuis le corps de la requête : une commande démarre
    // toujours non payée. Pour CinetPay, c'est /api/cinetpay/notify (après vérification
    // auprès de CinetPay) qui la marquera payée — voir plus bas.
    // Si l'acheteur choisit l'expédition par compagnie de transport et propose une
    // compagnie, c'est enregistré comme sa proposition initiale — le vendeur devra
    // la confirmer (avec des frais) ou en proposer une autre.
    const initialTransportCompany = o.shippingMethod === "transport" && o.transportCompany ? o.transportCompany : null;
    // Code à 4 chiffres connu seulement de l'acheteur — exigé du livreur pour
    // valider la remise du colis (protège contre un détournement).
    const deliveryPin = String(Math.floor(1000 + Math.random() * 9000));
    await client.query(
      `INSERT INTO orders (id, buyer_name, buyer_phone, zone, items, total, delivery_fee, fee_rate, commission, status,
         courier_name, courier_phone, created_at, payment_method, paid, cinetpay_transaction_id, shipping_method,
         transport_company, tracking_number, courier_bids, courier_confirmed, buyer_confirmed,
         transport_proposed_by, transport_confirmed_by_buyer, buyer_address, delivery_pin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'nouvelle',NULL,NULL,$10,$11,false,$12,$13,$14,NULL,'[]',false,false,$15,$16,$17,$18)`,
      [id, o.buyerName, o.buyerPhone, o.zone, JSON.stringify(o.items || []), o.total, o.deliveryFee || 0, feeRate, commission,
        createdAt, o.paymentMethod || "cod", o.cinetpayTransactionId || null, o.shippingMethod || "livreur",
        initialTransportCompany, initialTransportCompany ? "buyer" : null, !!initialTransportCompany, o.buyerAddress || "", deliveryPin]
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
    // Alerte stock bas au vendeur — après le COMMIT, sans bloquer la réponse.
    for (const item of (o.items || [])) {
      checkLowStockAndNotify(item.id).catch((e) => console.error("Erreur alerte stock bas:", e));
    }
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
  const tokenPhone = await getTokenPhone(req);
  const { rows: existing } = await pool.query(
    "SELECT items, buyer_phone, paid, status AS old_status, shipping_method, created_at, transport_settled_at FROM orders WHERE id = $1",
    [req.params.id]
  );
  if (!existing[0]) return res.status(404).json({ error: "Commande introuvable." });
  const vendorPhones = (existing[0].items || []).map((it) => it.vendorPhone).filter(Boolean);
  const isVendor = tokenPhone && vendorPhones.includes(tokenPhone);
  const isBuyer = tokenPhone && tokenPhone === existing[0].buyer_phone;
  if (!isVendor && !isBuyer) {
    return res.status(403).json({ error: "Tu n'es ni le vendeur ni l'acheteur de cette commande." });
  }
  const patch = req.body;
  // Fenêtre de réflexion : le vendeur ne peut pas confirmer avant qu'elle soit
  // passée — laisse à l'acheteur une vraie marge pour changer d'avis sans
  // jamais faire perdre de temps/argent au vendeur.
  if (patch.status === "confirmee" && Date.now() - Number(existing[0].created_at) < ORDER_GRACE_PERIOD_MS) {
    const remainingMin = Math.ceil((ORDER_GRACE_PERIOD_MS - (Date.now() - Number(existing[0].created_at))) / 60000);
    return res.status(400).json({ error: `Laisse encore ${remainingMin} minute(s) à l'acheteur pour changer d'avis avant de confirmer.` });
  }
  // Deuxième fenêtre de réflexion, spécifique à l'expédition : une fois la
  // compagnie de transport et les frais convenus des deux côtés, le vendeur
  // ne peut pas expédier avant que ce délai soit passé non plus.
  if (patch.status === "en_transit" && existing[0].transport_settled_at && Date.now() - Number(existing[0].transport_settled_at) < ORDER_GRACE_PERIOD_MS) {
    const remainingMin = Math.ceil((ORDER_GRACE_PERIOD_MS - (Date.now() - Number(existing[0].transport_settled_at))) / 60000);
    return res.status(400).json({ error: `Laisse encore ${remainingMin} minute(s) après l'accord sur le transport avant d'expédier.` });
  }
  const colMap = { status: "status", transportCompany: "transport_company", trackingNumber: "tracking_number" };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const key of Object.keys(colMap)) {
    if (patch[key] !== undefined) { sets.push(`${colMap[key]} = $${i++}`); vals.push(patch[key]); }
  }
  // Départ du délai avant confirmation automatique de réception (protège le
  // vendeur si l'acheteur oublie ou néglige de confirmer lui-même).
  if (patch.status === "en_transit") {
    sets.push(`in_transit_at = $${i++}`);
    vals.push(Date.now());
  }
  // Une commande déjà payée qui est annulée doit être remboursée — CinetPay
  // n'offre pas d'API de remboursement automatique, donc on la place dans une
  // file "à rembourser manuellement" que le propriétaire traite depuis son espace.
  if (patch.status === "annulee" && existing[0].paid) {
    sets.push(`refund_status = $${i++}`);
    vals.push("pending");
  }
  // Annulation tardive (après confirmation vendeur, pas pendant la fenêtre de
  // réflexion) — comptabilisée pour le score de fiabilité de l'acheteur.
  if (patch.status === "annulee" && existing[0].old_status !== "nouvelle" && existing[0].old_status !== "annulee") {
    sets.push(`late_cancellation = $${i++}`);
    vals.push(true);
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

// L'acheteur peut supprimer définitivement une commande qui n'a jamais vraiment
// abouti (nouvelle, jamais confirmée, ou annulée) — utile pour nettoyer des
// commandes de test. On protège quand même les commandes payées en ligne dont
// le remboursement n'a pas encore été traité, pour ne pas perdre cette trace.
app.delete("/api/orders/:id", requirePhone((req) => req.body.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT buyer_phone, status, paid, refund_status FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (req.body.phone !== rows[0].buyer_phone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  if (!["nouvelle", "annulee"].includes(rows[0].status)) {
    return res.status(400).json({ error: "Seules les commandes nouvelles ou annulées peuvent être supprimées." });
  }
  if (rows[0].paid && rows[0].refund_status && rows[0].refund_status !== "done") {
    return res.status(400).json({ error: "Cette commande payée doit d'abord être remboursée avant suppression — contacte le propriétaire de la plateforme." });
  }
  await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
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
  const tokenPhone = await getTokenPhone(req);
  const { rows: existing } = await pool.query("SELECT buyer_phone FROM orders WHERE id = $1", [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (!tokenPhone || tokenPhone !== existing[0].buyer_phone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  const { courierName, courierPhone, fee } = req.body;
  const { rows: courierProf } = await pool.query("SELECT vehicle_type, vehicle_plate FROM profiles WHERE role = 'courier' AND phone = $1", [courierPhone]);
  await pool.query(
    "UPDATE orders SET status = 'en_livraison', courier_name = $1, courier_phone = $2, delivery_fee = $3, courier_vehicle_type = $4, courier_vehicle_plate = $5, in_transit_at = $6 WHERE id = $7",
    [courierName, courierPhone, Number(fee) || 0, courierProf[0]?.vehicle_type || "", courierProf[0]?.vehicle_plate || "", Date.now(), req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const updated = mapOrder(rows[0]);
  sendSmsNotification(courierPhone, `Zonako : tu as été choisi pour livrer la commande #${updated.id.slice(-6)} (${updated.zone}). Frais convenus : ${fee} F.`);
  res.json(updated);
});

// Double confirmation de réception — chacun ne peut confirmer que son propre rôle sur SA commande.
// Dès qu'une commande passe "livrée", la commission due est déduite du
// portefeuille du/des vendeur(s) concerné(s) — jamais avant, pour ne pas
// demander au vendeur de payer sur une vente pas encore aboutie. Si plusieurs
// vendeurs sont présents dans une même commande, chacun paie au prorata de sa part.
async function settleVendorCommission(orderId) {
  try {
    const { rows } = await pool.query("SELECT items, commission, buyer_phone, courier_phone FROM orders WHERE id = $1", [orderId]);
    const order = rows[0];
    if (!order) return;
    // Une commande livrée est le premier vrai signe d'activité réelle pour
    // l'acheteur (et pour le livreur, s'il y en a un) — active leur parrainage.
    if (order.buyer_phone) activateReferral(order.buyer_phone, "buyer");
    if (order.courier_phone) activateReferral(order.courier_phone, "courier");
    const items = order.items || [];
    const totalGoods = items.reduce((s, it) => s + Number(it.price) * Number(it.qty), 0);
    if (totalGoods <= 0) return;
    const byVendor = {};
    items.forEach((it) => {
      if (!it.vendorPhone) return;
      byVendor[it.vendorPhone] = (byVendor[it.vendorPhone] || 0) + Number(it.price) * Number(it.qty);
    });
    for (const [vendorPhone, subtotal] of Object.entries(byVendor)) {
      const share = subtotal / totalGoods;
      const vendorCommission = Number(order.commission) * share;
      await pool.query("UPDATE profiles SET wallet_balance = wallet_balance - $1 WHERE role = 'vendor' AND phone = $2", [vendorCommission, vendorPhone]);
    }
  } catch (e) {
    console.error("Erreur lors du règlement de la commission vendeur:", e);
  }
}

// Confirmation automatique de réception si l'acheteur reste inactif plus de
// 3 jours après l'expédition/mise en livraison — protège le vendeur d'un
// acheteur qui oublie ou néglige de confirmer lui-même. Tourne toutes les
// heures pendant que le serveur est en ligne.
const AUTO_CONFIRM_DELAY_MS = 3 * 24 * 60 * 60 * 1000; // 3 jours
async function autoConfirmStaleDeliveries() {
  try {
    const cutoff = Date.now() - AUTO_CONFIRM_DELAY_MS;
    const { rows } = await pool.query(
      "SELECT id FROM orders WHERE status IN ('en_livraison', 'en_transit') AND in_transit_at IS NOT NULL AND in_transit_at < $1",
      [cutoff]
    );
    for (const row of rows) {
      await pool.query(
        "UPDATE orders SET status = 'livree', auto_confirmed = true, buyer_confirmed = true, buyer_confirmed_at = $1, courier_confirmed = true, courier_confirmed_at = COALESCE(courier_confirmed_at, $1) WHERE id = $2",
        [Date.now(), row.id]
      );
      await settleVendorCommission(row.id);
      logAdminAction("Réception confirmée automatiquement (acheteur inactif 3 jours)", null, `Commande #${row.id.slice(-6)}`);
    }
  } catch (e) {
    console.error("Erreur pendant la confirmation automatique des livraisons:", e);
  }
}

app.post("/api/orders/:id/confirm-courier", async (req, res) => {
  const tokenPhone = await getTokenPhone(req);
  const { rows } = await pool.query("SELECT buyer_confirmed, courier_phone, delivery_pin, delivery_fee, courier_fee_payment_method, courier_fee_paid FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (!tokenPhone || tokenPhone !== rows[0].courier_phone) return res.status(403).json({ error: "Tu n'es pas le livreur de cette commande." });
  // Le livreur doit obtenir ce code auprès de l'acheteur au moment de la
  // remise réelle — empêche de valider une livraison qui n'a pas eu lieu.
  if (rows[0].delivery_pin && req.body.pin !== rows[0].delivery_pin) {
    return res.status(400).json({ error: "Code incorrect — demande-le à l'acheteur au moment de la remise." });
  }
  // Le livreur confirme par écrit avoir bien reçu son paiement (espèces ou en
  // ligne) — laisse une trace, en plus du code de livraison lui-même.
  if (!req.body.paymentConfirmed) {
    return res.status(400).json({ error: "Confirme d'abord avoir bien reçu ton paiement de livraison." });
  }
  if (rows[0].courier_fee_payment_method === "cinetpay" && !rows[0].courier_fee_paid) {
    return res.status(400).json({ error: "L'acheteur n'a pas encore payé les frais de livraison en ligne." });
  }
  const status = rows[0].buyer_confirmed ? "livree" : undefined;
  await pool.query(
    `UPDATE orders SET courier_confirmed = true, courier_confirmed_at = $1, courier_payment_confirmed = true ${status ? ", status = 'livree'" : ""} WHERE id = $2`,
    [Date.now(), req.params.id]
  );
  // Si les frais de livraison ont été payés en ligne, ils rejoignent
  // maintenant le portefeuille retirable du livreur (jamais avant, pour
  // éviter qu'il soit payé sans avoir livré).
  if (rows[0].courier_fee_payment_method === "cinetpay" && rows[0].courier_fee_paid) {
    await pool.query("UPDATE profiles SET wallet_balance = wallet_balance + $1 WHERE role = 'courier' AND phone = $2", [Number(rows[0].delivery_fee) || 0, tokenPhone]);
  }
  if (status === "livree") await settleVendorCommission(req.params.id);
  const { rows: r2 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r2[0]));
});
app.post("/api/orders/:id/confirm-buyer", async (req, res) => {
  const tokenPhone = await getTokenPhone(req);
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
  if (status === "livree") await settleVendorCommission(req.params.id);
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
  // On se fie au rôle indiqué par le client (il sait déjà dans quel espace il
  // est) et on vérifie juste qu'il a bien le droit d'agir ainsi sur cette
  // commande — plutôt que de deviner le rôle depuis le numéro seul, ce qui
  // était ambigu si la même personne est acheteur ET vendeur avec le même compte.
  const claimedRole = req.body.role === "vendor" ? "vendor" : "buyer";
  const isBuyer = phone === order.buyer_phone;
  const isVendor = (order.items || []).some((it) => it.vendorPhone === phone);
  if (claimedRole === "buyer" && !isBuyer) return res.status(403).json({ error: "Non autorisé sur cette commande (acheteur)." });
  if (claimedRole === "vendor" && !isVendor) return res.status(403).json({ error: "Non autorisé sur cette commande (vendeur)." });
  const role = claimedRole;
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
       transport_confirmed_by_buyer = $4, transport_confirmed_by_vendor = $5
     WHERE id = $6`,
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
  const claimedRole = req.body.role === "vendor" ? "vendor" : "buyer";
  const isBuyer = phone === order.buyer_phone;
  const isVendor = (order.items || []).some((it) => it.vendorPhone === phone);
  if (claimedRole === "buyer" && !isBuyer) return res.status(403).json({ error: "Non autorisé sur cette commande (acheteur)." });
  if (claimedRole === "vendor" && !isVendor) return res.status(403).json({ error: "Non autorisé sur cette commande (vendeur)." });
  const role = claimedRole;
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
    await pool.query("UPDATE orders SET delivery_fee = $1, transport_settled_at = $2 WHERE id = $3", [Number(updated.transport_fee) || 0, Date.now(), req.params.id]);
  }
  const { rows: r3 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r3[0]));
});

// ==================== PROFILS (vendeur / livreur) ====================
app.get("/api/profiles/:role/:phone", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [req.params.role, req.params.phone]);
  if (!rows[0]) return res.status(404).json({ error: "Profil introuvable." });
  const profile = mapProfile(rows[0]);
  // Le solde du portefeuille est une donnée financière — jamais visible par
  // un tiers, seulement par la personne elle-même ou le propriétaire.
  const tokenPhone = await getTokenPhone(req);
  if (tokenPhone !== req.params.phone && !(await isValidOwnerToken(req))) {
    delete profile.walletBalance;
  }
  res.json(profile);
});

// Crée le profil s'il n'existe pas (essai gratuit démarré maintenant), ou met juste à jour le nom sinon
app.put("/api/profiles/:role/:phone", requirePhone((req) => req.params.phone), async (req, res) => {
  const { role, phone } = req.params;
  const { name, password, referralCode } = req.body;
  const passwordHash = password ? hashPassword(password) : null;
  const { rows } = await pool.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [role, phone]);
  const isNewRegistration = !rows[0];
  if (rows[0]) {
    if (passwordHash) {
      await pool.query("UPDATE profiles SET name = $1, password_hash = $2 WHERE role = $3 AND phone = $4", [name, passwordHash, role, phone]);
    } else {
      await pool.query("UPDATE profiles SET name = $1 WHERE role = $2 AND phone = $3", [name, role, phone]);
    }
  } else {
    await pool.query(
      "INSERT INTO profiles (role, phone, name, trial_started_at, subscription_status, password_hash) VALUES ($1,$2,$3,$4,'trial',$5)",
      [role, phone, name, Date.now(), passwordHash]
    );
  }
  if (isNewRegistration && referralCode) recordReferralSignup(referralCode, phone, role);
  const { rows: r2 } = await pool.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [role, phone]);
  res.json(mapProfile(r2[0]));
});

// Connexion directe par mot de passe — évite de redemander un code SMS/email
// à chaque connexion, une fois qu'un mot de passe a été créé à l'inscription.
app.post("/api/auth/login-password", async (req, res) => {
  const { role, phone, password } = req.body;
  if (!["buyer", "vendor", "courier"].includes(role)) return res.status(400).json({ error: "Rôle invalide." });
  if (!phone || !password) return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const blockedMin = passwordLoginLimiter.isBlocked(`${ip}:${phone}`);
  if (blockedMin) return res.status(429).json({ error: `Trop de tentatives. Réessaie dans ${blockedMin} minute(s).` });
  const { rows } = await pool.query("SELECT * FROM profiles WHERE role = $1 AND phone = $2", [role, phone]);
  if (!rows[0] || !verifyPassword(password, rows[0].password_hash)) {
    const blocked = passwordLoginLimiter.recordFailure(`${ip}:${phone}`);
    logSecurityEvent(blocked ? "password_login_blocked" : "failed_password_login", `${role} · ${phone}`, ip);
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  }
  passwordLoginLimiter.reset(`${ip}:${phone}`);
  const token = await issuePhoneToken(phone);
  res.json({ token, profile: mapProfile(rows[0]) });
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
  const oldPhone = await getTokenPhone(req);
  if (!oldPhone) return res.status(401).json({ error: "Numéro actuel non vérifié. Reconnecte-toi." });
  if (!newPhone || !newToken) return res.status(400).json({ error: "Nouveau numéro et code de vérification requis." });
  if (oldPhone === newPhone) return res.status(400).json({ error: "C'est déjà ton numéro actuel." });
  const { rows: tokenRows } = await pool.query("SELECT phone, expires_at FROM phone_tokens WHERE token = $1", [newToken]);
  const entry = tokenRows[0];
  if (!entry || Number(entry.expires_at) < Date.now() || entry.phone !== newPhone) {
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
  const tokenPhone = await getTokenPhone(req);
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
      verified: v.verified || false,
      walletBalance: v.wallet_balance !== null && v.wallet_balance !== undefined ? Number(v.wallet_balance) : 0,
    };
  }).sort((a, b) => (b.openReports - a.openReports) || (b.cancelRate - a.cancelRate));

  res.json(result);
});

// Fiabilité des acheteurs (annulations tardives, après confirmation vendeur)
// — réservé au propriétaire, pour repérer les acheteurs à surveiller sans
// bloquer les changements d'avis normaux pendant la fenêtre de réflexion.
app.get("/api/buyers/risk", requireOwner, async (req, res) => {
  const { rows: orders } = await pool.query("SELECT buyer_name, buyer_phone, status, late_cancellation FROM orders");
  const stats = {}; // phone -> { name, total, lateCancellations }
  for (const o of orders) {
    if (!o.buyer_phone) continue;
    stats[o.buyer_phone] = stats[o.buyer_phone] || { name: o.buyer_name, total: 0, lateCancellations: 0 };
    stats[o.buyer_phone].total += 1;
    if (o.late_cancellation) stats[o.buyer_phone].lateCancellations += 1;
  }
  const result = Object.entries(stats)
    .filter(([, s]) => s.lateCancellations > 0)
    .map(([phone, s]) => ({
      phone, name: s.name, totalOrders: s.total, lateCancellations: s.lateCancellations,
      lateCancelRate: Math.round((s.lateCancellations / s.total) * 100),
    }))
    .sort((a, b) => b.lateCancellations - a.lateCancellations);
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
  const tokenPhone = await getTokenPhone(req);
  const { orderId, rateePhone, rateeRole, stars, comment, photoUrl } = req.body;
  if (!tokenPhone) return res.status(401).json({ error: "Numéro non vérifié." });
  if (!orderId || !rateePhone || !rateeRole || !stars) return res.status(400).json({ error: "Informations manquantes." });
  const { rows } = await pool.query("SELECT buyer_phone, status FROM orders WHERE id = $1", [orderId]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (rows[0].buyer_phone !== tokenPhone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  if (rows[0].status !== "livree") return res.status(400).json({ error: "Tu ne peux noter qu'une commande livrée." });
  const id = uid();
  await pool.query(
    `INSERT INTO ratings (id, order_id, buyer_phone, ratee_phone, ratee_role, stars, comment, created_at, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (order_id, ratee_phone) DO UPDATE SET stars = $6, comment = $7, photo_url = $9`,
    [id, orderId, tokenPhone, rateePhone, rateeRole, Math.max(1, Math.min(5, Number(stars))), comment || "", Date.now(), photoUrl || null]
  );
  res.json({ ok: true });
});

// Photos jointes par de vrais acheteurs (preuve de conformité) — publiques,
// affichées aux futurs acheteurs à côté des photos officielles du vendeur.
app.get("/api/ratings/:phone/photos", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT photo_url, comment, stars, created_at FROM ratings WHERE ratee_phone = $1 AND photo_url IS NOT NULL ORDER BY created_at DESC LIMIT 12",
    [req.params.phone]
  );
  res.json(rows.map((r) => ({ photoUrl: r.photo_url, comment: r.comment, stars: r.stars, createdAt: Number(r.created_at) })));
});

app.get("/api/ratings/:phone", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count, COALESCE(AVG(stars), 0) AS avg FROM ratings WHERE ratee_phone = $1",
    [req.params.phone]
  );
  res.json({ count: rows[0].count, average: Math.round(Number(rows[0].avg) * 10) / 10 });
});

// ==================== LITIGES DE NON-CONFORMITÉ ====================
// L'acheteur peut refuser de confirmer une réception s'il estime que
// l'article ne correspond pas aux photos/vidéos annoncées — ça bloque le
// déblocage des fonds du vendeur jusqu'à ce que le propriétaire tranche.
app.post("/api/orders/:id/dispute", requirePhone((req) => req.body.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT buyer_phone, items, status FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Commande introuvable." });
  if (req.body.phone !== rows[0].buyer_phone) return res.status(403).json({ error: "Ce n'est pas ta commande." });
  if (!["en_transit", "en_livraison", "confirmee"].includes(rows[0].status)) {
    return res.status(400).json({ error: "Cette commande n'est pas dans un état pouvant être contestée." });
  }
  const vendorPhone = (rows[0].items || []).map((it) => it.vendorPhone).find(Boolean) || null;
  const id = uid();
  await pool.query(
    "INSERT INTO order_disputes (id, order_id, buyer_phone, vendor_phone, description, photo_url, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'open',$7)",
    [id, req.params.id, req.body.phone, vendorPhone, req.body.description || "", req.body.photoUrl || null, Date.now()]
  );
  await pool.query("UPDATE orders SET status = 'litige' WHERE id = $1", [req.params.id]);
  logAdminAction("Litige ouvert par l'acheteur", vendorPhone, `Commande #${req.params.id.slice(-6)}`);
  const { rows: r2 } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(mapOrder(r2[0]));
});
app.get("/api/admin/disputes", requireOwner, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM order_disputes ORDER BY (status = 'open') DESC, created_at DESC");
  res.json(rows.map((r) => ({
    id: r.id, orderId: r.order_id, buyerPhone: r.buyer_phone, vendorPhone: r.vendor_phone,
    description: r.description, photoUrl: r.photo_url, status: r.status,
    createdAt: Number(r.created_at), resolvedAt: r.resolved_at ? Number(r.resolved_at) : null,
  })));
});
app.post("/api/admin/disputes/:id/resolve", requireOwner, async (req, res) => {
  const { resolution } = req.body; // 'buyer' ou 'vendor'
  if (!["buyer", "vendor"].includes(resolution)) return res.status(400).json({ error: "Résolution invalide." });
  const { rows } = await pool.query("SELECT * FROM order_disputes WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Litige introuvable." });
  const dispute = rows[0];
  if (resolution === "vendor") {
    // Le vendeur avait raison : la commande est marquée livrée normalement,
    // ce qui libère ses fonds (séquestre) et déduit sa commission comme d'habitude.
    await pool.query("UPDATE orders SET status = 'livree' WHERE id = $1", [dispute.order_id]);
    await settleVendorCommission(dispute.order_id);
  } else {
    // L'acheteur avait raison : la commande est annulée, marquée à rembourser —
    // les fonds du vendeur restent bloqués (jamais libérés pour cette commande).
    await pool.query("UPDATE orders SET status = 'annulee', refund_status = CASE WHEN paid THEN 'pending' ELSE refund_status END WHERE id = $1", [dispute.order_id]);
  }
  await pool.query("UPDATE order_disputes SET status = $1, resolved_at = $2 WHERE id = $3", [`resolved_${resolution}`, Date.now(), req.params.id]);
  logAdminAction("Litige tranché", dispute.vendor_phone, resolution === "buyer" ? "En faveur de l'acheteur" : "En faveur du vendeur");
  res.json({ ok: true });
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

// Vérification vendeur (même principe que pour les livreurs) — un badge visible
// par les acheteurs sur les produits de ce vendeur.
app.post("/api/vendors/:phone/verify", requireOwner, async (req, res) => {
  await pool.query("UPDATE profiles SET verified = true WHERE role = 'vendor' AND phone = $1", [req.params.phone]);
  logAdminAction("Vendeur vérifié", req.params.phone);
  res.json({ ok: true });
});
app.post("/api/vendors/:phone/unverify", requireOwner, async (req, res) => {
  await pool.query("UPDATE profiles SET verified = false WHERE role = 'vendor' AND phone = $1", [req.params.phone]);
  logAdminAction("Vérification retirée", req.params.phone);
  res.json({ ok: true });
});

// Le propriétaire crédite manuellement le portefeuille d'un vendeur (en
// attendant un vrai rechargement en ligne via CinetPay).
app.post("/api/vendors/:phone/credit-wallet", requireOwner, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Indique un montant valide." });
  const result = await pool.query("UPDATE profiles SET wallet_balance = wallet_balance + $1 WHERE role = 'vendor' AND phone = $2", [amount, req.params.phone]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Vendeur introuvable." });
  logAdminAction("Portefeuille crédité", req.params.phone, `+${amount} F`);
  res.json({ ok: true });
});

// Confiance d'un vendeur, visible publiquement par les acheteurs — vérifié +
// taux de livraisons réussies. Pas de détail sensible (signalements, motifs...).
app.get("/api/vendors/:phone/trust", async (req, res) => {
  const { rows: prof } = await pool.query("SELECT verified FROM profiles WHERE role = 'vendor' AND phone = $1", [req.params.phone]);
  const { rows: orderRows } = await pool.query(
    `SELECT status FROM orders o WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(o.items) it WHERE it->>'vendorPhone' = $1
     ) AND status != 'nouvelle'`,
    [req.params.phone]
  );
  const total = orderRows.length;
  const delivered = orderRows.filter((o) => o.status === "livree").length;
  const cancelled = orderRows.filter((o) => o.status === "annulee").length;
  const successRate = total > 0 ? Math.round((delivered / (delivered + cancelled || 1)) * 100) : null;
  res.json({ verified: prof[0]?.verified || false, successRate, totalOrders: total });
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
// Réinitialisation complète des données de "test" (produits, commandes, comptes
// acheteur/vendeur/livreur, notes, signalements...) — pour repartir sur une base
// neuve avant un vrai lancement commercial. Les réglages et le contenu de la
// plateforme (settings, site_content) et les notes d'équipe sont conservés.
app.post("/api/admin/reset-test-data", requireOwner, async (req, res) => {
  if (req.body.confirm !== "SUPPRIMER TOUT") {
    return res.status(400).json({ error: "Confirmation incorrecte — tape exactement « SUPPRIMER TOUT »." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM ratings");
    await client.query("DELETE FROM vendor_reports");
    await client.query("DELETE FROM order_idempotency");
    await client.query("DELETE FROM orders");
    await client.query("DELETE FROM products");
    await client.query("DELETE FROM otp_codes");
    await client.query("DELETE FROM verified_phones");
    await client.query("DELETE FROM phone_tokens");
    await client.query("DELETE FROM profiles");
    await client.query("DELETE FROM admin_actions");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Erreur lors de la réinitialisation des données de test:", e);
    client.release();
    return res.status(500).json({ error: "Erreur pendant la réinitialisation." });
  }
  client.release();
  logAdminAction("Réinitialisation complète des données de test", null, null);
  res.json({ ok: true });
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

// Résumé des revenus du propriétaire — distingue la commission "générée"
// (théorique, calculée sur toutes les commandes livrées) de l'argent
// "réellement encaissé" (paiements CinetPay confirmés : abonnements, recharges
// de portefeuille vendeur, et part commission des commandes payées en ligne).
app.get("/api/admin/revenue", requireOwner, async (req, res) => {
  const { rows: delivered } = await pool.query("SELECT commission FROM orders WHERE status = 'livree'");
  const commissionGenerated = delivered.reduce((s, o) => s + Number(o.commission || 0), 0);

  const { rows: confirmedPending } = await pool.query(
    "SELECT kind, amount FROM pending_payments WHERE status = 'confirmed' AND kind IN ('subscription', 'wallet_topup')"
  );
  const fromSubscriptionsAndTopups = confirmedPending.reduce((s, p) => s + Number(p.amount || 0), 0);

  const { rows: paidOrders } = await pool.query("SELECT commission FROM orders WHERE paid = true AND status != 'annulee'");
  const fromOnlineOrderCommissions = paidOrders.reduce((s, o) => s + Number(o.commission || 0), 0);

  const realCollected = fromSubscriptionsAndTopups + fromOnlineOrderCommissions;

  const { rows: withdrawn } = await pool.query("SELECT amount FROM withdrawal_requests WHERE status = 'done'");
  const alreadyWithdrawn = withdrawn.reduce((s, w) => s + Number(w.amount || 0), 0);
  const { rows: pendingW } = await pool.query("SELECT amount FROM withdrawal_requests WHERE status = 'pending'");
  const pendingWithdrawal = pendingW.reduce((s, w) => s + Number(w.amount || 0), 0);

  res.json({
    commissionGenerated,
    realCollected,
    availableToWithdraw: Math.max(0, realCollected - alreadyWithdrawn - pendingWithdrawal),
    alreadyWithdrawn,
    pendingWithdrawal,
  });
});

app.get("/api/admin/withdrawals", requireOwner, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM withdrawal_requests ORDER BY created_at DESC");
  res.json(rows.map((r) => ({ id: r.id, amount: Number(r.amount), method: r.method, accountInfo: r.account_info, status: r.status, createdAt: Number(r.created_at), doneAt: r.done_at ? Number(r.done_at) : null, vendorPhone: r.vendor_phone || null, agentPhone: r.agent_phone || null })));
});
app.post("/api/admin/withdrawals", requireOwner, async (req, res) => {
  const { amount, method, accountInfo } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Indique un montant valide." });
  if (!["bank", "mobile_money"].includes(method)) return res.status(400).json({ error: "Méthode invalide." });
  if (!accountInfo) return res.status(400).json({ error: "Indique les coordonnées du compte de réception." });
  const id = uid();
  await pool.query(
    "INSERT INTO withdrawal_requests (id, amount, method, account_info, status, created_at) VALUES ($1,$2,$3,$4,'pending',$5)",
    [id, amount, method, accountInfo, Date.now()]
  );
  logAdminAction("Demande de retrait créée", null, `${amount} F · ${method}`);
  res.json({ ok: true, id });
});
app.post("/api/admin/withdrawals/:id/done", requireOwner, async (req, res) => {
  await pool.query("UPDATE withdrawal_requests SET status = 'done', done_at = $1 WHERE id = $2", [Date.now(), req.params.id]);
  logAdminAction("Retrait marqué comme effectué", req.params.id);
  res.json({ ok: true });
});

// ==================== AGENTS DE RECRUTEMENT (PARRAINAGE) ====================
// Journal des événements de sécurité — tentatives de connexion échouées et
// blocages, pour repérer une attaque en cours plutôt que la bloquer en silence.
app.get("/api/admin/security-events", requireOwner, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM security_events ORDER BY created_at DESC LIMIT 100");
  res.json(rows.map((r) => ({ id: r.id, type: r.type, detail: r.detail, ip: r.ip, createdAt: Number(r.created_at) })));
});

app.get("/api/admin/agents", requireOwner, async (req, res) => {
  const { rows: agents } = await pool.query("SELECT * FROM referral_agents ORDER BY created_at DESC");
  const { rows: signups } = await pool.query("SELECT agent_phone, role, activated FROM referral_signups");
  const result = agents.map((a) => {
    const own = signups.filter((s) => s.agent_phone === a.phone);
    const countActivated = (role) => own.filter((s) => s.role === role && s.activated).length;
    const buyerN = countActivated("buyer"), vendorN = countActivated("vendor"), courierN = countActivated("courier");
    const earned = buyerN * Number(a.rate_buyer) + vendorN * Number(a.rate_vendor) + courierN * Number(a.rate_courier);
    return {
      phone: a.phone, name: a.name, code: a.code, active: a.active,
      rateBuyer: Number(a.rate_buyer), rateVendor: Number(a.rate_vendor), rateCourier: Number(a.rate_courier),
      totalSignups: own.length,
      activatedBuyers: buyerN, activatedVendors: vendorN, activatedCouriers: courierN,
      totalEarned: earned,
    };
  });
  res.json(result);
});
app.post("/api/admin/agents", requireOwner, async (req, res) => {
  const { name, phone, code, rateBuyer, rateVendor, rateCourier } = req.body;
  if (!name || !phone || !code) return res.status(400).json({ error: "Nom, téléphone et code requis." });
  const normalizedCode = code.trim().toUpperCase();
  const { rows: existing } = await pool.query("SELECT phone FROM referral_agents WHERE code = $1", [normalizedCode]);
  if (existing[0]) return res.status(400).json({ error: "Ce code est déjà utilisé par un autre agent." });
  await pool.query(
    "INSERT INTO referral_agents (phone, name, code, rate_buyer, rate_vendor, rate_courier, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (phone) DO UPDATE SET name = $2, code = $3, rate_buyer = $4, rate_vendor = $5, rate_courier = $6",
    [phone, name, normalizedCode, Number(rateBuyer) || 0, Number(rateVendor) || 0, Number(rateCourier) || 0, Date.now()]
  );
  res.json({ ok: true });
});
app.post("/api/admin/agents/:phone/toggle", requireOwner, async (req, res) => {
  await pool.query("UPDATE referral_agents SET active = NOT active WHERE phone = $1", [req.params.phone]);
  res.json({ ok: true });
});

// Un agent consulte ses propres statistiques (connexion par téléphone, même
// mécanisme de jeton que pour acheteur/vendeur/livreur).
app.get("/api/agents/:phone/stats", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows: agentRows } = await pool.query("SELECT * FROM referral_agents WHERE phone = $1", [req.params.phone]);
  if (!agentRows[0]) return res.status(404).json({ error: "Aucun profil agent pour ce numéro." });
  const a = agentRows[0];
  const { rows: signups } = await pool.query("SELECT role, activated FROM referral_signups WHERE agent_phone = $1", [req.params.phone]);
  const countActivated = (role) => signups.filter((s) => s.role === role && s.activated).length;
  const buyerN = countActivated("buyer"), vendorN = countActivated("vendor"), courierN = countActivated("courier");
  const earned = buyerN * Number(a.rate_buyer) + vendorN * Number(a.rate_vendor) + courierN * Number(a.rate_courier);
  const { rows: withdrawals } = await pool.query("SELECT * FROM withdrawal_requests WHERE agent_phone = $1 ORDER BY created_at DESC", [req.params.phone]);
  const alreadyWithdrawn = withdrawals.filter((w) => w.status !== "cancelled").reduce((s, w) => s + Number(w.amount), 0);
  res.json({
    name: a.name, code: a.code,
    totalSignups: signups.length,
    activatedBuyers: buyerN, activatedVendors: vendorN, activatedCouriers: courierN,
    totalEarned: earned,
    availableToWithdraw: Math.max(0, earned - alreadyWithdrawn),
    withdrawals: withdrawals.map((w) => ({ id: w.id, amount: Number(w.amount), method: w.method, status: w.status, createdAt: Number(w.created_at) })),
  });
});
app.post("/api/agents/:phone/withdrawals", requirePhone((req) => req.params.phone), async (req, res) => {
  const { amount, method, accountInfo } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Indique un montant valide." });
  if (!["bank", "mobile_money"].includes(method)) return res.status(400).json({ error: "Méthode invalide." });
  if (!accountInfo) return res.status(400).json({ error: "Indique les coordonnées du compte de réception." });
  const id = uid();
  await pool.query(
    "INSERT INTO withdrawal_requests (id, amount, method, account_info, status, created_at, agent_phone) VALUES ($1,$2,$3,$4,'pending',$5,$6)",
    [id, amount, method, accountInfo, Date.now(), req.params.phone]
  );
  logAdminAction("Demande de retrait agent", req.params.phone, `${amount} F · ${method}`);
  res.json({ ok: true, id });
});

// ==================== SÉQUESTRE VENDEUR (paiement en ligne retenu jusqu'à livraison) ====================
// Pour les commandes payées en ligne, l'argent arrive d'abord chez le
// propriétaire (un seul compte CinetPay pour toute la plateforme). La part du
// vendeur (prix - commission) reste "en attente" tant que la commande n'est
// pas livrée/confirmée par l'acheteur — ensuite seulement, elle devient
// disponible pour un retrait vers son Mobile Money/banque.
app.get("/api/vendors/:phone/revenue", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT items, commission, status, paid FROM orders WHERE paid = true");
  let pending = 0;
  let available = 0;
  for (const o of rows) {
    const items = o.items || [];
    const totalGoods = items.reduce((s, it) => s + Number(it.price) * Number(it.qty), 0);
    const mine = items.filter((it) => it.vendorPhone === req.params.phone).reduce((s, it) => s + Number(it.price) * Number(it.qty), 0);
    if (mine <= 0 || totalGoods <= 0) continue;
    const share = mine / totalGoods;
    const net = mine - Number(o.commission) * share;
    if (o.status === "livree") available += net;
    else if (o.status !== "annulee") pending += net;
  }
  const { rows: withdrawn } = await pool.query("SELECT amount FROM withdrawal_requests WHERE vendor_phone = $1 AND status = 'done'", [req.params.phone]);
  const alreadyWithdrawn = withdrawn.reduce((s, w) => s + Number(w.amount || 0), 0);
  const { rows: pendingW } = await pool.query("SELECT amount FROM withdrawal_requests WHERE vendor_phone = $1 AND status = 'pending'", [req.params.phone]);
  const pendingWithdrawal = pendingW.reduce((s, w) => s + Number(w.amount || 0), 0);
  res.json({
    pendingProceeds: pending,
    availableProceeds: available,
    alreadyWithdrawn,
    pendingWithdrawal,
    availableToWithdraw: Math.max(0, available - alreadyWithdrawn - pendingWithdrawal),
  });
});
app.get("/api/vendors/:phone/withdrawals", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM withdrawal_requests WHERE vendor_phone = $1 ORDER BY created_at DESC", [req.params.phone]);
  res.json(rows.map((r) => ({ id: r.id, amount: Number(r.amount), method: r.method, accountInfo: r.account_info, status: r.status, createdAt: Number(r.created_at), doneAt: r.done_at ? Number(r.done_at) : null })));
});
app.post("/api/vendors/:phone/withdrawals", requirePhone((req) => req.params.phone), async (req, res) => {
  const { amount, method, accountInfo } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Indique un montant valide." });
  if (!["bank", "mobile_money"].includes(method)) return res.status(400).json({ error: "Méthode invalide." });
  if (!accountInfo) return res.status(400).json({ error: "Indique les coordonnées du compte de réception." });
  const id = uid();
  await pool.query(
    "INSERT INTO withdrawal_requests (id, amount, method, account_info, status, created_at, vendor_phone) VALUES ($1,$2,$3,$4,'pending',$5,$6)",
    [id, amount, method, accountInfo, Date.now(), req.params.phone]
  );
  logAdminAction("Demande de retrait vendeur créée", req.params.phone, `${amount} F · ${method}`);
  res.json({ ok: true, id });
});

// Frais de livraison payés en ligne — déjà crédités au portefeuille du
// livreur à la confirmation (voir /confirm-courier), donc pas de calcul
// pending/available complexe comme pour le vendeur : juste son solde.
app.get("/api/couriers/:phone/revenue", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows: prof } = await pool.query("SELECT wallet_balance FROM profiles WHERE role = 'courier' AND phone = $1", [req.params.phone]);
  const balance = Number(prof[0]?.wallet_balance) || 0;
  const { rows: pendingW } = await pool.query("SELECT amount FROM withdrawal_requests WHERE courier_phone = $1 AND status = 'pending'", [req.params.phone]);
  const pendingWithdrawal = pendingW.reduce((s, w) => s + Number(w.amount || 0), 0);
  res.json({ availableToWithdraw: Math.max(0, balance - pendingWithdrawal) });
});
app.get("/api/couriers/:phone/withdrawals", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM withdrawal_requests WHERE courier_phone = $1 ORDER BY created_at DESC", [req.params.phone]);
  res.json(rows.map((r) => ({ id: r.id, amount: Number(r.amount), method: r.method, accountInfo: r.account_info, status: r.status, createdAt: Number(r.created_at), doneAt: r.done_at ? Number(r.done_at) : null })));
});
app.post("/api/couriers/:phone/withdrawals", requirePhone((req) => req.params.phone), async (req, res) => {
  const { amount, method, accountInfo } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Indique un montant valide." });
  if (!["bank", "mobile_money"].includes(method)) return res.status(400).json({ error: "Méthode invalide." });
  if (!accountInfo) return res.status(400).json({ error: "Indique les coordonnées du compte de réception." });
  const id = uid();
  await pool.query(
    "INSERT INTO withdrawal_requests (id, amount, method, account_info, status, created_at, courier_phone) VALUES ($1,$2,$3,$4,'pending',$5,$6)",
    [id, amount, method, accountInfo, Date.now(), req.params.phone]
  );
  logAdminAction("Demande de retrait livreur créée", req.params.phone, `${amount} F · ${method}`);
  res.json({ ok: true, id });
});

// Commandes payées puis annulées : leur remboursement doit être traité
// manuellement (CinetPay ne propose pas de remboursement automatique par API).
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
    announcementMessage: r.announcement_message || "",
    announcementProductId: r.announcement_product_id || "",
    announcementCreatedAt: r.announcement_created_at ? Number(r.announcement_created_at) : null,
    announcementVideoUrl: r.announcement_video_url || "",
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

// Publier ou retirer l'annonce/bannière visible par tous les acheteurs inscrits.
app.post("/api/content/announcement", requireOwner, async (req, res) => {
  const { message, productId, videoUrl } = req.body;
  await pool.query(
    "UPDATE site_content SET announcement_message = $1, announcement_product_id = $2, announcement_created_at = $3, announcement_video_url = $4 WHERE id = 1",
    [message || null, productId || null, message ? Date.now() : null, videoUrl || null]
  );
  const { rows } = await pool.query("SELECT * FROM site_content WHERE id = 1");
  res.json(mapContent(rows[0]));
});

// Un vendeur peut pousser lui-même une courte vidéo "en direct" en bannière
// à tous les acheteurs — pub vidéo rapide, sans vrai streaming temps réel.
// Remplace l'annonce en cours (une seule à la fois, comme pour le reste).
app.post("/api/vendors/:phone/live-announcement", requirePhone((req) => req.params.phone), async (req, res) => {
  const { message, videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ error: "Une vidéo est requise." });
  const { rows: prof } = await pool.query("SELECT * FROM profiles WHERE role = 'vendor' AND phone = $1", [req.params.phone]);
  const vendorName = prof[0]?.name || "Un vendeur";
  await pool.query(
    "UPDATE site_content SET announcement_message = $1, announcement_product_id = NULL, announcement_created_at = $2, announcement_video_url = $3 WHERE id = 1",
    [message?.trim() ? `🔴 ${vendorName} : ${message.trim()}` : `🔴 ${vendorName} est en direct !`, Date.now(), videoUrl]
  );
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
      } else if (pending.kind === "wallet_topup" && pending.phone) {
        // Le vendeur recharge lui-même son portefeuille de commission (Mobile
        // Money / carte via CinetPay) — l'argent arrive directement sur le
        // compte CinetPay du propriétaire de la plateforme, comme tous les
        // autres paiements du site.
        // SÉCURITÉ : on crédite le montant confirmé par CinetPay lui-même
        // (result.data.amount), jamais celui déclaré par le client au moment
        // de /api/payments/pending — sinon n'importe qui pourrait gonfler son
        // propre solde en déclarant un montant plus élevé que ce qu'il paie réellement.
        const confirmedAmount = Number(result?.data?.amount) || 0;
        await pool.query("UPDATE profiles SET wallet_balance = wallet_balance + $1 WHERE role = 'vendor' AND phone = $2", [confirmedAmount, pending.phone]);
        logAdminAction("Portefeuille rechargé par le vendeur", pending.phone, `+${confirmedAmount} F`);
      } else if (pending.kind === "courier_fee" && pending.order_id) {
        // L'acheteur a payé les frais de livraison en ligne — l'argent reste
        // bloqué chez le propriétaire jusqu'à la confirmation de livraison
        // (code à 4 chiffres), qui le libère alors vers le livreur.
        await pool.query("UPDATE orders SET courier_fee_paid = true, courier_fee_payment_method = 'cinetpay' WHERE id = $1", [pending.order_id]);
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
// Protection contre les tentatives répétées (force brute) : après 5 essais
// échoués depuis la même IP, blocage temporaire de 15 minutes.
const ownerLoginLimiter = makeRateLimiter(5, 15 * 60 * 1000);
app.post("/api/owner/login", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const blockedMin = ownerLoginLimiter.isBlocked(ip);
  if (blockedMin) return res.status(429).json({ error: `Trop de tentatives. Réessaie dans ${blockedMin} minute(s).` });
  const { code } = req.body;
  if (!OWNER_PASSCODE) return res.status(500).json({ error: "OWNER_PASSCODE non configuré sur le serveur." });
  if (code !== OWNER_PASSCODE) {
    const blocked = ownerLoginLimiter.recordFailure(ip);
    logSecurityEvent(blocked ? "owner_login_blocked" : "failed_owner_login", null, ip);
    return res.status(401).json({ error: "Code incorrect." });
  }
  ownerLoginLimiter.reset(ip);
  res.json({ token: await issueOwnerToken() });
});

// Petit assistant de questions générales pour le propriétaire — répond à
// partir d'une connaissance générale de Zonako, mais ne peut ni modifier le
// code ni déployer quoi que ce soit (contrairement à Claude en conversation).
const ZONAKO_ASSISTANT_CONTEXT = `Tu es un assistant intégré au tableau de bord propriétaire de Zonako, une plateforme de e-commerce de proximité en Côte d'Ivoire (par zone géographique), avec trois rôles : acheteur, vendeur, livreur.
Fonctionnalités clés de la plateforme :
- Paiement en ligne (CinetPay) ou à la livraison ; séquestre des fonds jusqu'à confirmation de réception.
- Fenêtre de réflexion de 10 minutes après commande avant que le vendeur puisse confirmer.
- Système de litiges : l'acheteur peut contester une réception non conforme (photo à l'appui), le propriétaire tranche.
- Confirmation automatique de réception après 3 jours d'inactivité de l'acheteur.
- Expédition par compagnie de transport : paiement en ligne obligatoire (pas de paiement à la livraison), avec une deuxième fenêtre de réflexion de 10 minutes une fois l'accord de transport trouvé.
- Portefeuille vendeur, demandes de retrait (Mobile Money / compte bancaire).
- Outils IA pour les vendeurs : génération de description et d'accroche publicitaire, amélioration photo automatique, photo de présentation mode (mannequin).
- Notifications comportementales par email (relance produit vu, baisse de prix sur favori, nouveauté dans une catégorie suivie) — email uniquement pour l'instant, pas SMS.
- Application installable sur téléphone (PWA).
- Annonces automatiques aux acheteurs (nouveau vendeur/produit) ou publiées manuellement.
Réponds uniquement à des questions générales sur le fonctionnement de la plateforme ou des conseils généraux. Tu ne peux PAS modifier le code, déployer de changement, ni accéder aux vraies données de la base — pour tout problème technique réel ou toute modification, dis clairement à l'utilisateur de revenir dans sa conversation avec Claude (celle où la plateforme a été construite). Réponds en français, de façon concise (quelques phrases).`;
app.post("/api/owner/assistant", requireOwner, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "L'assistant n'est pas encore configuré sur le serveur." });
  const { question, history } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: "Écris une question." });
  try {
    const messages = [
      ...(Array.isArray(history) ? history.slice(-6) : []),
      { role: "user", content: question },
    ];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: ZONAKO_ASSISTANT_CONTEXT,
        messages,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`Anthropic a répondu ${r.status} : ${detail}`);
    }
    const data = await r.json();
    const answer = (data.content || []).map((b) => b.text || "").join("").trim();
    res.json({ answer });
  } catch (e) {
    console.error("Erreur pendant l'assistant propriétaire:", e);
    res.status(500).json({ error: "Impossible de répondre pour l'instant." });
  }
});

// Filet de sécurité pour les routes API : si une erreur passe jusqu'ici (au
// lieu d'un crash du serveur), on répond juste "Erreur serveur" proprement.
app.use((err, req, res, next) => {
  console.error("Erreur dans une route API :", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Erreur serveur. Réessaie dans un instant." });
});

// ==================== NOTIFICATIONS COMPORTEMENTALES (EMAIL) ====================
// Fonctionne uniquement par email (via Brevo, déjà configuré) — pour les
// acheteurs inscrits par téléphone, pas de notification tant que le SMS
// n'est pas actif (Twilio bloqué / Africa's Talking pas encore configuré).
function looksLikeEmail(identifier) {
  return typeof identifier === "string" && identifier.includes("@");
}
// Anti-spam : pas plus d'une notification d'un type donné par acheteur toutes les 24h.
async function canNotify(buyerPhone, type) {
  const { rows } = await pool.query(
    "SELECT 1 FROM notification_log WHERE buyer_phone = $1 AND type = $2 AND sent_at > $3 LIMIT 1",
    [buyerPhone, type, Date.now() - 24 * 60 * 60 * 1000]
  );
  return rows.length === 0;
}
async function logNotification(buyerPhone, type, referenceId) {
  await pool.query(
    "INSERT INTO notification_log (id, buyer_phone, type, reference_id, sent_at) VALUES ($1,$2,$3,$4,$5)",
    [uid(), buyerPhone, type, referenceId || null, Date.now()]
  );
}

// Marque qu'un acheteur a vu un produit — utilisé plus tard pour la relance.
app.post("/api/products/:id/view", async (req, res) => {
  const tokenPhone = await getTokenPhone(req);
  if (!tokenPhone) return res.json({ ok: true }); // navigation anonyme : rien à suivre, pas une erreur
  await pool.query(
    "INSERT INTO product_views (id, buyer_phone, product_id, viewed_at) VALUES ($1,$2,$3,$4)",
    [uid(), tokenPhone, req.params.id, Date.now()]
  );
  res.json({ ok: true });
});

// ---- Favoris ----
app.get("/api/favorites/:phone", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT product_id FROM favorites WHERE buyer_phone = $1", [req.params.phone]);
  res.json(rows.map((r) => r.product_id));
});
app.post("/api/favorites", requirePhone((req) => req.body.phone), async (req, res) => {
  const { phone, productId } = req.body;
  const { rows } = await pool.query("SELECT price FROM products WHERE id = $1", [productId]);
  if (!rows[0]) return res.status(404).json({ error: "Produit introuvable." });
  await pool.query(
    "INSERT INTO favorites (buyer_phone, product_id, last_known_price, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (buyer_phone, product_id) DO NOTHING",
    [phone, productId, rows[0].price, Date.now()]
  );
  res.json({ ok: true });
});
app.delete("/api/favorites/:productId", requirePhone((req) => req.body.phone), async (req, res) => {
  await pool.query("DELETE FROM favorites WHERE buyer_phone = $1 AND product_id = $2", [req.body.phone, req.params.productId]);
  res.json({ ok: true });
});

// ---- Suivi de catégories ----
app.get("/api/category-follows/:phone", requirePhone((req) => req.params.phone), async (req, res) => {
  const { rows } = await pool.query("SELECT category FROM category_follows WHERE buyer_phone = $1", [req.params.phone]);
  res.json(rows.map((r) => r.category));
});
app.post("/api/category-follows", requirePhone((req) => req.body.phone), async (req, res) => {
  const { phone, category } = req.body;
  await pool.query(
    "INSERT INTO category_follows (buyer_phone, category, created_at) VALUES ($1,$2,$3) ON CONFLICT (buyer_phone, category) DO NOTHING",
    [phone, category, Date.now()]
  );
  res.json({ ok: true });
});
app.delete("/api/category-follows/:category", requirePhone((req) => req.body.phone), async (req, res) => {
  await pool.query("DELETE FROM category_follows WHERE buyer_phone = $1 AND category = $2", [req.body.phone, req.params.category]);
  res.json({ ok: true });
});

// Vérifie toutes les heures : relances "vu mais pas acheté" (3 jours) et
// baisses de prix sur les favoris. Le suivi de catégorie, lui, est
// déclenché directement à la publication d'un produit (pas besoin d'attendre).
const VIEW_REMINDER_DELAY_MS = 3 * 24 * 60 * 60 * 1000; // 3 jours
async function processFavoritesAndViewReminders() {
  try {
    // Relance "vu mais pas acheté"
    const { rows: staleViews } = await pool.query(
      `SELECT v.id, v.buyer_phone, v.product_id, p.name, p.price, p.image_url
       FROM product_views v JOIN products p ON p.id = v.product_id
       WHERE v.reminded = false AND v.viewed_at < $1`,
      [Date.now() - VIEW_REMINDER_DELAY_MS]
    );
    for (const v of staleViews) {
      await pool.query("UPDATE product_views SET reminded = true WHERE id = $1", [v.id]);
      if (!looksLikeEmail(v.buyer_phone)) continue;
      const { rows: alreadyOrdered } = await pool.query(
        "SELECT 1 FROM orders WHERE buyer_phone = $1 AND items @> $2::jsonb LIMIT 1",
        [v.buyer_phone, JSON.stringify([{ id: v.product_id }])]
      );
      if (alreadyOrdered.length) continue;
      if (!(await canNotify(v.buyer_phone, "view_reminder"))) continue;
      const priceTxt = Number(v.price).toLocaleString("fr-FR");
      await sendEmail(
        v.buyer_phone,
        `Toujours envie de "${v.name}" ?`,
        `Tu as regardé "${v.name}" (${priceTxt} F) sur Zonako il y a quelques jours — il est toujours disponible si tu veux le commander.\n\nzonabo-app.onrender.com`,
        productEmailHtml({ heading: `Toujours envie de "${v.name}" ?`, imageUrl: v.image_url, bodyHtml: `Tu as regardé cet article (<strong>${priceTxt} F</strong>) sur Zonako il y a quelques jours — il est toujours disponible si tu veux le commander.` })
      );
      await logNotification(v.buyer_phone, "view_reminder", v.product_id);
    }
    // Baisse de prix sur un favori
    const { rows: favs } = await pool.query(
      `SELECT f.buyer_phone, f.product_id, f.last_known_price, p.name, p.price, p.image_url
       FROM favorites f JOIN products p ON p.id = f.product_id
       WHERE p.price < f.last_known_price`
    );
    for (const f of favs) {
      await pool.query("UPDATE favorites SET last_known_price = $1 WHERE buyer_phone = $2 AND product_id = $3", [f.price, f.buyer_phone, f.product_id]);
      if (!looksLikeEmail(f.buyer_phone)) continue;
      if (!(await canNotify(f.buyer_phone, "price_drop"))) continue;
      const oldTxt = Number(f.last_known_price).toLocaleString("fr-FR");
      const newTxt = Number(f.price).toLocaleString("fr-FR");
      await sendEmail(
        f.buyer_phone,
        `Baisse de prix sur "${f.name}" !`,
        `Bonne nouvelle : "${f.name}" est passé de ${oldTxt} F à ${newTxt} F sur Zonako.\n\nzonabo-app.onrender.com`,
        productEmailHtml({ heading: `Baisse de prix sur "${f.name}" !`, imageUrl: f.image_url, bodyHtml: `Bonne nouvelle : cet article est passé de <s>${oldTxt} F</s> à <strong>${newTxt} F</strong> sur Zonako.` })
      );
      await logNotification(f.buyer_phone, "price_drop", f.product_id);
    }
  } catch (e) {
    console.error("Erreur pendant les notifications comportementales:", e);
  }
}

// Nouveauté dans une catégorie suivie — déclenché directement à la publication.
async function notifyCategoryFollowers(category, productId, productName, vendorName, imageUrl) {
  try {
    const { rows: followers } = await pool.query("SELECT buyer_phone FROM category_follows WHERE category = $1", [category]);
    for (const f of followers) {
      if (!looksLikeEmail(f.buyer_phone)) continue;
      if (!(await canNotify(f.buyer_phone, "category_new_product"))) continue;
      await sendEmail(
        f.buyer_phone,
        `Nouveau dans ${category} sur Zonako`,
        `${vendorName} vient de publier "${productName}" dans la catégorie ${category} que tu suis.\n\nzonabo-app.onrender.com`,
        productEmailHtml({ heading: `Nouveau dans ${category}`, imageUrl, bodyHtml: `<strong>${vendorName}</strong> vient de publier "${productName}" dans la catégorie ${category} que tu suis.` })
      );
      await logNotification(f.buyer_phone, "category_new_product", productId);
    }
  } catch (e) {
    console.error("Erreur pendant la notification de suivi de catégorie:", e);
  }
}

// Alerte au vendeur quand le stock d'un produit devient bas — évite de
// vendre un article qu'il n'a plus. Envoyée une seule fois par produit tant
// que le stock reste bas (pas à chaque commande).
const LOW_STOCK_THRESHOLD = 3;
async function checkLowStockAndNotify(productId) {
  const { rows } = await pool.query("SELECT name, stock, vendor_phone, vendor_name FROM products WHERE id = $1", [productId]);
  const p = rows[0];
  if (!p || Number(p.stock) > LOW_STOCK_THRESHOLD) return;
  if (!looksLikeEmail(p.vendor_phone)) return; // email uniquement pour l'instant, pas de SMS actif
  if (!(await canNotify(p.vendor_phone, `low_stock_${productId}`))) return;
  const stockTxt = Number(p.stock) === 0 ? "en rupture de stock" : `plus que ${p.stock} en stock`;
  await sendEmail(
    p.vendor_phone,
    `Stock bas : "${p.name}"`,
    `Ton produit "${p.name}" est ${stockTxt} sur Zonako. Pense à le réapprovisionner ou à ajuster ton annonce.\n\nzonabo-app.onrender.com`,
    productEmailHtml({ heading: `Stock bas sur "${p.name}"`, bodyHtml: `Ton produit est <strong>${stockTxt}</strong> — pense à le réapprovisionner ou à ajuster ton annonce.`, ctaText: "Gérer mes produits" })
  );
  await logNotification(p.vendor_phone, `low_stock_${productId}`, productId);
}

// ==================== Frontend statique ====================
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Le schéma DOIT être entièrement prêt avant d'accepter le moindre visiteur —
// sinon une requête peut arriver pile pendant la mise à jour de la base et
// planter sur une colonne "pas encore ajoutée" (ça nous est déjà arrivé).
ensureSchema().then(() => {
  app.listen(PORT, () => console.log(`Zonako backend en écoute sur le port ${PORT}`));
  // Vérifie toutes les heures s'il y a des livraisons à confirmer automatiquement.
  autoConfirmStaleDeliveries();
  setInterval(autoConfirmStaleDeliveries, 60 * 60 * 1000);
  // Vérifie toutes les heures les relances "vu mais pas acheté" et baisses de prix.
  processFavoritesAndViewReminders();
  setInterval(processFavoritesAndViewReminders, 60 * 60 * 1000);
});
