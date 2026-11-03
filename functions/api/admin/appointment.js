import { isAdmin, json, sameOrigin, uuid, displayServiceNames } from "../../_utils.js";
import { sendEmail, money } from "../../_email.js";
import { updateICloudEvent, deleteICloudEvent, getICloudBusyIntervals } from "../../_icloud.js";
import { buildBusinessSlots, displayEasternTime, easternDayBounds, ensureSlotClaimsTable, ensureAppointmentEventsTable, getSlotClaims, overlaps, moveConfirmedAppointmentSlot, updateAppointmentStatus } from "../../_availability.js";

export async function onRequestPost({ request, env, waitUntil }) {
  if (!await isAdmin(request, env)) return json({ error: "Please sign in again." }, 401);
  if (!sameOrigin(request)) return json({ error: "Request origin could not be verified." }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Appointment action is missing." }, 400); }
  const id = String(body.id || "");
  const action = String(body.action || "");
  const row = await env.DB.prepare(`SELECT id,status,name,email,phone,year,make,model,vehicle_type,service_address,services_json,addons_json,
    estimate_cents,deposit_cents,paid_at,stripe_session_id,appointment_at,appointment_duration_minutes,calendar_event_uid FROM estimate_requests WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Appointment not found." }, 404);
  await ensureSlotClaimsTable(env.DB);
  await ensureAppointmentEventsTable(env.DB);
  let responseNote = "";

  if (action === "reschedule") {
    if (row.status !== "booked" || !row.appointment_at) return json({ error: "Only a confirmed appointment with a scheduled time can be rescheduled." }, 409);
    const startsAt = String(body.appointmentAt || "");
    const date = startsAt.slice(0, 10);
    const dateCheck = new Date(`${date}T12:00:00Z`);
    const todayText = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const today = new Date(`${todayText}T12:00:00Z`);
    if (!Number.isFinite(dateCheck.getTime()) || dateCheck < today || dateCheck > new Date(today.getTime() + 60 * 86400000)) return json({ error: "Choose a date within the next 60 days." }, 400);
    const slots = buildBusinessSlots(date, row.appointment_duration_minutes);
    const slot = slots.find((item) => item.startsAt === startsAt);
    if (!slot) return json({ error: "That time is outside business hours or no longer available. Pick a new time." }, 409);
    const bounds = easternDayBounds(date);
    const busy = await getICloudBusyIntervals(env, bounds.start, bounds.end);
    if (!busy.ok) return json({ error: `Could not verify iCloud availability: ${busy.reason}` }, 503);
    const calendarBusy = busy.intervals.filter((interval) => interval.uid !== `${id}@killerdetailingllc.com`);
    if (calendarBusy.some((interval) => overlaps(slot.startsAt, slot.endsAt, interval.start, interval.end))) return json({ error: "That time conflicts with your iCloud calendar. Choose another time." }, 409);
    const claims = await getSlotClaims(env.DB, bounds.start, bounds.end, new Date().toISOString(), id);
    if (claims.some((claim) => slot.blocks.includes(claim))) return json({ error: "That time was just booked by another request. Choose another time." }, 409);
    const otherBookings = await env.DB.prepare("SELECT appointment_at, appointment_duration_minutes FROM estimate_requests WHERE status = 'booked' AND id != ? AND appointment_at >= ? AND appointment_at < ?").bind(id, bounds.start.toISOString(), bounds.end.toISOString()).all();
    if ((otherBookings.results || []).some((other) => overlaps(slot.startsAt, slot.endsAt, other.appointment_at, new Date(new Date(other.appointment_at).getTime() + Number(other.appointment_duration_minutes) * 60000)))) return json({ error: "That time conflicts with another confirmed appointment." }, 409);

    const booking = calendarBooking(row, row.appointment_at);
    const calendarResult = await updateICloudEvent(env, calendarBooking(row, slot.startsAt));
    if (!calendarResult.ok) return json({ error: `The appointment was not moved because iCloud could not be updated: ${calendarResult.reason}` }, 503);
    try {
      const changed = await moveConfirmedAppointmentSlot(env.DB, id, slot);
      if (!changed) throw new Error("The appointment status changed before it could be rescheduled.");
    } catch {
      const restored = await updateICloudEvent(env, booking);
      return json({ error: restored.ok ? "The appointment could not be saved. Its iCloud event was restored; please retry." : "The appointment could not be saved and iCloud restoration failed. Please check the calendar." }, 409);
    }
    await env.DB.prepare("UPDATE estimate_requests SET calendar_event_uid = ? WHERE id = ?").bind(calendarResult.uid, id).run();
    await env.DB.prepare(`INSERT INTO appointment_status_events (id,request_id,event_type,previous_status,new_status,previous_at,new_at,note,created_at)
      VALUES (?,?,'rescheduled','booked','booked',?,?,?,?)`).bind(uuid(), id, row.appointment_at, slot.startsAt, "Owner rescheduled appointment", new Date().toISOString()).run();
    responseNote = `Your appointment has been rescheduled to ${formatEastern(slot.startsAt)}.`;
  } else if (action === "decline") {
    if (!["pending", "estimate_sent"].includes(row.status)) return json({ error: "Only a new or estimated request can be declined." }, 409);
    const changed = await updateAppointmentStatus(env.DB, id, row.status, "declined", { id: uuid(), type: "declined", note: "Declined by owner" });
    if (!changed) return json({ error: "The request changed. Refresh and try again." }, 409);
    responseNote = "Your estimate request was declined. Please contact Killer Detailing if you have questions.";
  } else if (action === "cancel") {
    if (!["accepted", "booked"].includes(row.status)) return json({ error: "Only an accepted or confirmed appointment can be cancelled." }, 409);
    if (row.status === "accepted" && row.stripe_session_id) {
      if (!env.STRIPE_SECRET_KEY) return json({ error: "Stripe checkout must be checked before cancellation. Please configure STRIPE_SECRET_KEY or wait for checkout to finish." }, 503);
      const stripeUrl = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`;
      const lookup = await fetch(stripeUrl, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
      const session = await lookup.json().catch(() => ({}));
      if (!lookup.ok) return json({ error: "Stripe checkout could not be verified; the request was not cancelled." }, 502);
      if (session.status === "complete" || session.payment_status === "paid") return json({ error: "Stripe reports a completed payment. Refresh the desk and cancel the confirmed appointment instead; any deposit refund is handled separately in Stripe." }, 409);
      if (session.status === "open") {
        const expired = await fetch(`${stripeUrl}/expire`, { method: "POST", headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
        if (!expired.ok) return json({ error: "The open Stripe checkout could not be closed; the request was not cancelled." }, 409);
      }
    }
    const changed = await updateAppointmentStatus(env.DB, id, row.status, "cancelled", { id: uuid(), type: "cancelled", previousAt: row.appointment_at, note: "Cancelled by owner" });
    if (!changed) return json({ error: "The appointment changed. Refresh and try again." }, 409);
    if (row.status === "booked" && row.appointment_at) {
      const removed = await deleteICloudEvent(env, id);
      if (removed.ok) await env.DB.prepare("UPDATE estimate_requests SET calendar_event_uid = NULL WHERE id = ?").bind(id).run();
      else responseNote = `The appointment is cancelled, but its iCloud event could not be removed: ${removed.reason}`;
    }
    responseNote ||= row.paid_at ? "The appointment is cancelled. The Stripe deposit was not refunded; handle any refund separately in Stripe." : "The appointment has been cancelled.";
  } else if (action === "complete") {
    if (row.status !== "booked") return json({ error: "Only a confirmed appointment can be marked completed." }, 409);
    const changed = await updateAppointmentStatus(env.DB, id, "booked", "completed", { id: uuid(), type: "completed", previousAt: row.appointment_at, note: "Marked complete by owner" });
    if (!changed) return json({ error: "The appointment changed. Refresh and try again." }, 409);
    responseNote = "Appointment marked completed.";
  } else return json({ error: "Choose a valid appointment action." }, 400);

  const when = row.appointment_at ? formatEastern(action === "reschedule" ? String(body.appointmentAt) : row.appointment_at) : "Not scheduled";
  const services = [...displayServiceNames(JSON.parse(row.services_json)), ...JSON.parse(row.addons_json).map((item) => `Add-on: ${item}`)].join(", ");
  const message = `${responseNote}\n\nAppointment: ${when} Eastern\nCustomer: ${row.name}\nPhone: ${row.phone}\nService address: ${row.service_address}\nVehicle: ${row.year} ${row.make} ${row.model} (${row.vehicle_type})\nServices: ${services}\nEstimate: ${money(row.estimate_cents)}${row.paid_at ? `\nDeposit paid: ${money(row.deposit_cents)}` : ""}`;
  if (env.RESEND_API_KEY && env.EMAIL_FROM && row.email && ["reschedule", "cancel", "decline"].includes(action)) {
    const task = sendEmail(env, { to: row.email, subject: action === "reschedule" ? "Your Killer Detailing appointment was rescheduled" : action === "decline" ? "Update on your Killer Detailing request" : "Your Killer Detailing appointment was cancelled", text: message });
    if (waitUntil) waitUntil(task);
  }
  return json({ ok: true, message: responseNote });
}

function calendarBooking(row, appointmentAt) {
  return { ...row, appointment_at: appointmentAt, services: displayServiceNames(JSON.parse(row.services_json)), addons: JSON.parse(row.addons_json), payment_method: row.paid_at ? "stripe" : "cash" };
}

function formatEastern(value) {
  return new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "full", timeStyle: "short" });
}
