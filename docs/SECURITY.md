# Security review (2026-10-09)
Verified by reading code, querying the live Supabase catalog (read-only) and `test/security.js`.

## Findings
| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | High | No rate limit on login/register/coach (brute force, cost abuse) | **Fixed**: login 30/IP/15 min + 8 wrong passwords/email/15 min; register 20/IP/h; coach 30/user/min; food parse 30/user/min; API 600/IP/min |
| 2 | High | Deleted user's JWT still accepted; no revocation | **Fixed**: user must exist; `tokens_valid_after` + `POST /api/auth/logout-all` |
| 3 | High | JWT algorithm not pinned; dev secret fallback whenever NODE_ENV≠production | **Fixed**: HS256 only; fallback only in development/test; prod requires ≥32 chars (start-up check). Prod secret: 96 chars |
| 4 | High | `dev-activate` (free paid plan) enabled unless NODE_ENV==="production" | **Fixed**: allow-list development/test |
| 5 | High | No security headers | **Fixed**: helmet (CSP, HSTS, nosniff, frame-deny, no-referrer) |
| 6 | High | CORS `*` in production | **Fixed**: `*` ignored in prod; allow-list only |
| 7 | High | RLS off on all 25 tables; Supabase default ACL grants anon/authenticated full rights on tables created by `postgres` | **Fixed** (defence in depth): RLS on all tables + owner policies on `app.user_id`. Today anon/authenticated have no grants (verified) |
| 8 | High | Sync bcrypt blocks event loop (DoS with #1) | **Fixed**: async bcrypt; constant-time-ish login (dummy hash) |
| 9 | Med | Validation coerced objects/arrays to strings/numbers; impossible dates accepted | **Fixed**: strict scalar types, real dates, money rounded to paise |
| 10 | Med | 5xx logs printed full error objects (pg `detail` can hold emails) | **Fixed**: one-line sanitized log, emails redacted, no bodies/headers |
| 11 | Low | Custom foods exposed creator's user id | **Fixed**: `created_by` hidden, `is_mine` instead |
| 12 | Med | DB TLS without certificate verification | Open: set `DATABASE_SSL_CA` (supported now) |
| 13 | Med | RTDN secret in query string (visible in access logs) | Open: enable `GOOGLE_RTDN_AUDIENCE` (Pub/Sub JWT) |
| 14 | Low | In-memory rate limits (single instance only) | Accepted for beta |
| 15 | Low | Register reveals existing email (409) | Accepted |
| 16 | Low | Bill splits/prefs in AsyncStorage (unencrypted, phone-only) | Accepted; no tokens there |

## Verified OK (no change needed)
- Ownership: every `:id` and list query filters `user_id`; bill payments check bill owner. Cross-user tests for every resource (read/update/delete/export).
- Mass assignment: `validate()` returns only allow-listed fields; dynamic SET columns come from rule keys.
- SQL: parameterised; table names are constants.
- Mobile: token in SecureStore; no supabase-js; no console logs; HTTPS only (cleartext blocked).
- Secrets: `.env` gitignored (both repos); `git log -p` scan of backend history found no keys, passwords, tokens or DB URLs. Nothing to rotate.
- Backend DB role `raphai_app`: not superuser, not BYPASSRLS, owns all tables (so RLS without FORCE does not affect the server).
- `npm audit --omit=dev`: 0 vulnerabilities.

## Rate limits are per process
Move to Postgres/Redis before running >1 instance.
