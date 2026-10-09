# Release checklist (Android beta)
- [x] Phase 1 security fixes deployed; /health, /privacy, /terms, /delete-account return 200
- [ ] Fill [SUPPORT EMAIL] and [POSTAL ADDRESS] in legal docs
- [ ] Render: set GOOGLE_PLAY_* and GOOGLE_RTDN_* vars; Pub/Sub push with JWT audience
- [ ] Render: DATABASE_SSL_CA (Supabase CA)
- [ ] Play Console: products/base plans, Data safety, Health apps declaration, account-deletion URL
- [ ] Real-device test: Health Connect, background sync, reminders, purchase + restore
- [ ] Optional for beta: GEMINI_API_KEY + models; coach proposal UI
- [ ] EAS production build (not started) -> closed testing track
