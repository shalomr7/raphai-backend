# Environment variables (names only)
Backend (Render dashboard; never in git):
| Name | Required | Notes |
|---|---|---|
| DATABASE_URL | yes | Supabase Session pooler, role raphai_app |
| JWT_SECRET | yes | ≥32 chars in production (start-up check) |
| NODE_ENV | yes | `production` on Render |
| JWT_EXPIRES_IN | no | default 7d |
| APP_TZ | no | Asia/Kolkata |
| CORS_ORIGIN | no | leave unset; `*` ignored in production |
| TRUST_PROXY_HOPS | no | 1 on Render |
| DATABASE_SSL / DATABASE_SSL_CA | no | CA turns on cert verification |
| PG_POOL_MAX | no | default 5 |
| GEMINI_API_KEY | no | unset = rule-based coach |
| GEMINI_MODEL_PLUS / _PRO / _ELITE | no | model overrides |
| GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_PLAY_PACKAGE_NAME | for billing | |
| GOOGLE_RTDN_SECRET, GOOGLE_RTDN_AUDIENCE, GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL | for billing | |
| API_RATE_LIMIT_PER_MIN, COACH_RATE_LIMIT_PER_MIN | no | overrides |

Live Render now has: NODE_VERSION, CORS_ORIGIN (`*`, ignored), APP_TZ, NODE_ENV=production, JWT_SECRET, DATABASE_URL. Billing and Gemini vars are not set.

Mobile: `EXPO_PUBLIC_API_URL` (eas.json sets the Render URL). No secrets in the app.
