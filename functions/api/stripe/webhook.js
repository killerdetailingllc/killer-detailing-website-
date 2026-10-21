import { json } from "../../_utils.js";
import { sendEmail, money } from "../../_email.js";

function toHex(bytes) { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

async function validSignature(raw, header, secret) {
  const parts = header.split(",").map((item) => item.split("=", 2));
  const timestampText = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  const timestamp = Number(timestampText);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300 || !signatures.length) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestampText}.${raw}`)));
  return signatures.some((signature) => {
    let difference = signature.length ^ digest.length;
    for (let index = 0; index < Math.max(signature.length, digest.length); index++) difference |= (signature.charCodeAt(index) || 0) ^ (digest.charCodeAt(index) || 0);
    return difference === 0;
  });
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.DB) return json({ error: "Webhook is not configured." }, 503);
  const raw = await request.text();
  const signature = request.headers.get("stripe-signature") || "";
  if (!await validSignature(raw, signature, env.STRIPE_WEBHOOK_SECRET)) return json({ error: "Invalid signature." }, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "Invalid event." }, 400); }
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return json({ received: true });
  const session = event.data?.object;
  if (!session || session.mode !== "payment" || session.payment_status !== "paid" || session.currency !== "usd") return json({ received: true });
  const id = session.metadata?.request_id;
  const deposit = Number(session.metadata?.deposit_cents);
  if (!id || !Number.isSafeInteger(deposit) || session.amount_total !== deposit) return json({ error: "Payment metadata did not match." }, 400);
  const row = await env.DB.prepare("SELECT status, stripe_session_id, deposit_cents, name, email, year, make, model, vehicle_type FROM estimate_requests WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "Estimate request not found." }, 404);
  if (row.status === "booked" && row.stripe_session_id === session.id) return json({ received: true });
  if (row.status !== "accepted" || row.stripe_session_id !== session.id || row.deposit_cents !== deposit) return json({ error: "Payment does not match the accepted estimate." }, 409);
  await env.DB.prepare("UPDATE estimate_requests SET status = 'booked', paid_at = ? WHERE id = ? AND status = 'accepted' AND stripe_session_id = ? AND deposit_cents = ?")
    .bind(new Date().toISOString(), id, session.id, deposit).run();
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    const vehicle = `${row.year} ${row.make} ${row.model} (${row.vehicle_type})`;
    const message = `The 25% deposit payment succeeded and the booking is confirmed.\n\nCustomer: ${row.name}\nEmail: ${row.email}\nVehicle: ${vehicle}\nDeposit paid: ${money(deposit)}\n\nThe booking was confirmed by the verified Stripe payment webhook.`;
    const tasks = [sendEmail(env, { to: row.email, subject: "Your Killer Detailing booking is confirmed", text: message })];
    if (env.OWNER_NOTIFICATION_EMAIL) tasks.push(sendEmail(env, { to: env.OWNER_NOTIFICATION_EMAIL, subject: `Deposit paid — booking confirmed: ${row.name}`, text: message }));
    if (waitUntil) waitUntil(Promise.all(tasks));
  }
  return json({ received: true });
}
