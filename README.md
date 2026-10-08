# RaphAi Backend

RaphAi helps people in India track their **health** (food, steps, workouts, water, sleep, mood, weight) and their **wealth** (spending, budgets, savings, bills) in one app. Money is in rupees (₹).

This folder is the **backend**: the server the phone app talks to. It saves data and does the maths.

- **Node.js 20+** and **Express** (the web server)
- **PostgreSQL** (works with a free **Supabase** database; the `pg` library talks to it)
- Login uses **bcrypt** (passwords are scrambled before saving) and **JWT** (a login token)

---

## 1. How to run it

You need Node.js 20 or newer (check with `node -v`) and a **Postgres database**.
The easiest is a free Supabase project (see section 8), or a Postgres on your own computer.

```bash
cd raphai-backend
npm install            # downloads the libraries (one time)
cp .env.example .env   # makes your settings file
# open .env and paste your database link into DATABASE_URL
npm start              # starts the server
```

You should see:

```
Database ready (tables checked, foods seeded)
RaphAi API running on http://localhost:4000
```

The server makes all the tables and adds the 48 foods by itself when it starts.
This is safe to run again and again: it never deletes or doubles anything.

Open http://localhost:4000/api/health-check in a browser. You should see `{"ok":true,...}`.

**Run the test:**

```bash
npm test               # same as: node test/smoke.js
```

It uses the database in `DATABASE_URL` (or `TEST_DATABASE_URL` if you set it). It makes a
fresh, empty **schema** (a separate folder inside the database) just for the test, signs up a
user, calls the main endpoints, prints `SMOKE TEST PASSED (228 checks)`, and then deletes that
schema. Your real tables and data are not touched.

**Start again with an empty database:** in Supabase, open the SQL Editor and run
`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` (this deletes ALL data!), then start the server again.

---

## 2. What each folder and file does

```
raphai-backend/
├── package.json          The project's name, libraries, and commands (npm start, npm test)
├── .env.example          Example settings. Copy it to .env and change the values
├── render.yaml           Settings for hosting on Render (a "Blueprint")
├── src/
│   ├── server.js         Starting point. Loads .env, sets up the database, starts the server
│   ├── app.js            Connects everything: CORS, JSON, all routes, error handler
│   ├── db.js             Connects to Postgres, creates all tables, adds the foods
│   ├── seed/
│   │   └── foods.js      48 common Indian foods with calories, protein, carbs, fat
│   ├── middleware/
│   │   ├── auth.js       Checks the login token (requireAuth) and makes tokens
│   │   ├── requirePlan.js  Blocks a feature unless the user has the right plan, e.g. requirePlan('pro')
│   │   └── errors.js     Turns every error into clean JSON. Unknown URLs give 404
│   ├── utils/
│   │   ├── calc.js       All the formulas: BMR, TDEE, macros, BMI, body fat, MET, SIP, EMI, 50/30/20
│   │   ├── http.js       Input checking (validate), error type (HttpError), small helpers
│   │   ├── dates.js      Works out "today" and "this month" in Indian time
│   │   └── plans.js      The plans and prices (Free, Pro, Elite)
│   ├── services/
│   │   ├── googlePlay.js Google Play Billing: asks Google for a purchase's state, saves it, sets the plan
│   │   ├── summary.js    Adds up a user's day (health) and month (money), and works out the scores
│   │   ├── streaks.js    Logging streak and RaphScore streak
│   │   ├── intelligence.js  RaphAi Intelligence: 6-area RaphScore, priorities, nutrition safety,
│   │   │                    hydration advice, budget left, trends, Life Graph patterns, brief
│   │   └── foodParser.js    Reads "2 rotis and half katori dal" and finds the foods
│   └── routes/           One file per part of the API
│       ├── auth.js       Register, login, me
│       ├── profile.js    Get and change your profile
│       ├── health.js     Targets, today, steps, workouts, water, sleep, mood, weight, reminders
│       ├── foods.js      Food search and the food log
│       ├── wealth.js     Expenses, budgets, savings goals, bills, SIP and EMI calculators
│       ├── subscription.js  Plans, subscription, Razorpay order, verify, and webhook (stub)
│       ├── googlePlay.js    Google Play Billing: /api/subscription/google/verify and /rtdn
│       ├── dashboard.js  The home screen data, RaphScore and streaks
│       ├── export.js     GET /api/export: all your data as JSON
│       ├── insights.js   /api/insights/today, trends, patterns, brief, profile
│       ├── food.js       POST /api/food/parse (food from a sentence)
│       ├── activity.js   /api/activity/daily (Health Connect / pedometer)
│       └── coach.js      Rule-based personal coach (Pro plan)
└── test/
    └── smoke.js          Quick test of the main features
```

