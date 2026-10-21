const query = new URLSearchParams(location.search);
const token = query.get("token") || "";
const message = document.getElementById("estimate-message");
const details = document.getElementById("estimate-details");
const acceptButton = document.getElementById("accept-estimate");
const payButton = document.getElementById("pay-deposit");
const depositPanel = document.getElementById("deposit-panel");
const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
let paymentPolls = 0;

async function api(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "This estimate could not be loaded.");
  return data;
}

function showPaymentState(status) {
  const checkout = query.get("checkout");
  if (status === "booked") {
    message.textContent = "Payment received. Your booking is confirmed—Killer Detailing will contact you with scheduling details.";
    acceptButton.hidden = true; payButton.hidden = true; depositPanel.hidden = false;
  } else if (checkout === "success") {
    message.textContent = "Payment is being verified. This page will show your booking as confirmed only after Stripe confirms the payment.";
  } else if (checkout === "cancel") {
    message.textContent = status === "accepted" ? "Checkout was canceled. Your estimate remains accepted, and you can pay the deposit when ready." : "Checkout was canceled.";
  }
}

async function loadEstimate() {
  if (!token) throw new Error("This estimate link is not valid.");
  const item = await api(`/api/customer/estimate?token=${encodeURIComponent(token)}`);
  details.hidden = false;
  document.getElementById("customer-line").textContent = `Prepared for ${item.name}`;
  document.getElementById("vehicle-line").textContent = `${item.vehicle} · ${item.vehicleType}`;
  document.getElementById("services-line").textContent = `Services: ${item.services.join(", ")}`;
  document.getElementById("addons-line").textContent = item.addons.length ? `Area add-ons: ${item.addons.join(", ")}` : "No area add-ons selected.";
  document.getElementById("note-line").textContent = item.note || "";
  document.getElementById("total-line").textContent = `Approved estimate: ${money(item.estimateCents)}`;
  document.getElementById("deposit-line").textContent = `25% deposit: ${money(item.depositCents)}`;
  message.textContent = "";
  if (item.status === "estimate_sent") { acceptButton.hidden = false; }
  if (item.status === "accepted") { depositPanel.hidden = false; payButton.hidden = false; }
  showPaymentState(item.status);
  if (query.get("checkout") === "success" && item.status === "accepted" && paymentPolls < 20) {
    paymentPolls++;
    setTimeout(loadEstimate, 3000);
  } else if (query.get("checkout") === "success" && item.status === "accepted") {
    message.textContent = "Stripe is still verifying the payment. Please refresh this page in a moment; your booking will be confirmed only after payment is verified.";
  }
}

acceptButton.addEventListener("click", async () => {
  acceptButton.disabled = true; message.textContent = "Recording your acceptance…";
  try {
    await api("/api/customer/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    await loadEstimate();
  } catch (error) { message.textContent = error.message; acceptButton.disabled = false; }
});

payButton.addEventListener("click", async () => {
  payButton.disabled = true; message.textContent = "Opening secure Stripe checkout…";
  try {
    const result = await api("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (result.booked || result.processing) { message.textContent = "Payment is being verified. Please refresh this page shortly."; payButton.hidden = true; return; }
    location.assign(result.url);
  } catch (error) { message.textContent = error.message; payButton.disabled = false; }
});

loadEstimate().catch((error) => { message.textContent = error.message; });
