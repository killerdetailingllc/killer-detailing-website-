export const BUSINESS_TIME_ZONE = "America/New_York";
const SLOT_MINUTES = 30;

function zonedDateTimeToUtc(date, hour, minute) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess += target - represented;
  }
  return new Date(guess);
}

export function easternDayBounds(date) {
  return { start: zonedDateTimeToUtc(date, 0, 0), end: zonedDateTimeToUtc(date, 24, 0) };
}

export function buildBusinessSlots(date, durationMinutes, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ![60, 120, 180, 240, 300, 360, 480].includes(Number(durationMinutes))) return [];
  const dateCheck = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== date) return [];
  const day = dateCheck.getUTCDay();
  const openHour = day === 0 || day === 6 ? 10 : 18;
  const closeHour = 23;
  const durationMs = Number(durationMinutes) * 60000;
  const slots = [];
  for (let minute = openHour * 60; minute + Number(durationMinutes) <= closeHour * 60; minute += SLOT_MINUTES) {
    const start = zonedDateTimeToUtc(date, Math.floor(minute / 60), minute % 60);
    const end = new Date(start.getTime() + durationMs);
    if (start.getTime() <= now) continue;
    const blocks = [];
    for (let time = start.getTime(); time < end.getTime(); time += SLOT_MINUTES * 60000) blocks.push(new Date(time).toISOString());
    slots.push({ startsAt: start.toISOString(), endsAt: end.toISOString(), blocks });
  }
  return slots;
}

export function overlaps(startA, endA, startB, endB) {
  return new Date(startA).getTime() < new Date(endB).getTime() && new Date(startB).getTime() < new Date(endA).getTime();
}

export function displayEasternTime(value) {
  return new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export async function ensureSlotClaimsTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS appointment_slot_claims (
    slot_start TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES estimate_requests(id) ON DELETE CASCADE,
    expires_at TEXT,
    confirmed_at TEXT
  )`).run();
}

export async function releaseExpiredSlotClaims(db, now = new Date().toISOString()) {
  await db.prepare("DELETE FROM appointment_slot_claims WHERE confirmed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?").bind(now).run();
}

export async function claimAppointmentSlot(db, requestId, slot, expiresAt) {
  const statements = [db.prepare("DELETE FROM appointment_slot_claims WHERE request_id = ? AND confirmed_at IS NULL").bind(requestId)];
  for (const block of slot.blocks) {
    statements.push(db.prepare("INSERT INTO appointment_slot_claims (slot_start, request_id, expires_at) VALUES (?, ?, ?)").bind(block, requestId, expiresAt));
  }
  statements.push(db.prepare("UPDATE estimate_requests SET appointment_at = ? WHERE id = ? AND status = 'accepted'").bind(slot.startsAt, requestId));
  const results = await db.batch(statements);
  const changed = results.at(-1)?.meta?.changes || 0;
  if (!changed) {
    await db.prepare("DELETE FROM appointment_slot_claims WHERE request_id = ? AND confirmed_at IS NULL").bind(requestId).run();
    return false;
  }
  return true;
}

export async function hasActiveSlotClaim(db, requestId, startsAt, now = new Date().toISOString()) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM appointment_slot_claims
    WHERE request_id = ? AND confirmed_at IS NULL AND expires_at > ?`).bind(requestId, now).first();
  const request = await db.prepare("SELECT appointment_duration_minutes FROM estimate_requests WHERE id = ?").bind(requestId).first();
  const expected = Number(request?.appointment_duration_minutes || 0) / 30;
  return Number(row?.count || 0) === expected && expected > 0;
}

export async function confirmSlotClaims(db, requestId, confirmedAt = new Date().toISOString()) {
  await db.prepare("UPDATE appointment_slot_claims SET confirmed_at = ?, expires_at = NULL WHERE request_id = ?").bind(confirmedAt, requestId).run();
}

export async function extendSlotClaim(db, requestId, expiresAt) {
  await db.prepare("UPDATE appointment_slot_claims SET expires_at = ? WHERE request_id = ? AND confirmed_at IS NULL").bind(expiresAt, requestId).run();
}

export async function moveConfirmedAppointmentSlot(db, requestId, slot) {
  const now = new Date().toISOString();
  const statements = [db.prepare("UPDATE estimate_requests SET appointment_at = ? WHERE id = ? AND status = 'booked'").bind(slot.startsAt, requestId)];
  statements.push(db.prepare("DELETE FROM appointment_slot_claims WHERE request_id = ? AND EXISTS (SELECT 1 FROM estimate_requests WHERE id = ? AND status = 'booked')").bind(requestId, requestId));
  for (const block of slot.blocks) statements.push(db.prepare(`INSERT INTO appointment_slot_claims (slot_start, request_id, expires_at, confirmed_at)
    SELECT ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM estimate_requests WHERE id = ? AND status = 'booked')`).bind(block, requestId, now, requestId));
  const results = await db.batch(statements);
  return Number(results[0]?.meta?.changes || 0) > 0;
}

export async function updateAppointmentStatus(db, requestId, expectedStatus, newStatus, event) {
  const now = new Date().toISOString();
  const statements = [db.prepare("UPDATE estimate_requests SET status = ? WHERE id = ? AND status = ?").bind(newStatus, requestId, expectedStatus)];
  if (newStatus === "cancelled") statements.push(db.prepare("DELETE FROM appointment_slot_claims WHERE request_id = ? AND EXISTS (SELECT 1 FROM estimate_requests WHERE id = ? AND status = ?)").bind(requestId, requestId, newStatus));
  statements.push(db.prepare(`INSERT INTO appointment_status_events
    (id, request_id, event_type, previous_status, new_status, previous_at, new_at, note, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM estimate_requests WHERE id = ? AND status = ?)`)
    .bind(event.id, requestId, event.type, expectedStatus, newStatus, event.previousAt || null, event.newAt || null, event.note || "", now, requestId, newStatus));
  const results = await db.batch(statements);
  return Number(results[0]?.meta?.changes || 0) > 0;
}

export async function ensureAppointmentEventsTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS appointment_status_events (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES estimate_requests(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    previous_status TEXT NOT NULL,
    new_status TEXT NOT NULL,
    previous_at TEXT,
    new_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`).run();
}

export async function getSlotClaims(db, start, end, now = new Date().toISOString(), exceptRequestId = "") {
  const { results } = await db.prepare(`SELECT slot_start FROM appointment_slot_claims
    WHERE slot_start >= ? AND slot_start < ? AND (confirmed_at IS NOT NULL OR expires_at > ?) AND request_id != ?`)
    .bind(start.toISOString(), end.toISOString(), now, exceptRequestId).all();
  return (results || []).map((row) => row.slot_start);
}
