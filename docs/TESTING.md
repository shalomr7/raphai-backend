# Testing
Local Postgres: `bash /workspace/work/pg_local_setup.sh` (127.0.0.1:5433).

| Command | What | Result 2026-10-09 |
|---|---|---|
| `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/raphai_test node test/smoke.js` | API end-to-end | 304/304 pass |
| `... node test/security.js` | tokens on 85 protected routes × 6 bad tokens, cross-user per resource, mass assignment, validation, rate limits, revocation, logs, RLS (non-owner probe role), AI tools + fake Gemini | 73/73 pass |
| smoke as non-superuser table owner (`raphai_app_test`, like prod) | RLS does not break the server | 304/304 pass |
| upgrade: e8b747d DB + data -> new init | migrations safe on live data | pass |
| `npm test` | smoke + security | — |
| mobile `npx tsc --noEmit` | types | 0 errors |
| mobile `npx expo-doctor` | | 21/21 |

Not covered yet: real-device Health Connect, Play Billing against real Google, load test.
