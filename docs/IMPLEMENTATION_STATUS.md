# Implementation status
Last update: 2026-10-09 (Phase 2, part 1).

Done in Phase 1:
- Security: rate limits, token revocation/user check, HS256 pin, secret checks, dev-activate allow-list, helmet, strict CORS, async bcrypt, strict validation, sanitized logs, creator id hidden.
- DB: versioned migrations 001–006 (startup path), indexes, paise columns, RLS + owner policies.
- AI: `src/ai/` tool registry (getHealthSummary, getFitnessSummary, getFinanceSummary, getGoals, getTrends, getDailyBrief, proposeLogEntry), Gemini provider (consent-gated, timeouts, token cap, injection guard), `POST /api/coach/confirm`.
- Tests: `test/security.js` (73 checks); smoke 304.
- Mobile: no code change needed (SecureStore already, no supabase-js, no logs).

Done in Phase 2 (part 1):
- Password reset: `POST /api/auth/forgot` (6-digit code by email, 15 min, HMAC-hashed in `password_resets` (migration 007), 5 tries, IP + per-email limits, same answer for every email) and `POST /api/auth/reset` (revokes old tokens, security log). Email via Resend (`src/services/email.js`); needs `RESEND_API_KEY` + `EMAIL_FROM` on Render, else 503 `email_unavailable` in production.
- Money: wealth sums/totals read integer `*_paise` columns (`src/utils/money.js`); responses add `*_paise` fields, rupee fields kept. Mobile sums in paise and formats ₹ with paise when not whole.
- Mobile: Forgot-password flow (login link -> email -> code + new password); steps card says "Phone sensor (backup)".
- Tests: security 89 checks, smoke 304.

Left: rest of Phase 2 in FEATURE_AUDIT.md (Privacy Centre polish, real-device QA, bank-notification decision; then make paise the write source and drop the generated expressions).
