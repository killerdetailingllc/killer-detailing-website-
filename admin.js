const loginPanel = document.getElementById("login-panel");
const desk = document.getElementById("desk");
const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");
const deskMessage = document.getElementById("desk-message");
const requestsRoot = document.getElementById("requests");
const escapeText = (value) => String(value ?? "");
const displayServiceNames = (services) => services.map((service) => ({ "Exterior Detail": "Burial", "Interior Detail": "Embalming", "Full Detail": "Viewing" })[service] || service);
const money = (cents) => cents == null ? "Not set" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = escapeText(text);
  if (className) element.className = className;
  return element;
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The request could not be completed.");
  return data;
}

function renderRequest(item) {
  const card = node("article", undefined, "request-card");
  const statusLabel = node("p", `${item.status.replaceAll("_", " ").toUpperCase()} · ${new Date(item.created_at).toLocaleString()}`, "eyebrow");
  card.append(statusLabel);
  card.append(node("h2", `${item.name} — ${item.year} ${item.make} ${item.model}`));
  card.append(node("p", `${item.vehicle_type} · ${item.email} · ${item.phone}`, "request-meta"));
  card.append(node("p", `Service address: ${item.service_address || "Not provided"}`, "request-meta"));
  if (item.appointment_at) card.append(node("p", `Appointment: ${new Date(item.appointment_at).toLocaleString()} · ${item.appointment_duration_minutes / 60} hours${item.calendar_event_uid ? " · Added to iCloud" : " · Calendar event pending"}`, "request-meta"));
  card.append(node("p", `Services: ${displayServiceNames(item.services).join(", ")}`));
  if (item.addons.length) card.append(node("p", `Area add-ons: ${item.addons.join(", ")}`));
  const amountLabel = node("p", item.payment_method === "cash"
    ? `Cash booking — no deposit collected · ${money(item.estimate_cents)} due at appointment`
    : item.payment_method === "stripe"
      ? `Online deposit paid: ${money(item.deposit_cents)} · Estimate total: ${money(item.estimate_cents)}`
      : `Current estimate: ${money(item.estimate_cents)} · 25% online deposit: ${money(item.deposit_cents)} or cash with no deposit`);
  card.append(amountLabel);
  const datePreference = item.condition_text.match(/^\[Preferred appointment dates — not confirmed\] ([^\r\n]+)\r?\n\r?\nCustomer’s condition notes:\r?\n/);
  if (datePreference) card.append(node("p", `Customer’s preferred dates (not confirmed): ${datePreference[1]}`, "request-meta"));
  card.append(node("pre", datePreference ? item.condition_text.slice(datePreference[0].length) : item.condition_text));
  if (item.photos.length) {
    const gallery = node("div", undefined, "request-photos");
    for (const photo of item.photos) {
      const figure = node("figure");
      const image = document.createElement("img");
      image.src = `/api/admin/photo?id=${encodeURIComponent(photo.id)}`;
      image.alt = `${photo.label} photo`;
      image.loading = "lazy";
      figure.append(image, node("figcaption", `${photo.label} · ${(photo.size_bytes / 1048576).toFixed(1)} MB`));
      gallery.append(figure);
    }
    card.append(gallery);
  }
  const details = node("details");
  const summary = node("summary", item.status === "pending" || item.status === "estimate_sent" ? "Create or update estimate" : "Estimate details");
  details.append(summary);
  const form = node("form", undefined, "admin-form");
  const amount = document.createElement("input"); amount.type = "number"; amount.min = "2"; amount.step = "0.01"; amount.required = true; amount.placeholder = "Approved total, e.g. 250"; amount.setAttribute("aria-label", "Approved estimate total");
  if (item.estimate_cents != null) amount.value = (item.estimate_cents / 100).toFixed(2);
  const duration = document.createElement("select"); duration.setAttribute("aria-label", "Appointment duration");
  for (const hours of [1, 2, 3, 4, 5, 6, 8]) {
    const option = document.createElement("option"); option.value = String(hours * 60); option.textContent = `${hours} hour${hours === 1 ? "" : "s"}`;
    if (Number(item.appointment_duration_minutes || 120) === hours * 60) option.selected = true;
    duration.append(option);
  }
  const note = document.createElement("textarea"); note.rows = 3; note.maxLength = 2000; note.placeholder = "Notes or estimate details for the customer (optional)"; note.setAttribute("aria-label", "Estimate details"); note.value = item.estimate_note || "";
  const submit = node("button", item.status === "estimate_sent" ? "UPDATE ESTIMATE LINK" : "SET ESTIMATE & CREATE CUSTOMER LINK", "button button-red"); submit.type = "submit";
  const status = node("p", "", "admin-status");
  const durationLabel = node("label", "Estimated service duration (customers choose an opening that fits)");
  durationLabel.append(duration);
  form.append(amount, durationLabel, note, submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); submit.disabled = true; status.textContent = "Saving estimate…";
    try {
      const result = await api("/api/admin/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id, total: amount.value, note: note.value, appointmentDurationMinutes: duration.value }) });
      item.status = "estimate_sent";
      item.appointment_at = result.appointmentAt;
      item.appointment_duration_minutes = result.appointmentDurationMinutes;
      statusLabel.textContent = `ESTIMATE SENT · ${new Date(item.created_at).toLocaleString()}`;
      amountLabel.textContent = `Current estimate: ${money(result.estimateCents)} · 25% deposit: ${money(result.depositCents)}`;
      status.textContent = "Estimate saved. The customer chooses an available appointment time after accepting. The calendar event will be added after the customer confirms online payment or chooses cash. Copy this private link and send it to the customer:";
      const link = node("a", result.url, "estimate-link"); link.href = result.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      status.append(document.createElement("br"), link);
      const copy = node("button", "Copy customer link", "logout"); copy.type = "button";
      copy.addEventListener("click", async () => { await navigator.clipboard.writeText(result.url); copy.textContent = "Copied"; });
      status.append(document.createElement("br"), copy);
    } catch (error) { status.textContent = error.message; submit.disabled = false; }
  });
  details.append(form); card.append(details);
  return card;
}

async function loadRequests() {
  deskMessage.textContent = "Loading estimate requests…";
  try {
    const result = await api("/api/admin/requests");
    requestsRoot.replaceChildren();
    if (!result.requests.length) requestsRoot.append(node("p", "No estimate requests yet."));
    else for (const item of result.requests) requestsRoot.append(renderRequest(item));
    deskMessage.textContent = "";
  } catch (error) {
    if (error.message.includes("sign in")) { desk.hidden = true; loginPanel.hidden = false; }
    deskMessage.textContent = error.message;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "Signing in…";
  try {
    await api("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: document.getElementById("owner-password").value }) });
    document.getElementById("owner-password").value = "";
    loginPanel.hidden = true; desk.hidden = false; await loadRequests();
  } catch (error) { loginMessage.textContent = error.message; }
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/admin/login", { method: "DELETE" });
  desk.hidden = true; loginPanel.hidden = false; loginMessage.textContent = "You have signed out.";
});