---

## 3. Settings (.env)

| Setting | What it does | Default |
|---|---|---|
| `PORT` | Port the server uses | `4000` |
| `JWT_SECRET` | Secret for login tokens. **Change it** to a long random text | dev value (not allowed in production) |
| `JWT_EXPIRES_IN` | How long a login lasts | `7d` |
| `DATABASE_URL` | Link to your Postgres database (Supabase "Session pooler" string) | **required** |
| `DATABASE_SSL` | `false` turns SSL off. Only for your own Postgres without SSL. Supabase needs SSL (on by default, off by itself for `localhost`) | on |
| `PG_POOL_MAX` | How many database connections to keep open | `5` |
| `APP_TZ` | Timezone for "today" | `Asia/Kolkata` |
| `CORS_ORIGIN` | Which websites may call the API (`*` = all) | `*` |
| `NODE_ENV` | `development` or `production` | `development` |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Cloud service-account key (raw JSON or base64). Needed for real Play purchases | empty (verify answers **503 billing not configured**) |
| `GOOGLE_PLAY_PACKAGE_NAME` | The Android app id | `com.raphai.app` in render.yaml |
| `GOOGLE_RTDN_SECRET` | Long random text; the Pub/Sub push URL must end with `?secret=` this value | empty (RTDN answers 503) |
| `GOOGLE_RTDN_AUDIENCE` / `GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL` | Optional: also check Pub/Sub's signed token | empty (off) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay keys (**not used by the app any more**; kept for later). Leave empty for **stub mode** | empty |
| `RAZORPAY_WEBHOOK_SECRET` | Secret for checking Razorpay webhooks | empty |

---

## 4. How the maths works

**Health** (`src/utils/calc.js`)
- **BMR** (Mifflin-St Jeor): men `10×kg + 6.25×cm − 5×age + 5`, women `... − 161`
- **TDEE** = BMR × activity factor (1.2 sitting up to 1.9 very active)
- **Calorie target** = TDEE − `7700 × pace ÷ 7` to lose weight, or + to gain. It never goes below 1500 (men) or 1200 (women)
- **Protein** 1.6 g per kg (lose or gain), 1.2 g per kg (maintain). **Fat** 25% of calories. **Carbs** are the calories left over
- **Water** 35 ml per kg
- **BMI** with Asian cut-offs: below 18.5 underweight, 18.5 to 22.9 normal, 23 to 24.9 overweight, 25 and above obese
- **Body fat %** (US Navy tape method). You need neck and waist in cm, plus hip for women
- **Workout calories** = MET × kg × hours

**Wealth**
- **SIP** future value = `P × ((1+r)^n − 1) / r × (1+r)` (r = monthly rate, n = months)
- **EMI** = `P × r × (1+r)^n / ((1+r)^n − 1)`
- **50/30/20**: 50% needs, 30% wants, 20% savings
- `Investment` expenses count as saving, not spending

**RaphScore (0 to 100)** = (Health score + Wealth score) ÷ 2
- Health score is the average of 5 parts for today. **Calories**: 100 if you are within ±10% of your target. **Protein** and **water**: % of target. **Steps**: % of your step goal (8,000 by default). **Sleep**: 100 for 7 to 9 hours
- Wealth score is the average of 3 parts for this month. **Savings rate**: saving 20% or more of income scores 100. **Bills paid**: % of this month's bills due so far that are paid. **Budget adherence**: % of your budgets not overspent (if you set no budgets, spending up to 80% of income scores 100)

---

## 5. API endpoints

The server runs at `http://localhost:4000`. Send and receive JSON.
Every endpoint except the **Public** ones needs this header:

```
Authorization: Bearer <token from register or login>
```

