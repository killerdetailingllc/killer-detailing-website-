import { json, sha256 } from "../../_utils.js";

export async function onRequestGet({ request, env }) {
  const rawToken = new URL(request.url).searchParams.get("token") || "";
  if (rawToken.length < 30 || rawToken.length > 100) return json({ error: "This estimate link is not valid." }, 404);
  const row = await env.DB.prepare(`SELECT status, name, year, make, model, vehicle_type, services_json, addons_json,
    estimate_cents, deposit_cents, estimate_note, estimate_expires_at, accepted_at, paid_at
    FROM estimate_requests WHERE estimate_token_hash = ?`).bind(await sha256(rawToken)).first();
  if (!row) return json({ error: "This estimate link is not valid or has expired." }, 404);
  if (row.estimate_expires_at && row.estimate_expires_at < new Date().toISOString() && !["accepted", "booked"].includes(row.status)) return json({ error: "This estimate link has expired. Please contact the business for an updated estimate." }, 410);
  return json({ status: row.status, name: row.name, vehicle: `${row.year} ${row.make} ${row.model}`, vehicleType: row.vehicle_type,
    services: JSON.parse(row.services_json), addons: JSON.parse(row.addons_json), estimateCents: row.estimate_cents,
    depositCents: row.deposit_cents, note: row.estimate_note, acceptedAt: row.accepted_at, paidAt: row.paid_at });
}
