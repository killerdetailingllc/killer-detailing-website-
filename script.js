const photoAngles = [
  ["front", "Front"], ["rear", "Rear"], ["driver-side", "Driver side"],
  ["passenger-side", "Passenger side"], ["interior-front", "Interior / front"],
  ["interior-rear", "Interior / rear"], ["dashboard-console", "Dashboard / console"],
  ["trunk-hatch-bed", "Trunk / hatch / truck bed"], ["problem-areas", "Problem areas"]
];
const photoFields = document.getElementById("photo-fields");
photoAngles.forEach(([key, title]) => {
  const label = document.createElement("label");
  label.className = "photo-field";
  const caption = document.createElement("span"); caption.textContent = title;
  const input = document.createElement("input");
  input.type = "file"; input.name = `photo-${key}`; input.accept = "image/*"; input.multiple = true;
  input.setAttribute("aria-label", `Upload ${title} photos`);
  const count = document.createElement("small"); count.textContent = "No photos selected";
  input.addEventListener("change", () => {
    const n = input.files.length;
    count.textContent = n ? `${n} photo${n === 1 ? "" : "s"} selected` : "No photos selected";
  });
  label.append(caption, input, count); photoFields.append(label);
});

const form = document.getElementById("estimate-form");
const message = document.getElementById("form-message");
const submitButton = form.querySelector('button[type="submit"]');
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.classList.remove("is-error");
  if (!form.reportValidity()) return;
  if (!form.querySelector('input[name="services"]:checked')) {
    message.textContent = "Please select at least one service.";
    message.classList.add("is-error");
    form.querySelector('input[name="services"]').focus();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "SENDING REQUEST…";
  message.textContent = "Uploading your request and photos securely…";
  try {
    const response = await fetch("/api/requests", { method: "POST", body: new FormData(form), credentials: "same-origin" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Your request could not be sent. Please try again.");
    form.reset();
    photoFields.querySelectorAll('input[type="file"]').forEach((input) => input.dispatchEvent(new Event("change")));
    message.textContent = "Your estimate request was received. The owner will review your details and send a custom estimate.";
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'SEND ESTIMATE REQUEST <span aria-hidden="true">↗</span>';
  }
});
