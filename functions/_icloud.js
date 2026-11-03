function xmlEscape(value) {
  return String(value).replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]);
}

function xmlUnescape(value) {
  return value.replace(/&#(x[\da-f]+|\d+);/gi, (_match, code) => String.fromCodePoint(code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
}

function propertyHref(xml, propertyName) {
  const pattern = new RegExp(`<(?:(?:[\\w-]+):)?${propertyName}\\b[^>]*>[\\s\\S]*?<(?:(?:[\\w-]+):)?href\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?href>`, "i");
  const match = xml.match(pattern);
  return match ? xmlUnescape(match[1].trim()) : "";
}

function icsEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function icsUtc(value) {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function basicAuth(email, password) {
  const bytes = new TextEncoder().encode(`${email}:${password}`);
  return `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`;
}

async function propfind(url, depth, authorization, body) {
  return fetch(url, { method: "PROPFIND", headers: { authorization, depth, "content-type": "application/xml; charset=utf-8" }, body });
}

async function findCalendar(env) {
  if (!env.APPLE_CALENDAR_EMAIL || !env.APPLE_CALENDAR_APP_PASSWORD) return { error: "iCloud calendar credentials are not configured." };
  const authorization = basicAuth(env.APPLE_CALENDAR_EMAIL, env.APPLE_CALENDAR_APP_PASSWORD);
  const rootXml = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
  const rootResponse = await propfind("https://caldav.icloud.com/", "0", authorization, rootXml);
  if (!rootResponse.ok) return { error: `iCloud discovery failed (${rootResponse.status}).` };
  const principalHref = propertyHref(await rootResponse.text(), "current-user-principal");
  if (!principalHref) return { error: "iCloud did not return a calendar account location." };
  const principalUrl = new URL(principalHref, "https://caldav.icloud.com/");
  const principalXml = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
  const principalResponse = await propfind(principalUrl, "0", authorization, principalXml);
  if (!principalResponse.ok) return { error: `iCloud calendar discovery failed (${principalResponse.status}).` };
  const homeHref = propertyHref(await principalResponse.text(), "calendar-home-set");
  if (!homeHref) return { error: "iCloud did not return a calendar location." };
  const homeUrl = new URL(homeHref, principalUrl);
  const calendarsXml = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;
  const calendarsResponse = await propfind(homeUrl, "1", authorization, calendarsXml);
  if (!calendarsResponse.ok) return { error: `iCloud calendars could not be listed (${calendarsResponse.status}).` };
  const entries = (await calendarsResponse.text()).match(/<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>/gi) || [];
  const calendars = entries.flatMap((entry) => {
    if (!/<(?:[\w-]+:)?calendar(?:\s|\/|>)/i.test(entry)) return [];
    const hrefMatch = entry.match(/<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i);
    const nameMatch = entry.match(/<(?:[\w-]+:)?displayname\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?displayname>/i);
    return hrefMatch ? [{ url: new URL(xmlUnescape(hrefMatch[1].trim()), homeUrl), name: nameMatch ? xmlUnescape(nameMatch[1].trim()) : "" }] : [];
  });
  const preferred = String(env.APPLE_CALENDAR_NAME || "").trim().toLowerCase();
  const calendar = preferred ? calendars.find((item) => item.name.toLowerCase() === preferred) : calendars[0];
  if (!calendar) return { error: preferred ? "The configured iCloud calendar name was not found." : "No iCloud calendar was found." };
  return { authorization, calendar };
}

function localCalendarDateToUtc(year, month, day, hour, minute, second, zone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let guess = target;
  for (let index = 0; index < 3; index++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    guess += target - represented;
  }
  return new Date(guess);
}

function parseIcsDate(value, params = "") {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!match) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", utc] = match;
  const zone = params.match(/TZID="?([^;:"]+)/i)?.[1] || "America/New_York";
  const start = utc ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : localCalendarDateToUtc(+y, +mo, +d, +h, +mi, +s, zone);
  if (!match[4]) return { start, end: localCalendarDateToUtc(+y, +mo, +d + 1, 0, 0, 0, zone) };
  return { start, end: null };
}

function parseCalendarBusy(ics) {
  const normalized = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const intervals = [];
  let event = null;
  for (const line of normalized) {
    if (line === "BEGIN:VEVENT") { event = {}; continue; }
    if (line === "END:VEVENT" && event) {
      const start = event.start?.start;
      let end = event.end?.start;
      if (start && !end && event.duration) end = new Date(start.getTime() + event.duration);
      if (start && end && end > start && event.status !== "CANCELLED" && event.transp !== "TRANSPARENT") intervals.push({ start, end, uid: event.uid || null });
      event = null; continue;
    }
    if (!event) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon); const value = line.slice(colon + 1);
    if (key.startsWith("DTSTART")) event.start = parseIcsDate(value, key);
    else if (key.startsWith("DTEND")) event.end = parseIcsDate(value, key);
    else if (key === "UID") event.uid = value;
    else if (key === "DURATION") { const m = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/); if (m) event.duration = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000; }
    else if (key === "STATUS") event.status = value.toUpperCase();
    else if (key === "TRANSP") event.transp = value.toUpperCase();
    else if (key === "RRULE" || key === "RDATE") event.recurring = true;
  }
  // Recurrence expansion is delegated to iCloud's time-range query; the query returns expanded instances.
  return intervals;
}