Dates look like `2026-10-07` and months look like `2026-10`. If you leave out a date, the server uses **today** in Indian time.
Errors look like `{ "error": "Invalid input", "details": ["amount is required"] }`.
Status codes: 400 bad input, 401 not logged in, 402 plan needed, 404 not found, 409 already exists.

### Public
| Method | URL | What it does |
|---|---|---|
| GET | `/api/health-check` | Is the server running? |
| GET | `/privacy` | Public Privacy Policy web page (from `docs/legal/privacy-policy.md`) |
| GET | `/terms` | Public Terms & Conditions web page (from `docs/legal/terms-and-conditions.md`) |
| POST | `/api/auth/register` | Sign up. Returns a token |
| POST | `/api/auth/login` | Log in. Returns a token |
| GET | `/api/plans` | Plans and prices |
| POST | `/api/webhooks/razorpay` | Razorpay calls this after a payment |

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Ravi","email":"ravi@example.com","password":"secret123"}'
# -> { "token": "eyJhbGci...", "user": { "id": 1, "name": "Ravi", "email": "ravi@example.com" } }
```

In the examples below, `$T` is your token: `T=eyJhbGci...`

### Account and profile
| Method | URL | What it does |
|---|---|---|
| GET | `/api/auth/me` | Who am I |
| DELETE | `/api/auth/me` | Delete your account and ALL your data. Send `{ "password": "..." }` to confirm |
| GET | `/api/export` | Download ALL your data as one JSON file (no password hash) |
| GET | `/api/profile` | Your profile, plus a guide to activity factors |
| PUT | `/api/profile` | Change any profile fields (send only the ones that change) |

```bash
curl -X PUT http://localhost:4000/api/profile -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"sex":"male","age":30,"height_cm":175,"weight_kg":75,"activity_factor":1.55,"goal":"lose","pace_kg_week":0.5,"income":60000,"neck_cm":38,"waist_cm":86}'
```

The profile fields are: `sex` (male/female), `age` (18 to 100; RaphAi is for adults only), `height_cm`, `weight_kg`, `activity_factor` (1.2 to 1.9), `goal` (lose/maintain/gain), `pace_kg_week` (0 to 1), `income` (₹ per month), and these optional ones: `neck_cm`, `waist_cm`, `hip_cm`, `step_goal`.

### Health
| Method | URL | What it does |
|---|---|---|
| GET | `/api/health/targets` | Your BMR, TDEE, calories, protein, fat, carbs, water, BMI and body fat |
| GET | `/api/health/today?date=` | Summary for one day, with the health score |
| PUT | `/api/health/steps` | Save the day's total steps `{ "steps": 6500, "date"? }` (sending again replaces it) |
| GET | `/api/health/steps?from=&to=` | Step history |
| GET | `/api/health/workouts/met-table` | Activities and their MET values |
| POST | `/api/health/workouts` | `{ "activity": "running", "minutes": 30 }` (or send your own `met`) |
| GET | `/api/health/workouts?date=` or `?from=&to=` | List workouts |
| DELETE | `/api/health/workouts/:id` | Delete a workout |
| POST, GET | `/api/health/water` | Add `{ "ml": 250 }` or list |
| PUT, DELETE | `/api/health/water/:id` | Change or delete |
| POST, GET | `/api/health/sleep` | Add `{ "hours": 7.5, "quality": 4 }` or list |
| PUT, DELETE | `/api/health/sleep/:id` | Change or delete |
| POST, GET | `/api/health/mood` | Add `{ "mood": 4, "note": "Good day" }` (1 to 5) or list |
| PUT, DELETE | `/api/health/mood/:id` | Change or delete |
| POST, GET | `/api/health/weight` | Add `{ "weight_kg": 74.6 }` (also updates your profile) or list |
| PUT, DELETE | `/api/health/weight/:id` | Change or delete |
| GET | `/api/health/reminders` | Sitting-reminder settings |
| PUT | `/api/health/reminders` | `{ "enabled": true, "interval_min": 45, "start_hour": 9, "end_hour": 21 }` |

```bash
curl http://localhost:4000/api/health/targets -H "Authorization: Bearer $T"
# -> { "bmr": 1699, "tdee": 2633, "calories": 2083, "protein_g": 120, "fat_g": 58, "carbs_g": 271,
#      "water_ml": 2625, "bmi": { "value": 24.5, "category": "overweight" }, "body_fat_pct": 17.7, ... }

