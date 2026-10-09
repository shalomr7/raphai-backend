# HeartPurse pricing in code (October 2026)

Source of truth: `src/utils/plans.js`. Research and reasoning: the owner's pricing report (8 Oct 2026).

## Tiers and Google Play IDs

| Tier | Product ID | `monthly` | `quarterly` | `yearly` | `monthly-prepaid` |
|---|---|---|---|---|---|
| Free | – | ₹0 | – | – | – |
| Plus | `raphai_plus` (new) | ₹79 | ₹199 | ₹599 | ₹89 |
| Pro | `raphai_pro` | ₹199 | ₹499 | ₹1,499 | ₹219 |
| Elite | `raphai_elite` | ₹349 | ₹899 | ₹2,499 | ₹379 |

Prices are Play India list prices, GST included. Play is the truth for what a user pays; the app shows Play's formatted price when it can and these numbers otherwise.

Offers: `trial-7d` (monthly, quarterly; new customers), `trial-14d` (yearly; new customers), `launch-y1` (Pro yearly, ₹999 first year; new customers), `winback-3m` (monthly, 50% off for 3 months; developer-determined). A student offer (`student-y`, Pro yearly 50% off) is in the report only; it is **not** in code, because Play cannot verify students and the app has no eligibility check yet.

Existing subscribers are grandfathered: the server maps product id -> plan and never looks at the price, so old ₹99/₹799 Pro and ₹199/₹1,499 Elite purchases keep working.

## Limits per day

| | Free | Plus | Pro | Elite |
|---|---|---|---|---|
| Rule-based coach questions | 5 (then 402, upsell Plus) | unlimited | unlimited | unlimited |
| AI coach answers | 0 | 5 (gemini-2.5-flash-lite) | 15 (gemini-2.5-flash) | 25 (gemini-2.5-flash) |
| Typed food parses | 5 | 20 | 50 | 100 |
| Photo food scans (feature not built) | 0 | 0 | 5 | 6 |
| Trends window | 7 days | 30 days | 365 days | 365 days |
| Family members (coming soon) | 1 | 1 | 1 | 3 |

**Choice made for Plus coach:** the report gives Plus *unlimited* rule-based coach questions plus 5 quick AI answers a day on Flash-Lite. Code follows the report (unlimited rule-based, `coach_per_day: null`) rather than a 20/day rule-based cap: rule-based answers cost nothing to serve, and a cap would make Plus feel worse than the free coach did before.

**Free coach:** the report suggested 3 questions/day; the owner chose to keep **5/day** (the existing behaviour).

**Fallback:** when a paid user's AI allowance is used up, or no AI is connected, or the model fails, the coach answers with the rule-based engine. It never blocks a paid user. Mood/distress questions always get the rule answer (helplines first). A failed AI call does not use up allowance. The allowance is per user per day, so upgrading mid-day keeps the count already used.

## Feature -> tier (`FEATURE_TIERS`)

| Feature | Lowest tier |
|---|---|
| Body fat % | Plus |
| Unlimited budgets (Free: 3/month) and goals (Free: 2) | Plus |
| SIP / EMI calculators | Plus |
| HIIT workout plans (app-side lock) | Plus |
| Life patterns (`/api/insights/patterns`) | Plus |
| Daily brief (`/api/insights/brief`; rule-based today, AI-written on Pro later) | Plus |
| "Your patterns" (`/api/insights/profile`, full Life Graph) | Pro |
| AI coach answers | Plus (with per-tier allowance) |
| Photo food scan, monthly PDF report | Pro (not built) |
| Family members | Elite (coming soon, not built) |
| No ads | Plus (ads are planned for Free only) |

Judgment call: the report's Plus tier is "full tracking, no heavy AI", so the rule-based features that were Pro-only (body fat, calculators, HIIT, unlimited budgets/goals, patterns, brief, 30-day trends) moved to Plus. Pro's extra value is the AI coach allowance, photo scan, 365-day trends, the full patterns profile and reports.
