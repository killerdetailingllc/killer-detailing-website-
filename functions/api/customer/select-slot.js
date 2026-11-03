import { json, sha256, sameOrigin } from "../../_utils.js";
import { buildBusinessSlots, easternDayBounds, overlaps, ensureSlotClaimsTable, releaseExpiredSlotClaims, getSlotClaims, claimAppointmentSlot } from "../../_availability.js";
import { getICloudBusyIntervals } from "../../_icloud.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Choose an appointment time." }, 400); }
  const rawToken = String(body.token || "");
  if (rawToken.length < 30 || rawToken.length > 100) return json({ error: "This estimate link is not valid." }, 404);
  const row = await env.DB.prepare(`SELECT id, status, estimate_expires_at, appointment_duration_minutes, stripe_session_id FROM estimate_requests WHERE estimate_token_hash = ?`).bind(await sha256(rawToken)).first();
  if (!row) return json({ error: "This estimate link is not valid." }, 404);
  if (row.status !== "accepted") return json({ error: "Accept the estimate before choosing an appointment time." }, 409);
  if (row.estimate_expires_at && row.estimate_expires_at < new Date().toISOString()) return json({ error: "This estimate link has expired." }, 410);
  const startsAt = new Date(String(body.appointmentAt || ""));
  if (!Number.isFinite(startsAt.getTime())) return json({ error: "Choose an available appointment time." }, 400);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(startsAt);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const lastDay = new Date(`${today}T12:00:00Z`); lastDay.setUTCDate(lastDay.getUTCDate() + 60);
  if (date < today || date > lastDay.toISOString().slice(0, 10)) return json({ error: "Choose an appointment date from today through the next 60 days." }, 400);
  const slots = buildBusinessSlots(date, row.appointment_duration_minutes);
  const slot = slots.find((item) => item.startsAt === startsAt.toISOString());
  if (!slot) return json({ error: "That time does not fit the service duration or business hours. Choose another time." }, 400);
  const bounds = easternDayBounds(date);
  const busy = await getICloudBusyIntervals(env, bounds.start, bounds.end);
  if (!busy.ok) return json({ error: "We can't verify the calendar right now. Please try again shortly." }, 503);
  if (busy.intervals.some((interval) => overlaps(slot.startsAt, slot.endsAt, interval.start, interval.end))) return json({ error: "That time is no longer available. Refresh the times and choose another." }, 409);
  await ensureSlotClaimsTable(env.DB);
  await releaseExpiredSlotClaims(env.DB);
  const claims = await getSlotClaims(env.DB, bounds.start, bounds.end, new Date().toISOString(), row.id);
  if (slot.blocks.some((block) => claims.includes(block))) return json({ error: "That time is being held by another customer. Refresh the times and choose another." }, 409);
  const booked = await env.DB.prepare(`SELECT appointment_at, appointment_duration_minutes FROM estimate_requests WHERE status = 'booked' AND appointment_at >= ? AND appointment_at < ?`).bind(bounds.start.toISOString(), bounds.end.toISOString()).all();
  if ((booked.results || []).some((item) => overlaps(slot.startsAt, slot.endsAt, item.appointment_at, new Date(new Date(item.appointment_at).getTime() + Number(item.appointment_duration_minutes || 120) * 60000)))) return json({ error: "That time is no longer available. Refresh the times and choose another." }, 409);
  if (row.stripe_session_id) {
    if (!env.STRIPE_SECRET_KEY) return json({ error: "We can't verify the current checkout. Please contact Killer Detailing before changing the time." }, 503);
    const stripeUrl = "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(row.stripe_session_id);
    const lookup = await fetch(stripeUrl, { headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
    const session = await lookup.json().catch(() => ({}));
    if (!lookup.ok) return json({ error: "We couldn't verify checkout. Please try again." }, 502);
    if (session.status === "complete" || session.payment_status === "paid") return json({ error: "Payment is processing. Refresh this page before changing the appointment." }, 409);
    if (session.status === "open") {
      const expired = await fetch(stripeUrl + "/expire", { method: "POST", headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
      if (!expired.ok) return json({ error: "The existing checkout could not be closed. Please try again or contact the business." }, 409);
    }
  }
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  try {
    if (!await claimAppointmentSlot(env.DB, row.id, slot, expiresAt)) return json({ error: "The estimate status changed. Refresh the page to continue." }, 409);
  } catch {
    return json({ error: "That time was just selected by someone else. Refresh the available times and choose another." }, 409);
  }
  return json({ ok: true, appointmentAt: slot.startsAt, expiresAt });
}