curl -X POST http://localhost:4000/api/health/workouts -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"activity":"brisk_walking","minutes":40}'
```

### Foods and food log
| Method | URL | What it does |
|---|---|---|
| GET | `/api/foods?q=dal` | Search foods. Your favourites come first, then foods you ate recently, then A–Z. Each food has `verified`, `is_favourite`, `last_used` |
| GET | `/api/foods/recent` | Foods you logged most recently |
| GET | `/api/foods/favourites` | Your starred foods |
| POST, DELETE | `/api/foods/:id/favourite` | Star / un-star a food |
| GET | `/api/foods/:id` | One food |
| POST | `/api/foods` | Add your own food `{ name, serving, kcal, protein_g, carbs_g, fat_g }` |
| POST | `/api/food-logs` | Log food `{ "food_id": 1, "meal": "lunch", "servings": 2, "date"? }` |
| GET | `/api/food-logs?date=` | One day's food, grouped by meal, with totals and calories left |
| PUT | `/api/food-logs/:id` | Change `servings`, `meal`, `date` or `food_id` |
| DELETE | `/api/food-logs/:id` | Delete |
| POST | `/api/food-logs/repeat` | Repeat a meal `{ "meal": "breakfast", "from_date"?, "to_date"? }`. Default: yesterday's meal copied to today |

**Verified foods:** the 48 seeded foods have `verified: true`. Foods that users add with `POST /api/foods` have `verified: false`.

The meals are `breakfast`, `lunch`, `dinner` and `snack`.

```bash
curl "http://localhost:4000/api/foods?q=roti" -H "Authorization: Bearer $T"
curl -X POST http://localhost:4000/api/food-logs -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"food_id":1,"meal":"lunch","servings":3}'
```

### Wealth
| Method | URL | What it does |
|---|---|---|
| GET | `/api/wealth/categories` | Expense categories and payment modes |
| POST | `/api/wealth/expenses` | `{ "amount": 450, "category": "Food", "mode": "UPI", "note": "Swiggy", "date"? }` |
| GET | `/api/wealth/expenses?month=2026-10&category=Food` | List expenses (you can also use `from` and `to`) |
| GET | `/api/wealth/expenses/summary?month=` | Totals by category and by payment mode, needs and wants, money left over |
| PUT, DELETE | `/api/wealth/expenses/:id` | Change or delete |
| GET | `/api/wealth/budgets/suggestion` | 50/30/20 split of your income |
| GET | `/api/wealth/budgets?month=` | Budgets with spent, left and over_budget |
| PUT | `/api/wealth/budgets` | Set a budget `{ "category": "Food", "amount": 4000, "month"? }` |
| DELETE | `/api/wealth/budgets/:id` | Delete a budget |
| POST | `/api/wealth/goals` | `{ "name": "Goa trip", "target": 30000, "deadline": "2027-06-01" }` |
| GET | `/api/wealth/goals` | Goals with % done and how much to save each month |
| PUT, DELETE | `/api/wealth/goals/:id` | Change or delete |
| POST | `/api/wealth/goals/:id/add` | Add money `{ "amount": 2000 }` |
| POST | `/api/wealth/bills` | `{ "name": "Electricity", "amount": 1200, "due_day": 5, "recurring": true }` |
| GET | `/api/wealth/bills?month=` | Bills with `due_date`, `paid`, `overdue`, the total due and the overdue count |
| PUT, DELETE | `/api/wealth/bills/:id` | Change or delete |
| POST | `/api/wealth/bills/:id/pay` | Mark as paid for a month `{ "month"? }` |
| DELETE | `/api/wealth/bills/:id/pay?month=` | Undo paid |
| GET | `/api/wealth/calculators/sip?monthly=5000&rate=12&years=10` | **Pro.** SIP: what you will have |
| GET | `/api/wealth/calculators/emi?principal=500000&rate=10&months=60` | **Pro.** EMI: monthly loan payment |

**Free plan limits:** 3 budgets per month and 2 savings goals. Adding more gives 402 (changing an existing budget is always allowed). `GET /api/wealth/categories` returns `free_limits`.

The categories are Food, Groceries, Rent, Transport, Bills, Health, Education, Shopping, Entertainment, Travel, Personal Care, Investment and Other. The payment modes are `UPI`, `Card` and `Cash`.

```bash
curl -X POST http://localhost:4000/api/wealth/expenses -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"amount":450,"category":"Food","mode":"UPI","note":"Swiggy"}'
curl "http://localhost:4000/api/wealth/calculators/sip?monthly=5000&rate=12&years=10" -H "Authorization: Bearer $T"
# -> { "invested": 600000, "future_value": 1161695, "gains": 561695, ... }
```

### Subscription
| Method | URL | What it does |
|---|---|---|
| GET | `/api/subscription` | Your plan and when it ends |
| POST | `/api/subscription/google/verify` | **Google Play.** After a purchase (or Restore) the app sends `{ "purchaseToken", "productId": "raphai_pro", "basePlanId": "yearly" }`. Answers `{ valid, pending, google, subscription }` |
| POST | `/api/subscription/google/rtdn?secret=...` | **Public.** Google Cloud Pub/Sub pushes Play notifications here |
| POST | `/api/subscription/order` | (Razorpay, unused) Start a payment `{ "plan": "pro", "period": "yearly" }` |
| POST | `/api/subscription/verify` | After paying, send `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` |
| POST | `/api/subscription/cancel` | Go back to Free (409 for a Google Play plan: cancel it in the Play Store) |
| POST | `/api/subscription/trial` | Start the **14-day free Pro trial** (once per account; 409 if already used) |
| POST | `/api/subscription/dev-activate` | **Development only.** Turns on a plan without paying `{ "plan": "pro", "period": "monthly" }` |

| Plan | Monthly | Yearly |
|---|---|---|
| Free | ₹0 | ₹0 |
| Pro | ₹99 | ₹799 |
| Elite | ₹199 | ₹1,499 |

`GET /api/plans` also returns `trial_days: 14` and `best_value_period: "yearly"`.

**What is free and what is Pro.** Free keeps calories, macros, water, steps, all logs, BMI, expenses, bills, the 50/30/20 suggestion, RaphScore and streaks, today's insights and 7-day trends, and 5 food parses a day. **Pro** unlocks: RaphAi Intelligence (30-day trends, Life patterns, the daily brief, "Your patterns", unlimited food parse), body fat % (on Free, `/api/health/targets` returns `body_fat_pct: null` and `body_fat_locked: true`), unlimited budgets and goals, SIP/EMI calculators, the coach, and HIIT plans (HIIT plans are locked in the phone app).

Elite includes everything in Pro. To lock any route behind a plan, add `requirePlan('pro')` (or `'elite'`) after `requireAuth`, the same way `/api/coach` is set up in `src/app.js`.

**Google Play Billing (real payments).** Products in Play Console: `raphai_pro` and `raphai_elite`, each with base plans `monthly` and `yearly`, and a 14-day free-trial offer on each base plan.

1. The phone app buys with Google Play and gets a `purchaseToken`.
2. It sends the token to `POST /api/subscription/google/verify`. The server asks Google (`purchases.subscriptionsv2.get`) for the real state, saves it in the table `google_play_purchases`, and sets the user's plan, expiry, auto-renew and trial in `subscriptions`.
3. Only when the server says `valid: true` does the app acknowledge (finish) the purchase. Google refunds purchases that are not acknowledged within 3 days, so the app also re-checks unfinished purchases each time the Upgrade screen opens.
4. Google then tells the server about renewals, cancellations, expiries, payment problems and refunds through **Real-time Developer Notifications** (Pub/Sub push to `/api/subscription/google/rtdn?secret=...`). For every message the server asks Google again for the latest state.

Safety rules: one purchase token can only be linked to one RaphAi account (409 otherwise); the app passes a hashed account id (`play_account_id` from `GET /api/subscription`) when buying, and the server rejects a token bought from another account; a refunded/revoked token never gives access again. Access is given for the states ACTIVE, CANCELED (until the paid time ends) and IN_GRACE_PERIOD, and only while the expiry is in the future, so plans end on time even if a notification is missed. When a Google plan looks expired, `GET /api/subscription` asks Google once more before switching to Free.

Without the Google settings, verify answers **503 "Google Play billing is not configured"**. The smoke test replaces Google with a fake, so it checks all of this without a Play Console. The step-by-step setup for the Play Console, Google Cloud and Pub/Sub is in the separate owner checklist (`raphai-play-billing-setup.md`).

**About Razorpay (stub, no longer used by the app):** with no keys in `.env`, `/order` makes a **fake** order (its id starts with `order_stub_`) and nothing is charged. With keys, it creates a real order using the Razorpay Orders API. Both `/verify` and the webhook check the HMAC-SHA256 signature. Test with Razorpay **test** keys before you go live, and in the Razorpay dashboard point the webhook at `https://your-server/api/webhooks/razorpay` with the events `payment.captured` and `payment.failed`.

