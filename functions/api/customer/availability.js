import { json, sha256 } from "../../_utils.js";
import { buildBusinessSlots, easternDayBounds, overlaps, displayEasternTime, ensureSlotClaimsTable, releaseExpiredSlotClaims, getSlotClaims } from "../../_availability.js";
import { getICloudBusyIntervals } from "../../_icloud.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const rawToken = url.searchParams.get("token") || "";
  const date = url.searchParams.get("date") || "";
  if (rawToken.length < 30 || rawToken.length > 100) return json({ error: "This estimate link is not valid." }, 404);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Choose a valid calendar date." }, 400);
  const row = await env.DB.prepare(`SELECT id, status, estimate_expires_at, appointment_duration_minutes FROM estimate_requests WHERE estimate_token_hash = ?`).bind(await sha256(rawToken)).first();
  if (!row) return json({ error: "This estimate link is not valid." }, 404);
  if (row.status !== "accepted") return json({ error: "Accept the estimate before choosing an appointment time." }, 409);
  if (row.estimate_expires_at && row.estimate_expires_at < new Date().toISOString()) return json({ error: "This estimate link has expired. Please contact the business." }, 410);
  const bounds = easternDayBounds(date);
  if (!Number.isFinite(bounds.start.getTime()) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return json({ error: "Choose a valid calendar date." }, 400);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const lastDay = new Date(`${today}T12:00:00Z`); lastDay.setUTCDate(lastDay.getUTCDate() + 60);
  if (!bounds.start || bounds.start.getTime() < easternDayBounds(today).start.getTime() || date > lastDay.toISOString().slice(0, 10)) return json({ error: "Choose a date from today through the next 60 days." }, 400);
  const slots = buildBusinessSlots(date, row.appointment_duration_minutes);
  if (!slots.length) return json({ date, slots: [] });
  const busy = await getICloudBusyIntervals(env, bounds.start, bounds.end);
  if (!busy.ok) return json({ error: "We can't verify the calendar right now, so appointment times are temporarily unavailable. Please try again shortly or contact the business." }, 503);
  await ensureSlotClaimsTable(env.DB);
  await releaseExpiredSlotClaims(env.DB);
  const claims = await getSlotClaims(env.DB, bounds.start, bounds.end, new Date().toISOString(), row.id);
  const claimed = new Set(claims);
  const { results: bookedRows } = await env.DB.prepare(`SELECT appointment_at, appointment_duration_minutes FROM estimate_requests
    WHERE status = 'booked' AND appointment_at >= ? AND appointment_at < ?`).bind(bounds.start.toISOString(), bounds.end.toISOString()).all();
  const booked = bookedRows || [];
  const available = slots.filter((slot) => {
    if (slot.blocks.some((block) => claimed.has(block))) return false;
    if (busy.intervals.some((interval) => overlaps(slot.startsAt, slot.endsAt, interval.start, interval.end))) return false;
    if (booked.some((item) => overlaps(slot.startsAt, slot.endsAt, item.appointment_at, new Date(new Date(item.appointment_at).getTime() + Number(item.appointment_duration_minutes || 120) * 60000)))) return false;
    return true;
  }).map((slot) => ({ startsAt: slot.startsAt, label: `${displayEasternTime(slot.startsAt)} – ${displayEasternTime(slot.endsAt)} Eastern` }));
  return json({ date, slots: available });
}
