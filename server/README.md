# xylvar.top server

The static site plus a small backend, in one Dokploy app, on one domain.

## What it does

- `POST /api/contact`: audit enquiry / contact form. Validates, rate
  limits (5 per IP per 10 minutes), honeypot, stores a lead, emails the
  team and sends the visitor an auto-reply. Email failures are logged,
  never shown to the visitor, because the lead is already stored.
- `POST /api/newsletter`: signup. Validates, stores a subscriber
  (re-subscribing updates instead of duplicating), sends a welcome email
  with a one-click unsubscribe link.
- `GET /api/newsletter/unsubscribe?id=..&t=..`: marks a subscriber out.
- `GET /api/admin/leads`, `/api/admin/subscribers`, `/api/admin/email-log`:
  token-protected JSON. The admin page at `/admin` (not linked from the
  public site) renders them and downloads a CSV. The token travels as
  the `x-admin-token` header and lives in session storage only.
- `GET /api/health`: storage mode and whether email is configured.

## Storage and email

- Postgres when `DATABASE_URL` is set. Tables (`leads`, `subscribers`,
  `email_log`) are created on boot. Without it, a local JSON file
  (`server/data.json`, gitignored) is used for local testing only, and
  `/api/health` says so.
- Resend when `RESEND_API_KEY` is set. Without it, submissions are still
  stored and email attempts are logged as `skipped`, so nothing is lost
  silently.

## Dokploy setup (from the current Static app)

1. Change the xylvar-site app build type from Static to Dockerfile,
   container port 3000, domain xylvar.top unchanged.
2. Add a Postgres service in the same project and link its
   `DATABASE_URL` into the app.
3. Set these env vars in the app (values are secrets, never committed):
   - `DATABASE_URL`: from the linked Postgres service
   - `RESEND_API_KEY`: Resend key for the xylvar.top domain
   - `EMAIL_FROM`: `xylvar <info@xylvar.top>` (default if unset)
   - `TEAM_EMAIL`: `info@xylvar.top` (default if unset)
   - `ADMIN_TOKEN`: a long random token you choose; this is the only
     key to the admin view
   - `APP_URL`: `https://xylvar.top`
4. Deploy, then check `/api/health` (storage should read `postgres`,
   email `configured`) and submit one test enquiry and one test signup.

## Frontend behaviour

The contact form posts to `/api/contact` first. Only if the server
cannot be reached, or returns a server error, does it fall back to the
old mailto summary (visitor sends from their own email app). A
validation error from the server is shown as-is, not turned into a
mailto, so bad data is never silently mailed. The newsletter form posts
to `/api/newsletter` and, on server failure, points the visitor to
emailing info@xylvar.top to subscribe.

## What this is not, yet

- No broadcast sending: the newsletter stores subscribers and sends a
  welcome email, but there is no campaign composer or bulk sender yet.
- No login beyond the admin token. Anyone with the token can read
  leads, subscribers and the email log, so treat it like a password.
- No backup job: Dokploy Postgres backups are a separate step to set
  up once live.
