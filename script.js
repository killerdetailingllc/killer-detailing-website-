document.getElementById("booking-form").addEventListener("submit", function(e){
  e.preventDefault();
  const msg=document.getElementById("form-message");
  msg.textContent="Booking system is being connected. Your form is working — next we’ll connect the calendar and Stripe.";
});
document.getElementById("date").min=new Date().toISOString().split("T")[0];
