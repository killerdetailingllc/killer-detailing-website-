const loginPanel = document.getElementById("login-panel");
const desk = document.getElementById("desk");
const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");
const deskMessage = document.getElementById("desk-message");
const requestsRoot = document.getElementById("requests");
const statusFilter = document.getElementById("status-filter");
let allRequests = [];
const statusNames = { pending: "New request", estimate_sent: "Waiting for customer", accepted: "Accepted — choosing time", booked: "Confirmed", completed: "Completed", cancelled: "Cancelled", declined: "Declined" };
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
  const statusText = item.status === "booked" && item.appointment_at ? "CONFIRMED" : (statusNames[item.status] || item.status.replaceAll("_", " ")).toUpperCase();
  const statusLabel = node("p", `${statusText} · ${new Date(item.created_at).toLocaleString()}`, "eyebrow");
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
  if (["pending", "estimate_sent"].includes(item.status)) {
    card.append(actionButton("Decline request", "decline", item));
  } else if (item.status === "accepted") {
    card.append(actionButton("Cancel request", "cancel", item));
  } else if (item.status === "booked") {
    const actions = node("div", undefined, "appointment-actions");
    actions.append(actionButton("Reschedule", "reschedule", item), actionButton("Mark completed", "complete", item), actionButton("Cancel appointment", "cancel", item));
    card.append(actions);
    const reschedule = node("div", undefined, "reschedule-panel"); reschedule.hidden = true;
    const date = document.createElement("input"); date.type = "date"; date.min = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); date.setAttribute("aria-label", "New appointment date");
    const slots = document.createElement("select"); slots.setAttribute("aria-label", "Available appointment time"); slots.disabled = true;
    const save = node("button", "Save new appointment time", "button button-red"); save.type = "button"; save.disabled = true;
    const feedback = node("p", "Choose a date to see open times.", "admin-status");
    reschedule.append(date, slots, save, feedback); card.append(reschedule);
    actions.querySelector('[data-action="reschedule"]').addEventListener("click", () => { reschedule.hidden = !reschedule.hidden; });
    date.addEventListener("change", async () => {
      slots.replaceChildren(); slots.disabled = true; save.disabled = true; feedback.textContent = "Checking open times…";
      try {
        const result = await api(`/api/admin/availability?date=${encodeURIComponent(date.value)}&id=${encodeURIComponent(item.id)}`);
        for (const slot of result.slots) { const option = document.createElement("option"); option.value = slot.startsAt; option.textContent = slot.label; slots.append(option); }
        slots.disabled = !result.slots.length; save.disabled = !result.slots.length;
        feedback.textContent = result.slots.length ? "Times shown are open now; saving will check once more." : "No open times on this date. Choose another date.";
      } catch (error) { feedback.textContent = error.message; }
    });
    save.addEventListener("click", () => runAction(item, "reschedule", { appointmentAt: slots.value }, feedback, save));
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

function actionButton(label, action, item) {
  const button = node("button", label, "logout"); button.type = "button"; button.dataset.action = action;
  if (action !== "reschedule") button.addEventListener("click", async () => {
    const prompt = action === "decline" ? "Decline this estimate request?" : action === "complete" ? "Mark this appointment completed?" : "Cancel this request/appointment? If a Stripe deposit was paid, this will not refund it; handle any refund separately in Stripe.";
    if (window.confirm(prompt)) await runAction(item, action, {}, deskMessage, button);
  });
  return button;
}

async function runAction(item, action, extra, feedback, button) {
  button.disabled = true; feedback.textContent = action === "reschedule" ? "Updating appointment…" : "Saving…";
  try {
    const result = await api("/api/admin/appointment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id, action, ...extra }) });
    await loadRequests();
    deskMessage.textContent = result.message || "Appointment updated.";
  } catch (error) { feedback.textContent = error.message; button.disabled = false; }
}

async function loadRequests() {
  deskMessage.textContent = "Loading estimate requests…";
  try {
    const result = await api("/api/admin/requests");
    allRequests = result.requests;
    renderRequests();
    deskMessage.textContent = "";
  } catch (error) {
    if (error.message.includes("sign in")) { desk.hidden = true; loginPanel.hidden = false; }
    deskMessage.textContent = error.message;
  }
}

function renderRequests() {
  const filtered = statusFilter.value === "all" ? allRequests : allRequests.filter((item) => item.status === statusFilter.value);
  requestsRoot.replaceChildren();
  if (!allRequests.length) requestsRoot.append(node("p", "No estimate requests yet."));
  else if (!filtered.length) requestsRoot.append(node("p", "No appointments in this status."));
  else for (const item of filtered) requestsRoot.append(renderRequest(item));
}

statusFilter.addEventListener("change", renderRequests);

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
