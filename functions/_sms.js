// Optional Twilio SMS alerts. Keep the auth token in a Cloudflare Secret.
export async function sendOwnerSms(env, message) {
  const accountSid = String(env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || "").trim();
  const from = String(env.TWILIO_FROM_NUMBER || "").trim();
  const to = String(env.OWNER_NOTIFICATION_PHONE || "").trim();
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
