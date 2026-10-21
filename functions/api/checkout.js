import { json, sha256, sameOrigin } from "../_utils.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Online deposits are not configured yet." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "This estimate link is not valid." }, 400); }
  const rawToken = String(body.token || "");
  const row = await env.DB.prepare(`SELECT id, status, deposit_cents, stripe_session_id, checkout_attempt
    FROM estimate_requests WHERE estimate_token_hash = ?`).bind(await sha256(rawToken)).first();
  if (!row) return json({ error: "This estimate link is not valid." }, 404);
  if (row.status === "booked") return json({ booked: true });
  if (row.status !== "accepted") return json({ error: "Accept the estimate before paying the deposit." }, 409);
  if (!row.deposit_cents || row.deposit_cents < 1) return json({ error: "The deposit amount is unavailable." }, 409);

  if (row.stripe_session_id) {
    const existingResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
    if (existingResponse.ok) {
      const existing = await existingResponse.json();
      if (existing.status === "open" && existing.url) return json({ url: existing.url });
      if (existing.status === "complete") return json({ processing: true });
    }
  }

  const tokenHash = await sha256(rawToken);
  const sessionNumber = Number(row.checkout_attempt || 0) + 1;
  const base = new URL(request.url).origin;
  const success = new URL("/estimate.html", base); success.searchParams.set("token", rawToken); success.searchParams.set("checkout", "success");
  const cancel = new URL("/estimate.html", base); cancel.searchParams.set("token", rawToken); cancel.searchParams.set("checkout", "cancel");
  const params = new URLSearchParams({
    mode: "payment", success_url: success.toString(), cancel_url: cancel.toString(), customer_creation: "if_required",
    "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(row.deposit_cents),
    "line_items[0][price_data][product_data][name]": "Killer Detailing approved estimate deposit",
    "line_items[0][quantity]": "1", "metadata[request_id]": row.id,
    "metadata[deposit_cents]": String(row.deposit_cents), "payment_intent_data[metadata][request_id]": row.id,
  });
  const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST", headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `estimate-deposit-${row.id}-${sessionNumber}-${tokenHash.slice(0, 12)}` }, body: params,
  });
  const session = await stripeResponse.json();
  if (!stripeResponse.ok || !session.url) return json({ error: "Stripe could not start checkout. Please try again or contact the business." }, 502);
  await env.DB.prepare("UPDATE estimate_requests SET stripe_session_id = ?, checkout_attempt = ? WHERE id = ? AND status = 'accepted'").bind(session.id, sessionNumber, row.id).run();
  return json({ url: session.url });
}
