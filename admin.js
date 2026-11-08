const loginPanel = document.getElementById("login-panel");
const desk = document.getElementById("desk");
const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");
const deskMessage = document.getElementById("desk-message");
const requestsRoot = document.getElementById("requests");
const statusFilter = document.getElementById("status-filter");
const calendarView = document.getElementById("calendar-view");
const appointmentsView = document.getElementById("appointments-view");
const calendarGrid = document.getElementById("calendar-grid");
const calendarAgenda = document.getElementById("calendar-agenda");
const calendarMessage = document.getElementById("calendar-message");
const calendarMonthLabel = document.getElementById("calendar-month");
const installButton = document.getElementById("install-app");
let allRequests = [];
let recentRequests = [];
let calendarAppointments = [];
const easternToday = easternDateKey(new Date());
let calendarMonth = new Date(Number(easternToday.slice(0, 4)), Number(easternToday.slice(5, 7)) - 1, 1);
let selectedCalendarDate = easternToday;
let selectedCalendarAppointmentId = null;
let installPrompt = null;
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
    await loadCalendar();
    deskMessage.textContent = result.message || "Appointment updated.";
  } catch (error) { feedback.textContent = error.message; button.disabled = false; }
}

async function loadRequests() {
  deskMessage.textContent = "Loading estimate requests…";
  try {
    const result = await api("/api/admin/requests");
    recentRequests = result.requests;
    allRequests = mergeRequests(recentRequests, calendarAppointments);
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

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function easternDateKey(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return parts.year + "-" + parts.month + "-" + parts.day;
}

function calendarMonthKey(date = calendarMonth) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

function mergeRequests(...groups) {
  const byId = new Map();
  for (const item of groups.flat()) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function appointmentTime(value) {
  return new Date(value).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

function appointmentStatus(item) {
  return statusNames[item.status] || String(item.status || "").replaceAll("_", " ");
}

function setActiveView(view) {
  const showCalendar = view === "calendar";
  calendarView.hidden = !showCalendar;
  appointmentsView.hidden = showCalendar;
  document.querySelectorAll(".admin-views [data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
}

async function loadCalendar() {
  calendarMessage.textContent = "Loading appointments…";
  try {
    const result = await api("/api/admin/calendar?month=" + encodeURIComponent(calendarMonthKey()));
    calendarAppointments = result.appointments;
    if (selectedCalendarAppointmentId && !calendarAppointments.some((item) => item.id === selectedCalendarAppointmentId)) selectedCalendarAppointmentId = null;
    allRequests = mergeRequests(recentRequests, calendarAppointments);
    renderRequests();
    renderCalendar();
    calendarMessage.textContent = "";
  } catch (error) {
    calendarMessage.textContent = error.message;
    if (error.message.includes("sign in")) { desk.hidden = true; loginPanel.hidden = false; }
  }
}

function renderCalendar() {
  const displayDate = new Date(Date.UTC(calendarMonth.getFullYear(), calendarMonth.getMonth(), 15, 12));
  calendarMonthLabel.textContent = displayDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", year: "numeric" });
  calendarGrid.replaceChildren();
  const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1).getDay();
  const cursor = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1 - firstDay);
  for (let i = 0; i < 42; i++) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + i);
    const key = dateKey(date);
    const appointments = calendarAppointments.filter((item) => easternDateKey(item.appointment_at) === key);
    const outsideMonth = date.getMonth() !== calendarMonth.getMonth() || date.getFullYear() !== calendarMonth.getFullYear();
    const cell = node("div", undefined, "calendar-day" + (outsideMonth ? " is-outside-month" : "") + (key === selectedCalendarDate ? " is-selected" : ""));
    const dateButton = node("button", undefined, "calendar-date-button");
    dateButton.type = "button";
    dateButton.setAttribute("aria-label", date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + ", " + appointments.length + " appointment" + (appointments.length === 1 ? "" : "s"));
    dateButton.append(node("span", date.getDate(), "calendar-day-number"));
    if (appointments.length) {
      dateButton.append(node("span", appointments.length + " job" + (appointments.length === 1 ? "" : "s"), "calendar-day-count"));
    }
    dateButton.addEventListener("click", () => selectCalendarDate(key, outsideMonth));
    cell.append(dateButton);
    if (appointments.length) {
      const labels = node("div", undefined, "calendar-day-events");
      for (const item of appointments.slice(0, 2)) {
        const eventButton = node("button", appointmentTime(item.appointment_at) + " " + item.name, "calendar-day-event");
        eventButton.type = "button";
        eventButton.title = appointmentTime(item.appointment_at) + " · " + item.name + " · " + (item.service_address || "No address saved");
        eventButton.setAttribute("aria-label", "Open " + item.name + " appointment details");
        eventButton.addEventListener("click", () => selectCalendarDate(key, outsideMonth, item.id));
        labels.append(eventButton);
      }
      cell.append(labels);
    }
    calendarGrid.append(cell);
  }
  renderCalendarAgenda();
}

function selectCalendarDate(key, outsideMonth, appointmentId = null) {
  selectedCalendarDate = key;
  selectedCalendarAppointmentId = appointmentId;
  if (outsideMonth) {
    calendarMonth = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
    loadCalendar().then(() => {
      const dayAppointments = calendarAppointments.filter((item) => easternDateKey(item.appointment_at) === selectedCalendarDate);
      if (!selectedCalendarAppointmentId && dayAppointments.length) selectedCalendarAppointmentId = dayAppointments[0].id;
      renderCalendar();
      scrollToCalendarDetails(selectedCalendarAppointmentId);
    });
    return;
  }
  const dayAppointments = calendarAppointments.filter((item) => easternDateKey(item.appointment_at) === selectedCalendarDate);
  if (!selectedCalendarAppointmentId && dayAppointments.length) selectedCalendarAppointmentId = dayAppointments[0].id;
  renderCalendar();
  scrollToCalendarDetails(selectedCalendarAppointmentId);
}

function scrollToCalendarDetails(appointmentId) {
  window.requestAnimationFrame(() => {
    const event = appointmentId ? document.getElementById("calendar-event-" + appointmentId) : null;
    if (event) {
      const manage = event.querySelector(".calendar-manage");
      if (manage) manage.open = true;
      event.scrollIntoView({ behavior: "smooth", block: "start" });
    } else calendarAgenda.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderCalendarAgenda() {
  calendarAgenda.replaceChildren();
  const selectedDate = new Date(selectedCalendarDate + "T12:00:00Z");
  calendarAgenda.append(node("h3", "Appointments for " + selectedDate.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" })));
  const appointments = calendarAppointments.filter((item) => easternDateKey(item.appointment_at) === selectedCalendarDate).sort((a, b) => new Date(a.appointment_at) - new Date(b.appointment_at));
  if (!appointments.length) {
    calendarAgenda.append(node("p", "No confirmed jobs on this day.", "calendar-empty"));
    return;
  }
  for (const item of appointments) {
    const event = node("article", undefined, "calendar-event");
    event.id = "calendar-event-" + item.id;
    const head = node("div", undefined, "calendar-event-head");
    const info = node("div");
    info.append(node("p", appointmentTime(item.appointment_at) + " · " + (item.appointment_duration_minutes / 60) + " hour" + (item.appointment_duration_minutes === 60 ? "" : "s"), "calendar-event-time"));
    info.append(node("h4", item.name));
    head.append(info, node("span", appointmentStatus(item), "eyebrow"));
    event.append(head);
    event.append(node("p", item.year + " " + item.make + " " + item.model + " · " + item.vehicle_type));
    const serviceNames = displayServiceNames(item.services).concat(item.addons.map((addon) => "Add-on: " + addon));
    event.append(node("p", "Services: " + serviceNames.join(", ")));
    const contact = node("p");
    const phone = node("a", item.phone); phone.href = "tel:" + item.phone;
    const email = node("a", item.email); email.href = "mailto:" + item.email;
    contact.append(phone, document.createTextNode(" · "), email);
    event.append(contact);
    event.append(node("p", "Address: " + (item.service_address || "Not provided")));
    event.append(node("p", item.payment_method === "stripe"
      ? "Online deposit paid: " + money(item.deposit_cents) + " · Estimate: " + money(item.estimate_cents)
      : "Cash booking · No deposit · " + money(item.estimate_cents) + " due at appointment"));
    const manage = node("details", undefined, "calendar-manage");
    if (item.id === selectedCalendarAppointmentId) manage.open = true;
    manage.append(node("summary", "View details and manage appointment"));
    manage.append(renderRequest(item));
    event.append(manage);
    calendarAgenda.append(event);
  }
}

statusFilter.addEventListener("change", renderRequests);
document.querySelectorAll(".admin-views [data-view]").forEach((button) => button.addEventListener("click", () => setActiveView(button.dataset.view)));
document.getElementById("calendar-prev").addEventListener("click", () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1); selectedCalendarDate = dateKey(calendarMonth); selectedCalendarAppointmentId = null; loadCalendar(); });
document.getElementById("calendar-next").addEventListener("click", () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1); selectedCalendarDate = dateKey(calendarMonth); selectedCalendarAppointmentId = null; loadCalendar(); });
document.getElementById("calendar-today").addEventListener("click", () => { const today = easternDateKey(new Date()); calendarMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1); selectedCalendarDate = today; selectedCalendarAppointmentId = null; loadCalendar(); });

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installButton.hidden = true;
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "Signing in…";
  try {
    await api("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: document.getElementById("owner-password").value }) });
    document.getElementById("owner-password").value = "";
    loginPanel.hidden = true; desk.hidden = false; await loadRequests(); await loadCalendar();
  } catch (error) { loginMessage.textContent = error.message; }
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/admin/login", { method: "DELETE" });
  desk.hidden = true; loginPanel.hidden = false; loginMessage.textContent = "You have signed out.";
});
