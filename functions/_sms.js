// Optional Twilio SMS alerts. Keep the auth token in a Cloudflare Secret.
export async function sendOwnerSms(env, message) {
  const accountSid = String(env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || "").trim();
  const from = String(env.TWILIO_FROM_NUMBER || "").trim();
  if (!env.DB) return false;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sms_owner_consents (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phone TEXT NOT NULL,
    consented_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'web'
  )`).run();
  const consent = await env.DB.prepare("SELECT phone FROM sms_owner_consents WHERE id = 1 AND active = 1").first();
  const to = String(consent?.phone || "").trim();
  if (!accountSid || !authToken || !from || !to) return false;
  if (!/^\+\d{8,15}$/.test(from) || !/^\+\d{8,15}$/.test(to)) return false;
  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ From: from, To: to, Body: message }),
    });
    if (!response.ok) console.error("Twilio owner SMS failed", { status: response.status });
    return response.ok;
  } catch {
    console.error("Twilio owner SMS could not connect.");
    return false;
  }
}
