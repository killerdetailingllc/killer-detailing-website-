import { addonNames, json, safeFileName, serviceNames, sha256, uuid, validPhotoType } from "../_utils.js";
import { sendEmail } from "../_email.js";

const photoLabels = new Map([
  ["photo-front", "Front"], ["photo-rear", "Rear"], ["photo-driver-side", "Driver side"],
  ["photo-passenger-side", "Passenger side"], ["photo-interior-front", "Interior / front"],
  ["photo-interior-rear", "Interior / rear"], ["photo-dashboard-console", "Dashboard / console"],
  ["photo-trunk-hatch-bed", "Trunk / hatch / truck bed"], ["photo-problem-areas", "Problem areas"],
]);

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DB || !env.PHOTOS || !env.ADMIN_SESSION_SECRET) return json({ error: "Estimate requests are not available yet." }, 503);
  if (!request.headers.get("Origin") || request.headers.get("Origin") !== new URL(request.url).origin) return json({ error: "Request origin could not be verified." }, 403);
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 35 * 1024 * 1024) return json({ error: "Please keep the total photo upload under 30 MB." }, 413);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(`${env.ADMIN_SESSION_SECRET}:public:${ip}`);
  const rate = await env.DB.prepare("SELECT window_started_at, attempts FROM public_request_limits WHERE ip_hash = ?").bind(ipHash).first();
  if (rate && rate.window_started_at > nowSeconds - 3600 && rate.attempts >= 5) return json({ error: "Please wait before sending another request." }, 429);
  await env.DB.prepare(`INSERT INTO public_request_limits (ip_hash, window_started_at, attempts) VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
    window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END`)
    .bind(ipHash, nowSeconds, nowSeconds - 3600, nowSeconds - 3600, nowSeconds).run();
  await env.DB.prepare("DELETE FROM public_request_limits WHERE window_started_at <= ?").bind(nowSeconds - 86400).run();

  let form;
  try { form = await request.formData(); } catch { return json({ error: "Please submit the estimate form again." }, 400); }
  if (String(form.get("website") || "").trim()) return json({ ok: true }, 202);

  const services = form.getAll("services").map(String);
  const addons = form.getAll("addons").map(String);
  const allowedServices = serviceNames();
  const allowedAddons = addonNames();
  const fields = Object.fromEntries(["name", "email", "phone", "year", "make", "model", "vehicleType", "condition"].map((key) => [key, String(form.get(key) || "").trim()]));
  fields.serviceAddress = String(form.get("serviceAddress") || "").trim();
  if (!fields.name || fields.name.length > 140 || !/^\S+@\S+\.\S+$/.test(fields.email) || fields.email.length > 254 || !fields.phone || fields.phone.length > 40 || !/^\d{4}$/.test(fields.year) || !fields.make || fields.make.length > 80 || !fields.model || fields.model.length > 80 || !fields.vehicleType || fields.vehicleType.length > 50 || !fields.condition || fields.condition.length > 3000 || !fields.serviceAddress || fields.serviceAddress.length > 500) {
    return json({ error: "Please check the required contact, vehicle, and condition fields." }, 400);
  }
  if (!services.length || services.some((item) => !allowedServices.includes(item)) || addons.some((item) => !allowedAddons.includes(item))) return json({ error: "Please choose valid services and add-ons." }, 400);

  const photos = [];
  let totalBytes = 0;
  for (const [field, label] of photoLabels) {
    for (const item of form.getAll(field)) {
      if (!(item instanceof File) || !item.size) continue;
      if (!validPhotoType(item.type)) return json({ error: "Please upload JPG, PNG, WebP, or HEIC photos only." }, 415);
      if (item.size > 8 * 1024 * 1024) return json({ error: "Each photo must be 8 MB or smaller." }, 413);
      totalBytes += item.size;
      photos.push({ file: item, label });
      if (photos.length > 15 || totalBytes > 30 * 1024 * 1024) return json({ error: "Please upload no more than 15 photos or 30 MB total." }, 413);
    }
  }

  const id = uuid();
  const createdAt = new Date().toISOString();
  const photoKeys = [];
  try {
    await env.DB.prepare(`INSERT INTO estimate_requests
      (id, created_at, name, email, phone, year, make, model, vehicle_type, services_json, addons_json, condition_text, service_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, createdAt, fields.name, fields.email, fields.phone, fields.year, fields.make, fields.model, fields.vehicleType, JSON.stringify(services), JSON.stringify(addons), fields.condition, fields.serviceAddress).run();

    for (const { file, label } of photos) {
      const photoId = uuid();
      const key = `requests/${id}/${photoId}`;
      await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
      photoKeys.push(key);
      await env.DB.prepare(`INSERT INTO estimate_photos (id, request_id, object_key, label, filename, content_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(photoId, id, key, label, safeFileName(file.name), file.type, file.size).run();
    }
  } catch {
    await Promise.allSettled(photoKeys.map((key) => env.PHOTOS.delete(key)));
    await env.DB.prepare("DELETE FROM estimate_requests WHERE id = ?").bind(id).run().catch(() => {});
    return json({ error: "We could not save your request. Please try again or contact the business directly." }, 503);
  }
  if (env.OWNER_NOTIFICATION_EMAIL && env.RESEND_API_KEY && env.EMAIL_FROM) {
    const summary = `${fields.year} ${fields.make} ${fields.model} (${fields.vehicleType})`;
    const message = `A new estimate request was submitted.\n\nCustomer: ${fields.name}\nEmail: ${fields.email}\nPhone: ${fields.phone}\nService address: ${fields.serviceAddress}\nVehicle: ${summary}\nServices: ${services.join(", ")}\nAdd-ons: ${addons.length ? addons.join(", ") : "None"}\nPhotos: ${photos.length}\n\nReview the request and photos in the owner estimate desk: ${new URL("/admin.html", request.url)}`;
    const task = sendEmail(env, { to: env.OWNER_NOTIFICATION_EMAIL, subject: `New estimate request: ${fields.name}`, text: message });
    if (waitUntil) waitUntil(task);
  }
  return json({ ok: true }, 201);
}
