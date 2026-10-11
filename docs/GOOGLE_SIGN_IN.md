# Google sign-in (Android) — stage 1

Apple sign-in is deferred until there is an iOS app; there is no Apple code.

## Endpoints (src/routes/googleAuth.js)
| Method | Path | Auth | Result |
|---|---|---|---|
| POST | `/api/auth/google` `{ idToken, accepted_terms? }` | public, 30/15 min per IP | `{ token, user, created, linked }` (same token + user shape as `/login`); `201` for a new account; `200 { needs_consent: true, terms_version, email, name }` when a new account needs the sign-up consent; `403 google_email_unverified`; `401 google_token_invalid`; `409 google_other_linked`; `503 "Google sign-in not configured"` (`code: google_not_configured`) when `GOOGLE_WEB_CLIENT_ID` is unset |
| GET | `/api/auth/identities` | login | `{ password: bool, google: { linked, email, available } }` |
| POST | `/api/auth/google/link` `{ idToken }` | login, 10/15 min per user | `201 { linked: true, email }`; `409 google_in_use` / `google_other_linked` |
| DELETE | `/api/auth/google/unlink` | login | `{ linked: false }`; `409 last_login_method` if the account has no password |
| DELETE | `/api/auth/me` | login | unchanged for password accounts; Google-only accounts send `{ google_id_token }` instead of `{ password }` |

## Rules
- The token is verified on the server with google-auth-library: Google signature, issuer `accounts.google.com`, expiry, audience in `GOOGLE_WEB_CLIENT_ID` (comma list).
- Tokens whose email Google has not verified are refused, so an unverified email never links to or creates an account.
- Linked `sub` -> that user. Else same email as an existing account -> automatic link (`security_logs.event = google_auto_linked`). Else a new account with the same consent record as sign-up (`terms_privacy`, `TERMS_VERSION`); `password_hash` is NULL.
- Password login on a Google-only account fails with the usual "Wrong email or password". Such users can add a password with the existing Forgot password flow (`/api/auth/forgot` + `/reset`, needs email sending configured in production). There is no change-password endpoint.
- Residual risk (known, accepted for stage 1): sign-up does not verify email ownership, so someone who registered a victim's email with a password first keeps that password after the victim's Google sign-in auto-links. Mitigation later: verify email at sign-up, or clear an unverified account's password on auto-link.

## Database: migration 009_user_identities
`user_identities(user_id FK ON DELETE CASCADE, provider 'google', provider_sub, email, email_verified, created_at, last_used_at)`, unique `(provider, provider_sub)` and `(user_id, provider)`, RLS `owner_rows`. `users.password_hash` is nullable.
Rollback keeps data: deploy the previous code, then `CONFIRM_MIGRATE_DOWN=yes node scripts/migrate-down.js 009_user_identities` (renames the table to `user_identities_rolled_back_009`, gives password-less users the unusable hash `!no-password`, restores NOT NULL). Re-applying 009 restores both.

## Config
- Render: `GOOGLE_WEB_CLIENT_ID` = the OAuth **Web application** client id.
- App (eas.json env): `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` = the same Web client id. The Android OAuth client (package `com.raphai.app` + signing SHA-1) only has to exist in the same Google Cloud project; its id is not used in code.

## Tests
`npm run test:google` (also part of `npm test`): real library verification against a local RSA key standing in for Google's certs.
