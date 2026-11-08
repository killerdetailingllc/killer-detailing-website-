import { isAdmin, json, displayServiceNames } from "../../_utils.js";
import { easternDayBounds } from "../../_availability.js";

export async function onRequestGet({ request, env }) {
  if (!await isAdmin(request, env)) return json({ error: "Please sign in again." }, 401);
  const month = new URL(request.url).searchParams.get("month") || "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "Choose a valid calendar month." }, 400);

  const [year, monthNumber] = month.split("-").map(Number);
  const startDate = month + "-01";
  const nextMonthDate = new Date(Date.UTC(year, monthNumber, 1, 12));
  const endDate = nextMonthDate.getUTCFullYear() + "-" + String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0") + "-01";
  const start = easternDayBounds(startDate).start;
  const end = easternDayBounds(endDate).start;
  const { results } = await env.DB.prepare("SELECT id, created_at, status, name, email, phone, year, make, model, " +
    "vehicle_type, services_json, addons_json, condition_text, estimate_cents, deposit_cents, estimate_note, " +
    "estimate_expires_at, accepted_at, paid_at, service_address, appointment_at, appointment_duration_minutes, calendar_event_uid " +
    "FROM estimate_requests WHERE status IN ('booked','completed') AND appointment_at >= ? AND appointment_at < ? ORDER BY appointment_at")
    .bind(start.toISOString(), end.toISOString()).all();
  const rows = results || [];
  const photosByRequest = new Map();
  if (rows.length) {
    const photos = await env.DB.prepare("SELECT id, request_id, label, filename, size_bytes FROM estimate_photos " +
      "WHERE request_id IN (SELECT id FROM estimate_requests WHERE status IN ('booked','completed') AND appointment_at >= ? AND appointment_at < ?) ORDER BY id")
      .bind(start.toISOString(), end.toISOString()).all();
    for (const photo of photos.results || []) {
      if (!photosByRequest.has(photo.request_id)) photosByRequest.set(photo.request_id, []);
      photosByRequest.get(photo.request_id).push(photo);
    }
  }

  return json({ appointments: rows.map((row) => ({
    ...row,
    payment_method: row.paid_at ? "stripe" : "cash",
    services: displayServiceNames(JSON.parse(row.services_json || "[]")),
    addons: JSON.parse(row.addons_json || "[]"),
    photos: photosByRequest.get(row.id) || [],
  })) });
}