### Dashboard and coach
| Method | URL | What it does |
|---|---|---|
| GET | `/api/dashboard?date=` | Home screen: RaphScore, **streaks**, health and wealth summaries |
| GET | `/api/dashboard/streaks` | Just the streaks |
| POST | `/api/coach` | **Pro plan.** `{ "question": "What should I do today?", "context"?: "home\|health\|fitness\|wealth" }` |

**Streaks** (`src/services/streaks.js`): `logging.days` = days in a row you logged anything (food, water, steps, workout, sleep, mood, weight or expense). `raph_score.days` = days in a row your RaphScore was 60 or more. If today has nothing yet, the streak counts up to yesterday (`today_done: false`).

**The coach** answers from your real numbers, in a warm, simple tone. It understands: **what should I do today**, **why are my steps low**, **how can I save more this month**, **optimise my day**, **today's nutrition**, **fat loss / belly fat**, **sleep**, **mood support** (sad, stressed, anxious; for distress it always gives **Tele-MANAS 14416** and 112), plus the older **calories left**, **food spend**, **how much to save** and **protein foods**. If it does not understand a question, `context` picks a helpful answer for that screen (home → today's plan, health → nutrition, fitness → steps, wealth → saving). The answer is `{ topic, answer, data, context, guessed_from_context }`.

