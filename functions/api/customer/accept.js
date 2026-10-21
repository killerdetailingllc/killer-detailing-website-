import { json, sha256, sameOrigin } from "../../_utils.js";
import { sendEmail, money } from "../../_email.js";

export async function onRequestPost({ request, env, waitUntil }) {
  if (!sameOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "This estimate link is not valid." }, 400); }
  const rawToken = String(body.token || "");
  const hash = await sha256(rawToken);
  const row = await env.DB.prepare("SELECT id, status, estimate_expires_at, name, email, estimate_cents, deposit_cents FROM estimate_requests WHERE estimate_token_hash = ?").bind(hash).first();
  if (!row) return json({ error: "This estimate link is not valid or has expired." }, 404);
  if (row.status === "booked") return json({ ok: true, status: "booked" });
  if (row.status === "accepted") return json({ ok: true, status: "accepted" });
  if (row.status !== "estimate_sent" || (row.estimate_expires_at && row.estimate_expires_at < new Date().toISOString())) return json({ error: "This estimate can no longer be accepted." }, 409);
  await env.DB.prepare("UPDATE estimate_requests SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'estimate_sent'").bind(new Date().toISOString(), row.id).run();
  if (env.OWNER_NOTIFICATION_EMAIL && env.RESEND_API_KEY && env.EMAIL_FROM) {
    const message = `A customer accepted the estimate for ${row.name}.\n\nApproved estimate: ${money(row.estimate_cents)}\n25% deposit due: ${money(row.deposit_cents)}\nCustomer: ${row.email}\n\nThe customer must still complete Stripe checkout. The booking is not confirmed until Stripe verifies successful payment.`;
    const task = sendEmail(env, { to: env.OWNER_NOTIFICATION_EMAIL, subject: `Estimate accepted: ${row.name}`, text: message });
    if (waitUntil) waitUntil(task);
  }
  return json({ ok: true, status: "accepted" });
}
