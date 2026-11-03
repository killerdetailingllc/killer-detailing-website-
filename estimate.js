const query = new URLSearchParams(location.search);
const token = query.get("token") || "";
const message = document.getElementById("estimate-message");
const details = document.getElementById("estimate-details");
const acceptButton = document.getElementById("accept-estimate");
const payButton = document.getElementById("pay-deposit");
const cashButton = document.getElementById("confirm-cash");
const depositPanel = document.getElementById("deposit-panel");
const cashPanel = document.getElementById("cash-panel");
const picker = document.getElementById("appointment-picker");
const dateInput = document.getElementById("appointment-date");
const timeSelect = document.getElementById("appointment-time");
const chooseButton = document.getElementById("choose-appointment");
const changeAppointmentButton = document.getElementById("change-appointment");
const slotMessage = document.getElementById("slot-message");
const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const displayServiceNames = (services) => services.map((service) => ({ "Exterior Detail": "Burial", "Interior Detail": "Embalming", "Full Detail": "Viewing" })[service] || service);
let paymentPolls = 0;
let currentEstimate = null;

async function api(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "This estimate could not be loaded.");
  return data;
}

function setPickerBounds() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const limit = new Date(`${parts}T12:00:00Z`); limit.setUTCDate(limit.getUTCDate() + 60);
  dateInput.min = parts;
  dateInput.max = limit.toISOString().slice(0, 10);
}

async function loadSlots() {
  const date = dateInput.value;
  chooseButton.hidden = true;
  timeSelect.replaceChildren(new Option(date ? "Checking openings…" : "Choose a date to see openings", ""));
  slotMessage.textContent = "";
  if (!date) return;
  try {
    const result = await api(`/api/customer/availability?token=${encodeURIComponent(token)}&date=${encodeURIComponent(date)}`);
    timeSelect.replaceChildren();
    if (!result.slots.length) {
      timeSelect.append(new Option("No openings for this date", ""));
      slotMessage.textContent = "Choose another date. Open hours are Monday–Friday, 6–11 p.m., and Saturday–Sunday, 10 a.m.–11 p.m. Eastern.";
    } else {
      timeSelect.append(new Option("Select an available time", ""));
      for (const slot of result.slots) timeSelect.append(new Option(slot.label, slot.startsAt));
    }
  } catch (error) {
    timeSelect.replaceChildren(new Option("Availability could not be loaded", ""));
    slotMessage.textContent = error.message;
  }
}

function showPaymentState(status) {
  const checkout = query.get("checkout");
  if (status === "booked") {
    acceptButton.hidden = true; payButton.hidden = true; cashButton.hidden = true; picker.hidden = true;
    if (currentEstimate?.paymentMethod === "cash") {
      message.textContent = "Your appointment is confirmed. You selected cash; the full estimate is due at the appointment.";
      depositPanel.hidden = true; cashPanel.hidden = false;
    } else {
      message.textContent = "Payment received. Your appointment is confirmed. Killer Detailing will contact you if anything else is needed.";
      depositPanel.hidden = false; cashPanel.hidden = true;
    }
  } else if (checkout === "success") {
    message.textContent = "Payment is being verified. This page will show your booking as confirmed only after Stripe confirms the payment.";
  } else if (checkout === "cancel") {
    message.textContent = status === "accepted" ? "Checkout was canceled. Your estimate remains accepted. You can retry the online deposit or choose cash at the appointment." : "Checkout was canceled.";
  }
}