```bash
curl -X POST http://localhost:4000/api/coach -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"question":"what is my food spend this month?"}'
# -> { "topic": "food_spend", "answer": "This month you spent ₹3,700 on food (...)" }
```

### RaphAi Intelligence
Rule-based (no outside AI), but every answer comes from your own data. **Missing data is never shown as 0**: it is `null` with `status: "no_data"` and a "Start tracking ..." note.

| Method | URL | Plan | What it does |
|---|---|---|---|
| GET | `/api/insights/today` | Free + Pro | RaphScore with 6 areas and why it changed vs yesterday, top 3 priorities, one insight, nutrition safety, hydration advice, budget left |
| GET | `/api/insights/trends?days=7` | Free: 7, Pro: 7 or 30 | Daily series (steps, sleep_min, mood, water_ml, spend, weight, kcal), averages vs the period before, and plain-English insights. `days=30` on Free → 402 |
| GET | `/api/insights/patterns` | Pro (Free gets `{ "locked": true }`) | "Life Graph": sleep ↔ spending, exercise ↔ mood, sleep ↔ mood, weekend share of spending, food delivery after poor sleep |
| GET | `/api/insights/brief` | Pro (Free gets `{ "locked": true }`) | Daily briefing: health, fitness and money sections + one priority |
| GET | `/api/insights/profile` | Pro (Free gets `{ "locked": true }`) | "Your patterns": 30-day averages (sleep, steps, protein, mood), savings rate, traits |
| POST | `/api/food/parse` | Free: 5 a day, Pro: unlimited | `{ "text": "I ate 2 eggs, 2 rotis and a glass of milk" }` → foods with `food_id`, `qty`, `unit`, `servings`, scaled kcal/protein/carbs/fat, and totals. The 6th parse in a day on Free → 402 |
| POST | `/api/activity/daily` | Free + Pro | `{ "date", "steps", "distance_m", "active_kcal", "active_minutes", "resting_hr"?, "source": "health_connect\|pedometer" }`. One row per day (sending again updates it). Also updates your steps |
| GET | `/api/activity/daily?days=7` | Free + Pro | The last N days (1 to 90) as an array |
| POST | `/api/health/sleep/import` | Free + Pro | `{ "date", "minutes": 438, "source": "health_connect" }`. Saves the night's sleep unless you typed it in by hand for that date (`imported: false` then) |

