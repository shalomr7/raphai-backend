# Owner admin dashboard

URL: `https://<server>/admin` (live: https://raphai-backend.onrender.com/admin). Private, `noindex`, never cached.

## Who can sign in
- Only accounts whose email is in `ADMIN_EMAILS` (default `rooppashalemraju@gmail.com`), re-checked on every request.
- Step 1: the normal HeartPurse email + password. Step 2 (extra admin step):
  - `email` mode: a 6-digit code emailed to the admin (needs `RESEND_API_KEY` + `EMAIL_FROM`), or
  - `password` mode: a separate admin password (bcrypt hash in `ADMIN_PASSWORD_HASH`).
  - Default: email if email sending is configured, else password if the hash is set, else admin sign-in is off (503).
- Session: an admin token valid 30 min (`ADMIN_SESSION_MINUTES`), signed with a key derived from `JWT_SECRET` and audience `heartpurse-admin`. App tokens get 403 on `/api/admin/*`; admin tokens get 401 on the app API. "Log out everywhere" also ends admin sessions. The page keeps the token in sessionStorage (gone when the tab closes).
- Rate limits: login 10 / 15 min per IP, 5 wrong passwords per email / 15 min, verify 10 / 15 min per IP, 5 wrong codes per challenge, 120 admin API calls / min.

## Audit
Every admin call writes `security_logs` (kept 1 year): `actor_id` = the admin, `user_id` = the customer concerned, `detail` = section / search query / row count / reason. Events: `admin_login_failed`, `admin_second_step_sent`, `admin_login_success`, `admin_denied`, `admin_view`, `admin_customer_list`, `admin_customer_search`, `admin_customer_view`, `admin_phone_reveal`, `admin_customer_csv`, `admin_user_export`, `admin_user_delete`. A customer's detail page shows the last 10 admin accesses to that record.

## Sections (aggregates only)
Growth, Revenue, Health, Money, AI coach, App health: `GET /api/admin/<section>`. No names, emails, ids or per-user records. Any group of 1-4 users is `"<5"`; averages/percentages from fewer than 5 users are `"<5"`. Metrics without a data source are `{ "not_tracked": true }` ("Not tracked yet").

Not tracked yet: HIIT plan use; SIP/EMI calculator history (only hits since server start, in memory); in-app downgrades to Free; Gemini vs rule-based fallback share on paid plans; coach topics; guardrail blocks; deploy history (only the running commit). API errors/latency are counted in memory since server start.

## Customers (CRM)
`GET /api/admin/customers?q=&plan=&page=&per_page=` (search name / email / id; plan = free | trial | paid | plus | pro | elite), `GET /api/admin/customers/:id`, `GET /api/admin/customers/export.csv`.
Identity + subscription fields only: id, name, email, phone (masked; tap-to-reveal is logged), gender, age, DOB, sign-in method, plan, subscription status, renewal/expiry, signup, last active, Health Connect yes/no, consents, account status; detail adds subscription + payment history (order id, list-price amount, date). The app does not collect phone or date of birth ("Not collected"); sign-in is email + password only.
Never shown: any individual's health readings, finance entries or coach chats (Google Play Health Connect policy, DPDP Act, Privacy Policy).
Support actions (on the customer's request, reason required, logged): `POST /api/admin/customers/:id/export { reason }` (the same file the user gets from GET /api/export) and `POST /api/admin/customers/:id/delete { confirm_id, reason }` (same deletion as the app; admin accounts refused).

Tests: `npm run test:admin` (in `npm test`).
