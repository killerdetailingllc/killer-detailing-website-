# Killer Detailing LLC website — implementation and launch guide

## Current project state

The site is a static project with Cloudflare Pages Functions for estimates, photo storage, owner review, and Stripe deposits. The production deployment uses GitHub's `cloudflare-pages-ready` branch and is attached to `killerdetailingllc.com`; GitHub `main` still contains the older Exterior/Interior/Full Detail form. Keep edits on the production branch and do not treat an unpushed local copy as live.

The public form keeps all six existing service names: Burial, Embalming, Viewing, Resurrection, Preneed (Prior Arrangements), Purple Heart Veteran. Vehicle choices include Full-size SUV and Truck. Trunk, Hatch, and Truck bed are add-on choices. The form accepts up to 15 photos, 8 MB each, 30 MB total; server validation allows JPG, PNG, WebP, and HEIC.

## What the new code implements

- Public estimate requests are saved to Cloudflare D1. Uploaded photos are stored in a private R2 bucket. Requests have a five-per-hour limit per IP hash and a honeypot field.
- The owner estimate desk at `/admin.html` requires a password and an HttpOnly, Secure, SameSite session cookie. It lists requests and displays privately stored photos. When email is configured, the owner receives alerts for new requests and accepted estimates.
- The owner enters a custom total. The server calculates the 25% deposit and creates a customer-specific estimate link that expires after seven days. When email is configured, the link and estimate are emailed to the customer automatically; the dashboard also returns the link for manual sending if needed.
- The customer accepts the estimate before checkout is available. Stripe Checkout charges only the server-calculated 25% deposit. A signed Stripe webhook at `/api/stripe/webhook` marks the booking confirmed only after verified successful payment.
- When email is configured, the customer and owner receive booking confirmation after the verified payment webhook succeeds.
- The Stripe account was accessible during setup and its webhook destination list was empty. No Stripe API keys or other secrets have been read or added to the code.

The flow is implemented in source, but is not live until Pages, D1, R2, and secrets are configured and the site is deployed. The Stripe account is confirmed by the owner; no payment integration is active yet.

## Cloudflare setup

The domain is already registered with Cloudflare, the zone is active on the Free plan, and DNS is hosted there. Existing root and `www` web records currently point to GitHub Pages. The DNS zone also contains iCloud mail records. Keep all mail records unchanged during the website migration. Do not change the root or `www` records until the Cloudflare Pages project is built and the custom domain is ready to verify.

1. In Cloudflare Pages, create a project connected to `killerdetailingllc/killer-detailing-website-`. The site is plain HTML/JS: no build command; project root is the build output directory. Connecting GitHub requires approving Cloudflare's repository access in GitHub.
2. Bind the existing D1 database to the Pages project as `DB`. The base schema is `migrations/0001_init.sql`; apply each later migration in order before deploying code that uses it.
3. Create a private R2 bucket and bind it to the Pages project as `PHOTOS`.
4. Add secrets and variables in Pages project settings. In addition to the existing admin, Stripe, and email settings, iCloud calendar setup uses `APPLE_CALENDAR_EMAIL` (the Apple Account sign-in email, as a text variable) and `APPLE_CALENDAR_APP_PASSWORD` (an encrypted Secret). Never put secret values in source or send them through chat. Never use a live Stripe secret for initial testing.
5. To activate email, create a Resend account on its Free plan, verify `killerdetailingllc.com`, and create an API key. Add the DNS records Resend provides without deleting existing mail records. Review the current SPF record and merge any required Resend authorization into that existing record; do not create a second SPF record. Save the API key in Cloudflare as `RESEND_API_KEY`. Set `OWNER_NOTIFICATION_EMAIL` to the inbox for alerts. Without these settings, no emails are sent.
6. Add a Stripe webhook destination for the deployed URL `https://killerdetailingllc.com/api/stripe/webhook` with events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Store its signing secret as `STRIPE_WEBHOOK_SECRET`. Use the test-mode webhook and `sk_test_...` secret during the test pass.
7. Add `killerdetailingllc.com` and `www.killerdetailingllc.com` as custom domains in Pages. Only after Pages is built and the custom domains are ready, update the existing root and `www` records to the Pages-provided targets. Preserve existing email DNS records; add only the exact sender-verification records given by Resend and carefully merge SPF if the provider requires it.
8. Review the privacy notice, estimate/deposit/cancellation terms, and business contact details. The owner must approve the final copy before public launch.

Cloudflare Pages and Workers have free tiers; D1 and R2 include monthly free quotas. Usage beyond quotas may cost money. The domain renewal and Stripe transaction fees are separate. GitHub Pages is not appropriate for the live commercial detailing site under GitHub's current usage restrictions. Check [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Before launch

1. Confirm all service names and approved descriptions; the existing labels were kept as requested.
2. Connect GitHub to Cloudflare Pages and approve the repository permission prompt.
3. Configure D1, R2, Stripe test secrets, and (if automatic emails are desired) the Resend settings above. The owner must create/enter all secret values directly in Cloudflare; never send them here.
4. Deploy to a Cloudflare preview URL. Verify request/photo storage, private admin sign-in, request and estimate email delivery, seven-day link expiry, acceptance, 25% deposit calculation, Stripe test checkout, webhook signature handling, failed/canceled payment behavior, duplicate webhook deliveries, and confirmation only after webhook success.
5. Add and verify the custom domains, change only the root/`www` web DNS records, verify HTTPS, and re-check email DNS records.
6. Switch Stripe from test to live only after all approval and test steps are complete, then configure the live secret and webhook secret in Cloudflare.

## Account status observed

- Stripe is the selected payment provider; no webhook destination was configured yet.
- Cloudflare hosts the domain and DNS; the domain registration is active through August 3, 2027, and the zone is on the Free plan.
- Cloudflare showed no Workers connected at the time of inspection.
- The current root and `www` records target GitHub Pages. Existing iCloud mail DNS records are present and must be preserved.
- The GitHub tab currently shows a signed-out view. Repository access is public, but GitHub authentication is needed to connect the repository to Cloudflare.

No DNS records, hosting settings, Stripe settings, secrets, or GitHub files have been changed through the account dashboards in this task.

## Appointment calendar additions

The estimate request form collects the service address. The owner sets a proposed appointment date, start time, and duration in the estimate desk. The customer sees that proposed time in the estimate email and private estimate link. After the Stripe webhook verifies the deposit, the site creates an iCloud Calendar event containing customer contact details, service address, vehicle, services, add-ons, estimate, and deposit. The default duration is two hours and can be changed for each appointment.

Before deploying the calendar changes, apply `migrations/0002_calendar_appointments.sql` to the production D1 database. Then add `APPLE_CALENDAR_EMAIL` as a Cloudflare Pages text variable using the Apple Account sign-in email that owns the calendar, and add `APPLE_CALENDAR_APP_PASSWORD` as an encrypted Cloudflare Secret. The optional text variable `APPLE_CALENDAR_NAME` selects a calendar by its displayed name; if omitted, the first writable calendar is used. Create the app-specific password from Apple Account settings and enter it directly in Cloudflare; never send it through chat or store it in GitHub. Apple requires two-factor authentication for app-specific passwords. See [Apple’s app-specific password instructions](https://support.apple.com/en-us/102654). If the calendar connection is not configured or temporarily unavailable, payment still confirms the booking and the owner email explains that the calendar entry needs attention.