async function loadEstimate() {
  if (!token) throw new Error("This estimate link is not valid.");
  const item = await api(`/api/customer/estimate?token=${encodeURIComponent(token)}`);
  currentEstimate = item;
  details.hidden = false;
  document.getElementById("customer-line").textContent = `Prepared for ${item.name}`;
  document.getElementById("vehicle-line").textContent = `${item.vehicle} · ${item.vehicleType}`;
  document.getElementById("services-line").textContent = `Services: ${displayServiceNames(item.services).join(", ")}`;
  document.getElementById("addons-line").textContent = item.addons.length ? `Area add-ons: ${item.addons.join(", ")}` : "No area add-ons selected.";
  document.getElementById("appointment-line").textContent = item.appointmentAt ? `${item.slotSelected || item.status === "booked" ? "Selected appointment" : "Previously proposed time"}: ${new Date(item.appointmentAt).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "full", timeStyle: "short" })} Eastern · ${item.appointmentDurationMinutes / 60} hours` : `Estimated service time: ${item.appointmentDurationMinutes / 60} hours`;
  document.getElementById("address-line").textContent = item.serviceAddress ? `Service address: ${item.serviceAddress}` : "";
  document.getElementById("note-line").textContent = item.note || "";
  document.getElementById("total-line").textContent = `Approved estimate: ${money(item.estimateCents)}`;
  document.getElementById("deposit-line").textContent = `25% deposit: ${money(item.depositCents)}`;
  document.getElementById("cash-line").textContent = `Cash due at appointment: ${money(item.estimateCents)}`;
  message.textContent = "";
  acceptButton.hidden = item.status !== "estimate_sent";
  const needsTime = item.status === "accepted" && !item.slotSelected;
  picker.hidden = !needsTime;
  changeAppointmentButton.hidden = item.status !== "accepted" || !item.slotSelected;
  payButton.hidden = item.status !== "accepted" || !item.slotSelected;
  cashButton.hidden = item.status !== "accepted" || !item.slotSelected;
  depositPanel.hidden = item.status !== "accepted" || !item.slotSelected;
  cashPanel.hidden = item.status !== "accepted" || !item.slotSelected;
  showPaymentState(item.status);
  if (needsTime) {
    setPickerBounds();
    const proposedDate = item.appointmentAt ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(item.appointmentAt)) : "";
    if (proposedDate) dateInput.value = proposedDate;
    if (dateInput.value) await loadSlots();
  }
  if (query.get("checkout") === "success" && item.status === "accepted" && paymentPolls < 20) {
    paymentPolls++;
    setTimeout(loadEstimate, 3000);
  } else if (query.get("checkout") === "success" && item.status === "accepted") {
    message.textContent = "Stripe is still verifying the payment. Please refresh this page in a moment; your booking will be confirmed only after payment is verified.";
  }
}

changeAppointmentButton.addEventListener("click", async () => {
  picker.hidden = false;
  changeAppointmentButton.hidden = true;
  payButton.hidden = true;
  cashButton.hidden = true;
  depositPanel.hidden = true;
  cashPanel.hidden = true;
  setPickerBounds();
  if (currentEstimate?.appointmentAt) {
    dateInput.value = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(currentEstimate.appointmentAt));
  }
  await loadSlots();
});

dateInput.addEventListener("change", loadSlots);
timeSelect.addEventListener("change", () => { chooseButton.hidden = !timeSelect.value; });
chooseButton.addEventListener("click", async () => {
  chooseButton.disabled = true; slotMessage.textContent = "Saving your appointment time…";
  try {
    await api("/api/customer/select-slot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, appointmentAt: timeSelect.value }) });
    await loadEstimate();
  } catch (error) { slotMessage.textContent = error.message; await loadSlots(); }
  finally { chooseButton.disabled = false; }
});

acceptButton.addEventListener("click", async () => {
  acceptButton.disabled = true; message.textContent = "Recording your acceptance…";
  try {
    await api("/api/customer/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    await loadEstimate();
  } catch (error) { message.textContent = error.message; acceptButton.disabled = false; }
});

cashButton.addEventListener("click", async () => {
  cashButton.disabled = true; message.textContent = "Confirming your cash appointment…";
  try {
    await api("/api/customer/cash-booking", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    await loadEstimate();
  } catch (error) {
    message.textContent = error.message; cashButton.disabled = false;
    if (error.message.includes("Choose an available appointment time")) { await loadEstimate(); slotMessage.textContent = error.message; }
  }
});

payButton.addEventListener("click", async () => {
  payButton.disabled = true; message.textContent = "Opening secure Stripe checkout…";
  try {
    const result = await api("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (result.booked || result.processing) { message.textContent = "Payment is being verified. Please refresh this page shortly."; payButton.hidden = true; return; }
    location.assign(result.url);
  } catch (error) {
    message.textContent = error.message; payButton.disabled = false;
    if (error.message.includes("Choose an available appointment time")) { await loadEstimate(); slotMessage.textContent = error.message; }
  }
});

loadEstimate().catch((error) => { message.textContent = error.message; });
