# Architecture
- **Mobile**: Expo SDK 57, React Native 0.86, expo-router, TypeScript. Tabs: Home, Health, Fitness, Wealth, You. Token in expo-secure-store. Talks only to the backend (no supabase-js). Health Connect via react-native-health-connect; Play Billing via expo-iap.
- **Backend**: Node 22, Express 4, `pg`. Render free (Singapore), auto-deploy from GitHub `shalomr7/raphai-backend` main. Single instance.
- **DB**: Supabase Postgres 17, Mumbai (ap-south-1). App role `raphai_app` (owner of all tables, not superuser, not BYPASSRLS). Session pooler.
- **Request path**: helmet -> CORS -> per-IP limit -> JSON (100 kb) -> route (requireAuth -> per-route limits -> validate() allow-list -> SQL with `user_id = $n`).
- **Migrations**: `src/migrations/` run by `db.init()` on every start (advisory lock, one transaction, recorded in `schema_migrations`).
- **AI**: `src/ai/` — tool registry (user-scoped, read-only + propose/confirm), guardrails, Gemini REST client, provider wired to `services/aiCoach.setAiProvider` when `GEMINI_API_KEY` is set; else rule-based.
- **Key modules**: `services/intelligence.js` (HeartScore/insights), `services/googlePlay.js`, `services/account.js` (deletion), `services/securityLog.js`.
## Roadmap (Android beta first)
| Phase | Scope | Status |
|---|---|---|
| 1 Architecture & security | Ownership tests, token hardening, rate limits, CORS, helmet, RLS, migrations, paise columns, AI scaffold | Done 2026-10-09 |
| 2 Core Life OS | Password reset (email), switch money reads to paise, Privacy Centre polish, real-device QA of Health Connect + reminders, bank-notification capture decision | Next |
| 3 AI orchestration | Set GEMINI_API_KEY + models, coach UI for proposals/confirm, Daily Brief via AI, pattern engine with confidence labels, chat storage per Privacy Policy | After 2 |
| 4 Sign-in & wearables (Android) | Google Sign-In (native ID token -> backend verify), Google Health API (Fitbit) via OAuth. iOS/Apple/HealthKit/Garmin/WHOOP/Oura/Samsung/AA: documented only | After 3 |
| 5 Monetisation & privacy | Play Billing go-live (service account, RTDN, products), DPDP consent flows, India log retention, support email/address in legal | Parallel to 3–4 |
| 6 QA & beta | Closed testing track, Play Data safety + Health declaration, crash reporting, load test | Last |
