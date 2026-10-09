# Integrations: feasibility and what the owner must obtain
Checked against official docs on 2026-10-09. Build order is Android-only for beta.

| Integration | Feasible for Android beta? | What you must get | Source |
|---|---|---|---|
| Health Connect | Yes (built) | Play Console Health apps declaration + permissions justification | developer.android.com/health-and-fitness |
| Google Sign-In | Yes (Phase 4) | Google Cloud OAuth client IDs: Web + Android (SHA-1 of EAS keystore **and** Play App Signing key); consent screen. Backend verifies ID token with `google-auth-library` (already installed). Native module needs a dev build | developers.google.com/identity |
| Gemini API | Yes (scaffold done) | `GEMINI_API_KEY` from AI Studio (billing on for paid tier); pick models. **Gemini 2.5 models are limited to existing users; new projects should use 3.5 Flash-Lite / 3.8 Flash** -> set `GEMINI_MODEL_PLUS/PRO/ELITE` and re-check pricing.md costs | ai.google.dev/gemini-api/docs/models |
| Fitbit -> Google Health API | Yes, but OAuth app verification | Google Cloud project, Google Health API enabled, OAuth verification (sensitive scopes). Legacy Fitbit Web API is turned off 2026-10-30, so build only on Google Health API | developers.google.com/health/about |
| Google Play Billing | Yes (built) | Service account JSON with Play access, products/base plans, Pub/Sub RTDN topic + `GOOGLE_RTDN_SECRET` (not yet set on Render) | developer.android.com/google/play/billing |
| Apple Sign-In | Document only | Apple Developer Program ($99/yr). App Store 4.8: with Google login, iOS must also offer a privacy login such as Sign in with Apple | developer.apple.com/app-store/review/guidelines |
| HealthKit | Document only | iOS app + Apple Developer Program, HealthKit entitlement, dev build | developer.apple.com/healthkit |
| Garmin | Document only | Garmin Connect Developer Program approval (business entity, privacy policy). New applications were paused in 2026 | developer.garmin.com/gc-developer-program |
| WHOOP | Document only | WHOOP membership + device; app in developer dashboard; app approval to exceed 10 users | developer.whoop.com/docs |
| Oura | Document only | OAuth app (personal tokens deprecated Dec 2025); approval beyond 10 users; users need active Oura Membership (Gen3+) | cloud.ouraring.com/v2/docs |
| Samsung Health Data SDK | Document only | Partner request with package name + release SHA-256 before distribution (developer mode only for testing) | developer.samsung.com/health/data |
| India Account Aggregator | **Not feasible** as sole proprietorship | FIU must be registered with and regulated by RBI/SEBI/IRDAI/PFRDA. A TSP only provides tech, not eligibility. Option: partner with a regulated FIU | rbi.org.in Master Direction (AA); sahamati.org.in/fiu |
