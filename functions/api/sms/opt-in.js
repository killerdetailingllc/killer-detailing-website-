import { json, sha256 } from "../../_utils.js";
import { sendOwnerSms } from "../../_sms.js";

function normalizePhone(value) {
  const input = String(value || "").trim();
  const digits = input.replace(/\D/g, "");
  if (input.startsWith("+") && /^\+\d{8,15}$/.test(`+${digits}`)) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("Origin") || request.headers.get("Origin") !== new URL(request.url).origin) {
    return json({ error: "Request origin could not be verified." }, 403);
  }
  if (!env.DB || !env.ADMIN_SESSION_SECRET || !env.OWNER_NOTIFICATION_PHONE) {
    return json({ error: "Text alert sign-up is not available yet." }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Please submit the form again." }, 400); }
  const phone = normalizePhone(body.phone);
  const ownerPhone = normalizePhone(env.OWNER_NOTIFICATION_PHONE);
  if (!phone || !ownerPhone || phone !== ownerPhone) {
    return json({ error: "Enter the owner alert phone number configured for this business." }, 400);
  }
  if (body.smsConsent !== true) return json({ error: "Please check the text alert consent box to continue." }, 400);
  if (String(body.website || "").trim()) return json({ ok: true }, 202);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sms_optin_limits (
    ip_hash TEXT PRIMARY KEY,
    window_started_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sms_owner_consents (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phone TEXT NOT NULL,
    consented_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'web'
  )`).run();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(`${env.ADMIN_SESSION_SECRET}:sms-optin:${ip}`);
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare("SELECT window_started_at, attempts FROM sms_optin_limits WHERE ip_hash = ?").bind(ipHash).first();
  if (existing && existing.window_started_at > now - 3600 && existing.attempts >= 3) {
    return json({ error: "Please wait before submitting again." }, 429);
  }
  await env.DB.prepare(`INSERT INTO sms_optin_limits (ip_hash, window_started_at, attempts) VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
    window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END`)
    .bind(ipHash, now, now - 3600, now - 3600, now).run();
  await env.DB.prepare(`INSERT INTO sms_owner_consents (id, phone, consented_at, active, source)
    VALUES (1, ?, ?, 1, 'web') ON CONFLICT(id) DO UPDATE SET phone = excluded.phone,
    consented_at = excluded.consented_at, active = 1, source = 'web'`)
    .bind(phone, new Date().toISOString()).run();
  const confirmed = await sendOwnerSms(env, "Killer Detailing LLC: You are subscribed to owner account alerts. Message frequency varies. Reply STOP to opt out or HELP for help. Message and data rates may apply.");
  if (!confirmed) {
    return json({ ok: true, message: "Your consent was recorded. The confirmation text could not be sent yet; alerts will begin once SMS is approved and enabled." });
  }
  return json({ ok: true, message: "Your text alert consent was recorded and a confirmation text was sent." });
}
