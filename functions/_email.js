// Optional Resend email delivery. Keep the API key in a Cloudflare secret.
export async function sendEmail(env, { to, subject, text }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !to) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function money(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
