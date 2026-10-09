# Feature audit (verified 2026-10-09, commit after e8b747d)
Legend: **W** working (covered by tests) · **P** partial · **M** mocked/placeholder · **B** broken · **X** missing.
Evidence: `test/smoke.js` (304 checks), `test/security.js` (73 checks), code reading.

| Area | Feature | Status | Notes |
|---|---|---|---|
| Auth | Email + password, JWT (HS256, 7d) | W | bcrypt; rate-limited; logout-all; deleted users' tokens rejected |
| Auth | Password reset | P | Email code flow built + tested with fake email; live once RESEND_API_KEY/EMAIL_FROM are set |
| Auth | Google / Apple / phone OTP | X | Google planned Phase 4 |
| Profile | Profile, targets, BMI | W | Body fat % gated to Plus |
| Health | Food library, logs, favourites, repeat meal | W | Seeded Indian foods "verified"; custom foods shared |
| Health | Food text parser | W | Rule-based fuzzy match, no AI |
| Health | Water / sleep / mood / weight logs | W | |
| Fitness | Workouts (MET), steps, daily activity | W | |
| Fitness | Health Connect sync (mobile) | P | Code present; not verified on a real device |
| Fitness | Pedometer fallback, HIIT plans | P | Not device-tested |
| Fitness | Wearables | P | Only indirectly via Health Connect |
| Wealth | Expenses, budgets, goals, bills, SIP/EMI | W | Totals computed from integer paise columns (rupee fields kept) |
| Wealth | Bank-notification capture | M | Placeholder screen |
| Wealth | Bill split | P | Phone-only (AsyncStorage) |
| Home | Dashboard, streaks | W | |
| Insights | HeartScore (6 areas), priorities, trends, patterns, brief, profile | W | Rule-based |
| Coach | Rule-based coach + daily limits | W | |
| Coach | Gemini AI coach | P | Scaffold + tools + guardrails tested with fake API; no key in prod |
| Billing | Plans endpoint, trial | W | |
| Billing | Google Play verify + RTDN | P | Tested with fake Google; prod has no GOOGLE_PLAY_* vars (verify returns 503) |
| Billing | dev-activate | W | Only NODE_ENV development/test |
| Privacy | Export, delete (app + web page), consents, security logs + purge | W | |
| Privacy | Inactive-account deletion job | X | Policy says "may" |
| Legal | /privacy, /terms | W | [SUPPORT EMAIL], [POSTAL ADDRESS] still blank |
| Mobile | Photo scan, family, PDF report, imperial, languages | M | "Coming soon" |
## Roadmap (Android beta first)
| Phase | Scope | Status |
|---|---|---|
| 1 Architecture & security | Ownership tests, token hardening, rate limits, CORS, helmet, RLS, migrations, paise columns, AI scaffold | Done 2026-10-09 |
| 2 Core Life OS | Password reset (email), switch money reads to paise, Privacy Centre polish, real-device QA of Health Connect + reminders, bank-notification capture decision | Next |
| 3 AI orchestration | Set GEMINI_API_KEY + models, coach UI for proposals/confirm, Daily Brief via AI, pattern engine with confidence labels, chat storage per Privacy Policy | After 2 |
| 4 Sign-in & wearables (Android) | Google Sign-In (native ID token -> backend verify), Google Health API (Fitbit) via OAuth. iOS/Apple/HealthKit/Garmin/WHOOP/Oura/Samsung/AA: documented only | After 3 |
| 5 Monetisation & privacy | Play Billing go-live (service account, RTDN, products), DPDP consent flows, India log retention, support email/address in legal | Parallel to 3–4 |
| 6 QA & beta | Closed testing track, Play Data safety + Health declaration, crash reporting, load test | Last |
