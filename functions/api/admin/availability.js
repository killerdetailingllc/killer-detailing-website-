import { isAdmin, json } from "../../_utils.js";
import { buildBusinessSlots, displayEasternTime, ensureSlotClaimsTable, getSlotClaims, easternDayBounds, overlaps } from "../../_availability.js";
import { getICloudBusyIntervals } from "../../_icloud.js";

export async function onRequestGet({ request, env }) {
  if (!await isAdmin(request, env)) return json({ error: "Please sign in again." }, 401);
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || "";
  const id = url.searchParams.get("id") || "";
  const requestRow = await env.DB.prepare("SELECT status, appointment_duration_minutes, appointment_at FROM estimate_requests WHERE id = ?").bind(id).first();
  if (!requestRow || requestRow.status !== "booked") return json({ error: "Only a confirmed appointment can be rescheduled." }, 409);
  const dateCheck = new Date(`${date}T12:00:00Z`);
  const todayText = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const today = new Date(`${todayText}T12:00:00Z`);
  if (!Number.isFinite(dateCheck.getTime()) || dateCheck < today || dateCheck > new Date(today.getTime() + 60 * 86400000)) return json({ error: "Choose a date within the next 60 days." }, 400);
  const slots = buildBusinessSlots(date, requestRow.appointment_duration_minutes);
  const bounds = easternDayBounds(date);
  const busy = await getICloudBusyIntervals(env, bounds.start, bounds.end);
  if (!busy.ok) return json({ error: `Could not verify iCloud availability: ${busy.reason}` }, 503);
  const calendarBusy = busy.intervals.filter((interval) => interval.uid !== `${id}@killerdetailingllc.com`);
  await ensureSlotClaimsTable(env.DB);
  const claims = await getSlotClaims(env.DB, bounds.start, bounds.end, new Date().toISOString(), id);
  const rows = await env.DB.prepare("SELECT id, appointment_at, appointment_duration_minutes FROM estimate_requests WHERE status = 'booked' AND id != ? AND appointment_at >= ? AND appointment_at < ?").bind(id, bounds.start.toISOString(), bounds.end.toISOString()).all();
  const existing = rows.results || [];
  const available = slots.filter((slot) => !claims.some((claim) => slot.blocks.includes(claim))
    && !calendarBusy.some((interval) => overlaps(slot.startsAt, slot.endsAt, interval.start, interval.end))
    && !existing.some((row) => overlaps(slot.startsAt, slot.endsAt, row.appointment_at, new Date(new Date(row.appointment_at).getTime() + Number(row.appointment_duration_minutes) * 60000))));
  return json({ slots: available.map((slot) => ({ startsAt: slot.startsAt, label: `${new Date(slot.startsAt).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" })} · ${displayEasternTime(slot.startsAt)}` })) });
}