export async function getICloudBusyIntervals(env, start, end) {
  const found = await findCalendar(env);
  if (found.error) return { ok: false, reason: found.error };
  const startUtc = start.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const endUtc = end.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="${startUtc}" end="${endUtc}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${startUtc}" end="${endUtc}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const response = await fetch(found.calendar.url, { method: "REPORT", headers: { authorization: found.authorization, depth: "1", "content-type": "application/xml; charset=utf-8" }, body });
  if (!response.ok) return { ok: false, reason: `iCloud availability check failed (${response.status}).` };
  const xml = await response.text();
  const calendarData = [...xml.matchAll(/<(?:[\w-]+:)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/gi)]
    .map((match) => xmlUnescape(match[1]));
  return { ok: true, intervals: calendarData.flatMap(parseCalendarBusy) };
}

export async function createICloudEvent(env, booking) {
  if (!env.APPLE_CALENDAR_EMAIL || !env.APPLE_CALENDAR_APP_PASSWORD) return { ok: false, reason: "iCloud calendar credentials are not configured." };
  const authorization = basicAuth(env.APPLE_CALENDAR_EMAIL, env.APPLE_CALENDAR_APP_PASSWORD);
  const rootXml = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
  const rootResponse = await propfind("https://caldav.icloud.com/", "0", authorization, rootXml);
  if (!rootResponse.ok) return { ok: false, reason: `iCloud discovery failed (${rootResponse.status}).` };
  const rootBody = await rootResponse.text();
  const principalHref = propertyHref(rootBody, "current-user-principal");
  if (!principalHref) return { ok: false, reason: "iCloud did not return a calendar account location." };
  const principalUrl = new URL(principalHref, "https://caldav.icloud.com/");
  const principalXml = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
  const principalResponse = await propfind(principalUrl, "0", authorization, principalXml);
  if (!principalResponse.ok) return { ok: false, reason: `iCloud calendar discovery failed (${principalResponse.status}).` };
  const homeHref = propertyHref(await principalResponse.text(), "calendar-home-set");
  if (!homeHref) return { ok: false, reason: "iCloud did not return a calendar location." };
  const homeUrl = new URL(homeHref, principalUrl);
  const calendarsXml = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;
  const calendarsResponse = await propfind(homeUrl, "1", authorization, calendarsXml);
  if (!calendarsResponse.ok) return { ok: false, reason: `iCloud calendars could not be listed (${calendarsResponse.status}).` };
  const calendarBody = await calendarsResponse.text();
  const entries = calendarBody.match(/<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>/gi) || [];
  const calendars = entries.flatMap((entry) => {
    if (!/<(?:[\w-]+:)?calendar(?:\s|\/|>)/i.test(entry)) return [];
    const hrefMatch = entry.match(/<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i);
    const nameMatch = entry.match(/<(?:[\w-]+:)?displayname\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?displayname>/i);
    if (!hrefMatch) return [];
    return [{ url: new URL(xmlUnescape(hrefMatch[1].trim()), homeUrl), name: nameMatch ? xmlUnescape(nameMatch[1].trim()) : "" }];
  });
  if (!calendars.length) return { ok: false, reason: "No writable iCloud calendar was found." };
  const preferred = String(env.APPLE_CALENDAR_NAME || "").trim().toLowerCase();
  const calendar = preferred ? calendars.find((item) => item.name.toLowerCase() === preferred) : calendars[0];
  if (!calendar) return { ok: false, reason: "The configured iCloud calendar name was not found." };

  const uid = `${booking.id}@killerdetailingllc.com`;
  const eventUrl = new URL(`${encodeURIComponent(uid)}.ics`, calendar.url.href.endsWith("/") ? calendar.url : `${calendar.url.href}/`);
  if (booking.deleteEvent) {
    const deleted = await fetch(eventUrl, { method: "DELETE", headers: { authorization } });
    if (deleted.ok || deleted.status === 404) return { ok: true, uid };
    return { ok: false, reason: `iCloud could not remove the appointment (${deleted.status}).` };
  }
  const services = [...booking.services, ...booking.addons.map((item) => `Add-on: ${item}`)].join(", ");
  const vehicle = `${booking.year} ${booking.make} ${booking.model} (${booking.vehicle_type})`;
  const description = [
    `Customer: ${booking.name}`,
    `Email: ${booking.email}`,
    `Phone: ${booking.phone}`,
    `Vehicle: ${vehicle}`,
    `Services: ${services}`,
    `Estimate: $${(booking.estimate_cents / 100).toFixed(2)}`,
    booking.payment_method === "cash"
      ? `Payment: cash due at appointment $${(booking.estimate_cents / 100).toFixed(2)} (no deposit)`
      : `Deposit paid: $${(booking.deposit_cents / 100).toFixed(2)}`,
  ].join("\\n");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Killer Detailing LLC//Appointment//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${icsUtc(new Date().toISOString())}`, `DTSTART:${icsUtc(booking.appointment_at)}`,
    `DURATION:PT${Math.round(booking.appointment_duration_minutes / 60)}H`, `SUMMARY:${icsEscape(`Killer Detailing - ${booking.name} - ${vehicle}`)}`,
    `LOCATION:${icsEscape(booking.service_address)}`, `DESCRIPTION:${icsEscape(description)}`, "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  const headers = { authorization, "content-type": "text/calendar; charset=utf-8" };
  if (!booking.replaceEvent) headers["if-none-match"] = "*";
  const response = await fetch(eventUrl, { method: "PUT", headers, body: ics });
  if (response.ok || response.status === 412) return { ok: true, uid };
  return { ok: false, reason: `iCloud could not save the appointment (${response.status}).` };
}

export function updateICloudEvent(env, booking) {
  return createICloudEvent(env, { ...booking, replaceEvent: true });
}

export function deleteICloudEvent(env, id) {
  return createICloudEvent(env, { id, deleteEvent: true });
}
