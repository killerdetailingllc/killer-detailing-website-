const encoder = new TextEncoder();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !!origin && origin === new URL(request.url).origin;
}

export function uuid() {
  return crypto.randomUUID();
}

export function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

export async function sessionCookie(secret) {
  const expires = Math.floor(Date.now() / 1000) + 8 * 60 * 60;
  const payload = `v1.${expires}`;
  const signature = await hmac(payload, secret);
  return `kd_admin=${payload}.${signature}; Path=/api/admin; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`;
}

export async function isAdmin(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const raw = request.headers.get("Cookie") || "";
  const value = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith("kd_admin="))?.slice(9);
  if (!value) return false;
  const [version, expiresText, signature] = value.split(".");
  const expires = Number(expiresText);
  if (version !== "v1" || !Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000) || !signature) return false;
  return constantTimeEqual(signature, await hmac(`${version}.${expiresText}`, env.ADMIN_SESSION_SECRET));
}

export function safeFileName(name) {
  return (name || "photo").normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "photo";
}

export function validPhotoType(type) {
  return ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(type);
}

export function serviceNames() {
  return ["Exterior Detail", "Interior Detail", "Full Detail"];
}

export function addonNames() {
  return ["Trunk", "Hatch", "Truck bed"];
}
