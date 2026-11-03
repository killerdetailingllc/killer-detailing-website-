import { json, sha256, sameOrigin, displayServiceNames } from "../../_utils.js";
import { sendEmail, money } from "../../_email.js";
import { createICloudEvent } from "../../_icloud.js";
import { ensureSlotClaimsTable, hasActiveSlotClaim, confirmSlotClaims } from "../../_availability.js";

export async function onRequestPost({ request, env, waitUntil }) {
  if (!sameOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "This estimate link is not valid." }, 400); }
  const rawToken = String(body.token || "");
  if (rawToken.length < 30 || rawToken.length > 100) return json({ error: "This estimate link is not valid." }, 404);
  const row = await env.DB.prepare(`SELECT id, status, stripe_session_id, paid_at, estimate_cents, name, email, phone, year, make, model,
    vehicle_type, service_address, services_json, addons_json, appointment_at, appointment_duration_minutes, calendar_event_uid
    FROM estimate_requests WHERE estimate_token_hash = ?`).bind(await sha256(rawToken)).first();
  if (!row) return json({ error: "This estimate link is not valid." }, 404);
  if (row.status === "booked") {
    if (row.paid_at) return json({ error: "This appointment was already confirmed with an online payment." }, 409);
    return json({ ok: true, status: "booked", paymentMethod: "cash" });
  }
  if (row.status !== "accepted") return json({ error: "Accept the estimate before confirming a cash appointment." }, 409);
  if (!row.appointment_at || !row.service_address) return json({ error: "The selected appointment time or service address is missing. Please contact Killer Detailing." }, 409);
  await ensureSlotClaimsTable(env.DB);
  if (!await hasActiveSlotClaim(env.DB, row.id, row.appointment_at)) return json({ error: "Choose an available appointment time before confirming cash." }, 409);

  // Expire any open online checkout before confirming cash, preventing the same estimate from being paid twice.
  if (row.stripe_session_id) {
    if (!env.STRIPE_SECRET_KEY) return json({ error: "Online checkout must be verified before this appointment can be confirmed. Please contact Killer Detailing." }, 503);
    const stripeUrl = "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(row.stripe_session_id);
    const lookup = await fetch(stripeUrl, { headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
    const session = await lookup.json().catch(() => ({}));
    if (!lookup.ok) return json({ error: "We couldn't verify the online checkout. Please retry or contact Killer Detailing." }, 502);
    if (session.status === "complete" || session.payment_status === "paid") return json({ error: "An online payment is processing. Refresh this page in a moment before choosing cash." }, 409);
    if (session.status === "open") {
      const expired = await fetch(stripeUrl + "/expire", { method: "POST", headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
      if (!expired.ok) return json({ error: "The online checkout could not be closed. Please contact Killer Detailing before confirming cash." }, 409);
    }
  }

  const changed = await env.DB.prepare("UPDATE estimate_requests SET status = 'booked' WHERE id = ? AND status = 'accepted' AND paid_at IS NULL")
    .bind(row.id).run();
  if (!changed.meta?.changes) {
    const latest = await env.DB.prepare("SELECT status, paid_at FROM estimate_requests WHERE id = ?").bind(row.id).first();
    if (latest?.status === "booked" && !latest.paid_at) return json({ ok: true, status: "booked", paymentMethod: "cash" });
    return json({ error: "The booking status changed while confirming cash. Refresh the page to see its current status." }, 409);
  }
  await confirmSlotClaims(env.DB, row.id);

  let calendar = { ok: false, reason: "Calendar credentials are not configured." };
  try {
    const result = await createICloudEvent(env, {
      id: row.id, name: row.name, email: row.email, phone: row.phone, year: row.year, make: row.make, model: row.model,
      vehicle_type: row.vehicle_type, service_address: row.service_address, services: displayServiceNames(JSON.parse(row.services_json)),
      addons: JSON.parse(row.addons_json), estimate_cents: row.estimate_cents, payment_method: "cash",
      appointment_at: row.appointment_at, appointment_duration_minutes: row.appointment_duration_minutes,
    });
    calendar = result;
    if (result.ok) await env.DB.prepare("UPDATE estimate_requests SET calendar_event_uid = ? WHERE id = ? AND calendar_event_uid IS NULL").bind(result.uid, row.id).run();
  } catch { calendar = { ok: false, reason: "The iCloud calendar connection could not be reached." }; }

  const appointment = new Date(row.appointment_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "full", timeStyle: "short" });
  const services = [...displayServiceNames(JSON.parse(row.services_json)), ...JSON.parse(row.addons_json).map((item) => `Add-on: ${item}`)].join(", ");
  const calendarStatus = calendar.ok ? "The appointment was added to the iCloud calendar." : `The appointment is confirmed, but the iCloud calendar entry needs attention: ${calendar.reason}`;
  const message = `The appointment is confirmed with cash payment; no deposit was collected. The full estimate is due at the appointment.\n\nAppointment: ${appointment} Eastern\nDuration: ${row.appointment_duration_minutes / 60} hours\nCustomer: ${row.name}\nEmail: ${row.email}\nPhone: ${row.phone}\nService address: ${row.service_address}\nVehicle: ${row.year} ${row.make} ${row.model} (${row.vehicle_type})\nServices: ${services}\nEstimate due in cash: ${money(row.estimate_cents)}\n\n${calendarStatus}`;
  const tasks = [];
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    tasks.push(sendEmail(env, { to: row.email, subject: "Your Killer Detailing appointment is confirmed", text: message }));
    if (env.OWNER_NOTIFICATION_EMAIL) tasks.push(sendEmail(env, { to: env.OWNER_NOTIFICATION_EMAIL, subject: `Cash appointment confirmed: ${row.name}`, text: message }));
  }
  if (waitUntil && tasks.length) waitUntil(Promise.all(tasks));
  return json({ ok: true, status: "booked", paymentMethod: "cash", calendarAdded: calendar.ok });
}
