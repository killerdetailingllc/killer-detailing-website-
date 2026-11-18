import { BUSINESS_TIME_ZONE, buildBusinessSlots, easternDayBounds, ensureSlotClaimsTable, getSlotClaims, overlaps } from "./_availability.js";
import { getICloudBusyIntervals } from "./_icloud.js";
import { json } from "./_utils.js";

// Before estimating, offer start times with at least an hour free. An estimate sets the actual duration.
export async function onRequestGet({ request, env }) {
  const date = new URL(request.url).searchParams.get("date") || "";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const lastDay = new Date(today + "T12:00:00Z");
  lastDay.setUTCDate(lastDay.getUTCDate() + 60);
  const parsed = new Date(date + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date || date < today || date > lastDay.toISOString().slice(0, 10)) {
    return json({ error: "Choose a date in the next 60 days." }, 400);
  }
  const slots = buildBusinessSlots(date, 60);
  if (!slots.length) return json({ date, times: [] });
  const bounds = easternDayBounds(date);
  try {
    await ensureSlotClaimsTable(env.DB);
    const readBookings = env.DB.prepare(`SELECT appointment_at, appointment_duration_minutes FROM estimate_requests
      WHERE status = 'booked' AND appointment_at < ? AND appointment_at >= ?`)
      .bind(bounds.end.toISOString(), new Date(bounds.start.getTime() - 86400000).toISOString()).all();
    const calendarConfigured = Boolean(env.APPLE_CALENDAR_EMAIL || env.APPLE_CALENDAR_APP_PASSWORD);
    const [bookings, claims, calendar] = await Promise.all([
      readBookings,
      getSlotClaims(env.DB, bounds.start, bounds.end),
      calendarConfigured ? getICloudBusyIntervals(env, bounds.start, bounds.end) : { ok: true, intervals: [] },
    ]);
    if (!calendar.ok) throw new Error("Calendar unavailable");
    const occupied = new Set(claims);
    const busy = calendar.intervals.concat(bookings.results.map(row => ({
      start: row.appointment_at,
      end: new Date(Date.parse(row.appointment_at) + Number(row.appointment_duration_minutes || 120) * 60000),
    })));
    const times = slots.filter(slot =>
      !slot.blocks.some(block => occupied.has(block)) &&
      !busy.some(range => overlaps(slot.startsAt, slot.endsAt, range.start, range.end))
    ).map(slot => slot.startsAt);
    return json({ date, times });
  } catch {
    return json({ error: "Availability is temporarily unavailable." }, 503);
  }
}
