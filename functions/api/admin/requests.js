import { isAdmin, json } from "../../_utils.js";

export async function onRequestGet({ request, env }) {
  if (!await isAdmin(request, env)) return json({ error: "Please sign in again." }, 401);
  const { results } = await env.DB.prepare(`SELECT id, created_at, status, name, email, phone, year, make, model,
    vehicle_type, services_json, addons_json, condition_text, estimate_cents, deposit_cents, estimate_note,
    estimate_expires_at, accepted_at, paid_at, service_address, appointment_at, appointment_duration_minutes, calendar_event_uid
    FROM estimate_requests ORDER BY created_at DESC LIMIT 100`).all();
  const photoRows = await env.DB.prepare("SELECT id, request_id, label, filename, size_bytes FROM estimate_photos WHERE request_id IN (SELECT id FROM estimate_requests ORDER BY created_at DESC LIMIT 100) ORDER BY id").all();
  const photos = new Map();
  for (const photo of photoRows.results || []) {
    if (!photos.has(photo.request_id)) photos.set(photo.request_id, []);
    photos.get(photo.request_id).push(photo);
  }
  return json({ requests: (results || []).map((row) => ({ ...row, services: JSON.parse(row.services_json), addons: JSON.parse(row.addons_json), photos: photos.get(row.id) || [] })) });
}
