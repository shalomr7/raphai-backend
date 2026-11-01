# HeartPurse Wealth (MVP, 2026-11-02)

Records and reminds only. No bank, UPI or card connection; HeartPurse never moves money.
Payment methods (UPI, Cash, Debit card, Credit card, Bank transfer, Net banking, Wallet, Other) are labels the user picks.
Wealth records are never sent to an AI service by this feature. (The existing AI coach can read a monthly money summary through its `getFinanceSummary` tool, only after the user's AI consent; unchanged.)

## Audit (before this work)
- One `expenses` table (spends only; modes UPI/Card/Cash), monthly income only from the profile.
- `budgets` per category per month (unique), no alerts, no overall budget.
- `savings_goals` with a single `saved` number (no history).
- `bills` monthly by `due_day` + `bill_payments(month)`; reminders the day before.
- All amounts already summed in integer paise (`*_paise` generated columns).

## Data model (migration `018_wealth_mvp`, additive)
- `expenses` is the single ledger: `type` = expense | income | transfer | refund (old rows = expense), `subcategory`, `merchant`, `tags`, `time`, `currency`, `from_account`, `to_account`, `transfer_kind` (own_account | card_bill | goal), `refund_of`, `client_id` (unique per user → idempotent saves), timestamps. Transfers store category `Transfer`.
- `wealth_categories` — user's own expense/income categories.
- `budgets.alert_levels` ('50,80,100', '' = off); `budget_alerts` remembers levels already announced (no repeats).
- `savings_goals.goal_type/description/status`; `goal_entries` (opening | contribution | withdrawal, optional linked transfer, `client_id`). Saved = sum of entries; legacy `saved` column kept equal.
- `bills.frequency` (weekly | monthly | quarterly | yearly), `bill_type`, `category`, `start_date`, `end_date`, `cancelled_from`, `reminder_days`, `reminders_on`, `notes`; `bill_occurrences` (paid | skipped | postponed, unique bill + due date, linked transaction, `created_expense`). Old `bill_payments` copied in; still written for monthly bills.
- RLS owner policies on the new tables. Rollback: `down` renames the new tables (`*_rb_018`, data kept) and forgets the migration; re-running `up` renames them back.

## Accounting rules (pure code: `src/services/wealthCalc.js`)
- Spending = expenses − refunds, per category, never below 0 (refunds are not income).
- Transfers (own accounts, credit-card bill payment, money into a goal) are never income or spending, so a card purchase + the later card-bill payment counts once.
- `Investment` category = invested, not spending, not in the Overall budget.
- Net cash flow = income − spending − invested (recorded, not a bank balance).
- Income shown = income recorded that month; if none, the profile's monthly income (labelled as planned).
- Budget: limit, spent, remaining, % used, over by, days remaining (today counts), alerts at 50/80/100% and "exceeded", each once per month per budget. Deleting a transaction lowers spending at once.
- Month vs month only when both months have 3+ expense records.
- Goals: suggested monthly = ceil(max(0, target − saved) / N), N = monthly periods left (target month counts if its day has not passed). Estimated finish only from 2+ contributions over 30+ days. Past target date → "needs review".
- Emergency fund = essential monthly expenses × months (1–24); a planning estimate.
- Bills: deterministic due dates; monthly on the 31st → last day of short months (29 Feb in leap years); quarterly/yearly keep the anchor day; unique per bill + date. Marking paid twice changes nothing; a matching expense (±7 days, ±10%) can be linked instead of recording a second one. Undoing "paid" removes only an expense HeartPurse created for it.

## API (all under /api/wealth, login required, every query scoped to the user)
See the header of `src/routes/wealth.js`.

## Tests
- `node --test test/wealth_calc.js` — pure maths.
- `node --test test/wealth_api.js` — every route on an in-memory Postgres (PGlite): migration up/down/up, idempotency, races, authorization between two users, legacy endpoints.
