function xmlEscape(value) {
  return String(value).replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]);
}

function xmlUnescape(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
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
  const services = [...booking.services, ...booking.addons.map((item) => `Add-on: ${item}`)].join(", ");
  const vehicle = `${booking.year} ${booking.make} ${booking.model} (${booking.vehicle_type})`;
  const description = [
    `Customer: ${booking.name}`,
    `Email: ${booking.email}`,
    `Phone: ${booking.phone}`,
    `Vehicle: ${vehicle}`,
    `Services: ${services}`,
    `Estimate: $${(booking.estimate_cents / 100).toFixed(2)}`,
    `Deposit paid: $${(booking.deposit_cents / 100).toFixed(2)}`,
  ].join("\\n");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Killer Detailing LLC//Appointment//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${icsUtc(new Date().toISOString())}`, `DTSTART:${icsUtc(booking.appointment_at)}`,
    `DURATION:PT${Math.round(booking.appointment_duration_minutes / 60)}H`, `SUMMARY:${icsEscape(`Killer Detailing - ${booking.name} - ${vehicle}`)}`,
    `LOCATION:${icsEscape(booking.service_address)}`, `DESCRIPTION:${icsEscape(description)}`, "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  const response = await fetch(eventUrl, { method: "PUT", headers: { authorization, "content-type": "text/calendar; charset=utf-8", "if-none-match": "*" }, body: ics });
  if (response.ok || response.status === 412) return { ok: true, uid };
  return { ok: false, reason: `iCloud could not save the appointment (${response.status}).` };
}
