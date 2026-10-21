import { isAdmin, json, token, sha256 } from "../../_utils.js";
import { sendEmail, money } from "../../_email.js";

export async function onRequestPost({ request, env, waitUntil }) {
  if (!await isAdmin(request, env)) return json({ error: "Please sign in again." }, 401);
  if (!request.headers.get("Origin") || request.headers.get("Origin") !== new URL(request.url).origin) return json({ error: "Request origin could not be verified." }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Estimate details are missing." }, 400); }
  const total = String(body.total || "").trim();
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(total)) return json({ error: "Enter a valid estimate amount." }, 400);
  const cents = Math.round(Number(total) * 100);
  if (cents < 100 || cents > 100000000) return json({ error: "The estimate must be between $1 and $1,000,000." }, 400);
  const note = String(body.note || "").trim().slice(0, 2000);
  const id = String(body.id || "");
  const record = await env.DB.prepare("SELECT status, name, email, year, make, model, vehicle_type FROM estimate_requests WHERE id = ?").bind(id).first();
  if (!record || !["pending", "estimate_sent"].includes(record.status)) return json({ error: "This request can no longer receive an estimate." }, 409);
  const rawToken = token();
  const tokenHash = await sha256(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const deposit = Math.round(cents * 0.25);
  await env.DB.prepare(`UPDATE estimate_requests SET status = 'estimate_sent', estimate_cents = ?, deposit_cents = ?, estimate_note = ?, estimate_token_hash = ?, estimate_expires_at = ? WHERE id = ?`)
    .bind(cents, deposit, note, tokenHash, expiresAt, id).run();
  const url = new URL("/estimate.html", request.url);
  url.searchParams.set("token", rawToken);
  if (env.RESEND_API_KEY && env.EMAIL_FROM && record.email) {
    const depositText = money(deposit);
    const message = `Hello ${record.name},\n\nYour custom estimate is ready.\n\nVehicle: ${record.year} ${record.make} ${record.model} (${record.vehicle_type})\nEstimate: ${money(cents)}\nDeposit to confirm: ${depositText}\n${note ? `\nNote from the detailer: ${note}\n` : "\n"}\nReview and accept your estimate here: ${url}\n\nThe booking is confirmed only after the deposit payment succeeds.`;
    const task = sendEmail(env, { to: record.email, subject: "Your Killer Detailing estimate is ready", text: message });
    if (waitUntil) waitUntil(task);
  }
  return json({ ok: true, url: url.toString(), expiresAt, estimateCents: cents, depositCents: deposit });
}