**RaphScore (v2, in `/api/insights/today`)** has 6 areas: **Health** (calories and protein vs your targets, water), **Fitness** (steps vs your goal, plus workouts), **Mind** (mood), **Wealth** (savings rate after bills, bills paid, budgets kept), **Habits** (how many of the last 7 days you logged, and how many kinds of things), **Recovery** (sleep hours and quality, resting heart rate). Today's numbers are compared with how much of the day has passed (Indian time), so a morning is not scored like a full day. The overall score is the weighted average of the areas that have data (weights: health 0.2, fitness 0.2, mind 0.15, wealth 0.2, habits 0.1, recovery 0.15), and it is `null` when fewer than 2 areas have data. Labels: 70+ Good, 45+ Okay, below 45 Needs care. Today's and yesterday's scores are saved in the table `raphscore_daily`, and the `explanation` says which areas moved. (The older `/api/dashboard` RaphScore is unchanged.)

**Nutrition safety:** deficit = TDEE − your calorie target. More than 25% of TDEE is `aggressive`, more than 35% is `very_aggressive`, with a kind message and a gentler `suggested_target` that is never below 1,200 kcal (women) or 1,500 kcal (men).

**Budget:** `remaining` = income − spent this month − unpaid bills due this month. `savings_rate` = remaining ÷ income.

**Hydration:** the advice depends on the time of day in India (for example "Have 500 ml now and another 500 ml before 7 PM").

**Patterns** need at least 14 days of data (otherwise `enough_data: false` and `days_needed`), and each group in a pattern needs at least 5 days, or the pattern is not shown. Today is left out because it is not finished.

**Food parse** understands commas and "and", number words (two, half, one and a half, dedh), and units: katori, plate, roti/chapati, piece, glass, cup, bowl, slice, spoon, tsp/tbsp, g and ml. It fuzzy-matches the foods table (also common spellings like "chapathi", "daal", "biriyani"). To save a parsed item, send `POST /api/food-logs { food_id, servings, meal }`.

---

## 6. How the phone app connects

This server **cannot count steps or show alerts on a phone by itself**. It only stores data and does the maths.

To count steps in the background and to buzz the user with "you've been sitting too long", you need a **native phone app**. A simple way to build one is **React Native with Expo**:

- `expo-sensors` → **Pedometer** reads the phone's step counter
- `expo-notifications` → schedules the "time to stand up" reminders on the phone

The phone app:
1. Logs in with `POST /api/auth/login` and keeps the token safe (for example with `expo-secure-store`)
2. Reads today's steps from the Pedometer and sends them to `PUT /api/health/steps` (on app open, and every so often)
3. Reads `GET /api/health/reminders` and schedules notifications to match those settings

Please note:
- On **iOS**, `Pedometer.getStepCountAsync` can read the past steps, so the app catches up when it opens.
- On **Android**, it can't read past steps, so the app counts only while it is running. For full-day counts in the background, use Health Connect (Android) or HealthKit (iOS) through a native module.
- On a phone, `localhost` means the phone itself. Use your computer's local network IP (for example `http://192.168.1.10:4000`) or a deployed HTTPS address.

**Minimal example (Expo):**

```js
// npx expo install expo-sensors expo-notifications
import { Pedometer } from 'expo-sensors';
import * as Notifications from 'expo-notifications';

const API = 'http://192.168.1.10:4000'; // your computer's IP, not localhost

// 1) Send today's steps to RaphAi
export async function syncSteps(token) {
  const ok = await Pedometer.isAvailableAsync();
  if (!ok) return;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const { steps } = await Pedometer.getStepCountAsync(start, new Date()); // iOS
  await fetch(`${API}/api/health/steps`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ steps }),
  });
}

// 2) Schedule "stand up" reminders using the user's settings
export async function scheduleSitReminders(token) {
  await Notifications.requestPermissionsAsync();
  const res = await fetch(`${API}/api/health/reminders`, { headers: { Authorization: `Bearer ${token}` } });
  const { reminders } = await res.json();

  await Notifications.cancelAllScheduledNotificationsAsync();
  if (!reminders.enabled) return;

  await Notifications.scheduleNotificationAsync({
    content: { title: 'RaphAi', body: 'You have been sitting a while. Stand up and stretch! 🚶' },
    trigger: { type: 'timeInterval', seconds: reminders.interval_min * 60, repeats: true },
  });
}
```

