import { json, sameOrigin, sessionCookie, sha256 } from "../../_utils.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  if (!env.DB || !env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) return json({ error: "Owner access is not configured yet." }, 503);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(`${env.ADMIN_SESSION_SECRET}:${ip}`);
  const now = Math.floor(Date.now() / 1000);
  const attempt = await env.DB.prepare("SELECT window_started_at, attempts FROM admin_login_attempts WHERE ip_hash = ?").bind(ipHash).first();
  if (attempt && attempt.window_started_at > now - 600 && attempt.attempts >= 5) return json({ error: "Too many attempts. Please wait ten minutes and try again." }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Enter the owner password." }, 400); }
  const provided = new TextEncoder().encode(String(body.password || ""));
  const expected = new TextEncoder().encode(env.ADMIN_PASSWORD);
  let matches = provided.length === expected.length;
  for (let i = 0; i < Math.max(provided.length, expected.length); i++) matches = (provided[i] || 0) === (expected[i] || 0) && matches;
  if (!matches) {
    await env.DB.prepare(`INSERT INTO admin_login_attempts (ip_hash, window_started_at, attempts) VALUES (?, ?, 1)
      ON CONFLICT(ip_hash) DO UPDATE SET attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
      window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END`)
      .bind(ipHash, now, now - 600, now - 600, now).run();
    return json({ error: "The owner password was not recognized." }, 401);
  }
  await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip_hash = ?").bind(ipHash).run();
  return json({ ok: true }, 200, { "set-cookie": await sessionCookie(env.ADMIN_SESSION_SECRET) });
}

export async function onRequestDelete({ request }) {
  if (!sameOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  return json({ ok: true }, 200, { "set-cookie": "kd_admin=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
}
