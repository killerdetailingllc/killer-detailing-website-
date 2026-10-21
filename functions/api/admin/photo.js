import { isAdmin, json } from "../../_utils.js";

export async function onRequestGet({ request, env }) {
  if (!await isAdmin(request, env)) return json({ error: "Please sign in again." }, 401);
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !env.PHOTOS) return json({ error: "Photo not found." }, 404);
  const photo = await env.DB.prepare("SELECT object_key, content_type, filename FROM estimate_photos WHERE id = ?").bind(id).first();
  if (!photo) return json({ error: "Photo not found." }, 404);
  const object = await env.PHOTOS.get(photo.object_key);
  if (!object) return json({ error: "Photo not found." }, 404);
  return new Response(object.body, { headers: { "content-type": photo.content_type, "content-disposition": `inline; filename="${photo.filename.replaceAll('"', "")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