(A simple repeating timer like this one also fires outside `start_hour` to `end_hour`. To keep reminders inside those hours, schedule one daily notification for each time slot instead.)

---

## 7. Before going live (checklist)

- Set a strong `JWT_SECRET` and `NODE_ENV=production`
- Run behind **HTTPS** (for example on Render, Railway or a VPS with Nginx)
- Set `CORS_ORIGIN` to your real website address
- Set the Google Play settings (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `GOOGLE_RTDN_SECRET`) and test with a licence tester before going live
- Make backups: Supabase free projects have no backups you can download, so export your data now and then (for example with `pg_dump`)
- The food numbers are typical home-style values. Recipes differ, so the results are good estimates, not medical advice.

---

## 8. Put it online for free (GitHub + Render + Supabase)

You need three free accounts: **GitHub**, **Render** (runs the server) and **Supabase** (keeps the database).

### Step 1: Make the database on Supabase

1. Go to https://supabase.com and create a **New project**. Pick the region **Mumbai (ap-south-1)** if you can (close to Render Singapore and to India).
2. Write down the **database password** you choose. You need it soon.
3. When the project is ready, click **Connect** (top of the page).
4. Copy the **Session pooler** connection string. It looks like:
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
5. Replace `[YOUR-PASSWORD]` with your real password (no square brackets).
   If your password has special signs like `@` `#` `/` `?`, change the password to letters and numbers only, or the link will break.

Why "Session pooler" and not "Direct connection"? Render can only use IPv4 internet addresses,
and Supabase's direct connection uses IPv6. The Session pooler works with IPv4.

You do **not** need to make any tables. The server makes them by itself the first time it starts.

### Step 2: Put the code on GitHub

```bash
cd raphai-backend
git init                      # skip this if the .git folder is already there
git add .
git commit -m "RaphAi backend"
# make an EMPTY repo on github.com (no README), then:
git remote add origin https://github.com/YOUR-NAME/raphai-backend.git
git branch -M main
git push -u origin main
```

The `.gitignore` file makes sure `node_modules`, your `.env` (with your password) and old
database files are **not** uploaded.

### Step 3: Start it on Render with the Blueprint

1. Go to https://dashboard.render.com and sign in with GitHub.
2. Click **New +** → **Blueprint**.
3. Pick your `raphai-backend` repo. Render finds `render.yaml` and shows one web service, `raphai-backend`
   (Node, Singapore, Free plan).
4. Render asks for **DATABASE_URL**. Paste the Supabase Session pooler string from Step 1.
5. Click **Apply** (or **Deploy Blueprint**). `JWT_SECRET` is made for you (a long random value).
   `NODE_ENV=production`, `APP_TZ=Asia/Kolkata` and `CORS_ORIGIN=*` come from `render.yaml`.
6. Wait for the build to finish. In **Logs** you should see `Database ready` and `RaphAi API running`.
7. Open `https://YOUR-SERVICE.onrender.com/api/health-check`. You should see `{"ok":true,...}`.

Give this address to the phone app as its API address.

### Good to know

- **Free Render servers go to sleep** after about 15 minutes with no visitors. The next visit wakes it up,
  which can take up to a minute. This is normal on the free plan.
- **Free Supabase projects pause** after about a week with no use. Open the Supabase dashboard and click
  **Restore** if that happens.
- When you push new code to GitHub, Render deploys it again by itself.
- To add Razorpay keys later: Render → your service → **Environment** → add `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
- `CORS_ORIGIN=*` lets any website call the API. When you have a real website, change it to that address.
- To run the smoke test against Supabase from your computer: put the Supabase string in `.env` as
  `DATABASE_URL` and run `npm test`. It uses its own temporary schema and cleans up after itself.

