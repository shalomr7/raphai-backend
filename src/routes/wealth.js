// routes/wealth.js
// ------------------------------------------------------------
// Everything under /api/wealth (all money is in ₹ rupees):
//   GET  /categories
//   Expenses:  POST /expenses, GET /expenses, PUT /expenses/:id, DELETE /expenses/:id
//              GET /expenses/summary?month=2026-10
//   Budgets:   GET /budgets?month=, PUT /budgets, DELETE /budgets/:id, GET /budgets/suggestion
//   Goals:     POST/GET /goals, PUT/DELETE /goals/:id, POST /goals/:id/add
//   Bills:     POST/GET /bills, PUT/DELETE /bills/:id, POST /bills/:id/pay, DELETE /bills/:id/pay
//   Calculators: GET /calculators/sip, GET /calculators/emi
// Wealth MVP (2026-11-02), see docs/WEALTH.md:
//   Ledger:    POST/GET /transactions, PUT/DELETE /transactions/:id, GET /transactions/summary
//   Categories: POST /categories, DELETE /categories/:id (user's own)
//   Insights:  GET /overview (Home), GET /insights?month=
//   Budgets:   POST /budgets/copy   (+ 'Overall' budget, alert_levels)
//   Goals:     GET/POST /goals/:id/entries, DELETE /goals/:id/entries/:entryId, GET /emergency-fund
//   Bills:     GET /bills/upcoming, GET /bills/:id/history, POST /bills/:id/cancel,
//              POST/DELETE /bills/:id/occurrences/:date/pay, POST .../skip, POST .../postpone,
//              GET .../matches
// Writes that create rows take a client id (body client_id or Idempotency-Key
// header) so a double tap or a retry is saved once.
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const calc = require('../utils/calc');
const { validate, idParam, HttpError, asyncHandler } = require('../utils/http');
const { today, thisMonth, daysInMonth } = require('../utils/dates');
const money = require('../utils/money');
const summary = require('../services/summary');
const { hasPlan, requirePlan, upgradeError } = require('../middleware/requirePlan');
const { FREE_LIMITS, FEATURE_TIERS } = require('../utils/plans');

const wc = require('../services/wealthCalc');
const wd = require('../services/wealthData');

const router = express.Router();
const MODES = wd.MODES;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Za-z0-9_:.-]{8,100}$/;

// The client's idempotency key: body.client_id or the Idempotency-Key header
function clientKey(req) {
  const k = String((req.body && req.body.client_id) || req.headers['idempotency-key'] || '').trim();
  if (!k) return null;
  if (!KEY_RE.test(k)) throw new HttpError(400, 'client_id must be 8-100 letters, digits, - _ : .');
  return k;
}

// Small helper: run "UPDATE table SET a=@a, b=@b WHERE id=@id AND user_id=@user_id"
async function updateRow(table, id, userId, changes) {
  const cols = Object.keys(changes);
  if (!cols.length) return;
  const info = await db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND user_id = @user_id`,
    { ...changes, id, user_id: userId });
  if (!info.changes) throw new HttpError(404, 'Not found');
}

async function getOwned(table, id, userId) {
  const row = await db.get(`SELECT * FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

router.get('/categories', asyncHandler(async (req, res) => {
  const cats = await wd.categoriesFor(req.user.id);
  res.json({
    categories: cats.expense, needs: summary.NEEDS, savings: summary.SAVINGS, modes: wd.NEW_MODES,
    income_categories: cats.income, custom: cats.custom,
    types: wc.TYPES, transfer_kinds: wd.TRANSFER_KINDS, goal_types: wd.GOAL_TYPES, bill_types: wd.BILL_TYPES,
    frequencies: wc.FREQUENCIES, alert_levels: wc.ALERT_LEVELS,
    free_limits: FREE_LIMITS,
  });
}));

// The user's own categories: POST { kind: 'expense'|'income', name }
router.post('/categories', asyncHandler(async (req, res) => {
  const b = validate(req.body, { kind: { type: 'string', required: true, oneOf: ['expense', 'income'] }, name: { type: 'string', required: true, maxLength: 40 } });
  if (b.name.length < 2) throw new HttpError(400, 'Name is too short');
  const builtIn = b.kind === 'expense' ? wd.EXPENSE_CATEGORIES : wd.INCOME_CATEGORIES;
  if (builtIn.some((c) => c.toLowerCase() === b.name.toLowerCase()) || b.name.toLowerCase() === wc.OVERALL.toLowerCase()) throw new HttpError(409, 'That category already exists');
  const row = await db.get(`INSERT INTO wealth_categories (user_id, kind, name) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, kind, lower(name)) DO UPDATE SET archived = false RETURNING id, kind, name`, [req.user.id, b.kind, b.name]);
  res.status(201).json({ category: row });
}));

// Hide a custom category (records keep their category name)
router.delete('/categories/:id', asyncHandler(async (req, res) => {
  const info = await db.run('UPDATE wealth_categories SET archived = true WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Category not found');
  res.json({ deleted: true });
}));

// ================= EXPENSES =================
const EXPENSE_RULES = {
  amount: { type: 'money', required: true, min: 1, max: 10000000 },
  category: { type: 'string', required: true, maxLength: 40 },
  mode: { type: 'string', required: true, oneOf: MODES },
  note: { type: 'string', maxLength: 200 },
  date: { type: 'date' },
};

async function assertCategory(userId, kind, category) {
  const cats = await wd.categoriesFor(userId);
  if (!(kind === 'income' ? cats.income : cats.expense).includes(category)) {
    throw new HttpError(400, 'Invalid input', [`category must be one of: ${(kind === 'income' ? cats.income : cats.expense).join(', ')}`]);
  }
}

// Old endpoint (older app versions): always an expense. Accepts a client id too.
router.post('/expenses', asyncHandler(async (req, res) => {
  const b = validate(req.body, EXPENSE_RULES);
  await assertCategory(req.user.id, 'expense', b.category);
  const key = clientKey(req);
  const row = await db.get(`INSERT INTO expenses (user_id, amount, category, mode, note, date, type, client_id) VALUES ($1, $2, $3, $4, $5, $6, 'expense', $7)
    ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
    [req.user.id, b.amount, b.category, b.mode, b.note || null, b.date || today(), key]);
  if (!row) {
    const existing = await db.get('SELECT * FROM expenses WHERE user_id = $1 AND client_id = $2', [req.user.id, key]);
    return res.status(200).json({ expense: existing, duplicate: true });
  }
  res.status(201).json({ expense: await getOwned('expenses', row.id, req.user.id) });
}));

// GET /expenses?month=2026-10  or  ?from=&to=  and optional &category=Food
router.get('/expenses', asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    month: { type: 'month' }, from: { type: 'date' }, to: { type: 'date' },
    category: { type: 'string', maxLength: 40 },
  });
  // Old endpoint: only spends (income and transfers live in /transactions)
  let sql = "SELECT * FROM expenses WHERE user_id = @user_id AND type = 'expense'";
  const params = { user_id: req.user.id };
  if (q.month) { sql += ' AND substr(date, 1, 7) = @month'; params.month = q.month; }
  if (q.from) { sql += ' AND date >= @from'; params.from = q.from; }
  if (q.to) { sql += ' AND date <= @to'; params.to = q.to; }
  if (q.category) { sql += ' AND category = @category'; params.category = q.category; }
  const rows = await db.all(sql + ' ORDER BY date DESC, id DESC', params);
  const totalP = money.sumPaise(rows);
  res.json({ expenses: rows, total: money.rupees(totalP), total_paise: totalP });
}));

// Monthly summary by category (put BEFORE "/expenses/:id" style routes)
router.get('/expenses/summary', asyncHandler(async (req, res) => {
  const { month } = validate(req.query, { month: { type: 'month' } });
  const m = await summary.wealthMonth(req.user.id, month || thisMonth());
  const byMode = await db.all(`SELECT mode, SUM(amount_paise)::bigint AS total_paise FROM expenses
    WHERE user_id = $1 AND substr(date,1,7) = $2 AND type = 'expense' GROUP BY mode`, [req.user.id, m.month]);
  res.json({
    month: m.month,
    income: m.income,
    total_spent: m.spent,
    invested: m.invested,
    left_over: money.rupees(m.income_paise - m.spent_paise - m.invested_paise),
    left_over_paise: m.income_paise - m.spent_paise - m.invested_paise,
    needs: m.needs,
    wants: m.wants,
    by_category: m.by_category,
    by_mode: byMode.map((r) => ({ mode: r.mode, total: money.rupees(r.total_paise), total_paise: r.total_paise })),
  });
}));

router.put('/expenses/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const changes = validate(req.body, EXPENSE_RULES, { partial: true });
  if (changes.category) await assertCategory(req.user.id, 'expense', changes.category);
  await updateRow('expenses', id, req.user.id, changes);
  await db.run('UPDATE expenses SET updated_at = now() WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  res.json({ expense: await getOwned('expenses', id, req.user.id) });
}));

router.delete('/expenses/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM expenses WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Expense not found');
  res.json({ deleted: true });
}));

// ================= LEDGER (income, expense, transfer, refund) =================
const TX_RULES = {
  type: { type: 'string', required: true, oneOf: wc.TYPES },
  amount: { type: 'money', required: true, min: 0.01, max: 100000000 },
  category: { type: 'string', maxLength: 40 },
  subcategory: { type: 'string', maxLength: 40 },
  mode: { type: 'string', oneOf: MODES },
  date: { type: 'date' },
  time: { type: 'string', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
  merchant: { type: 'string', maxLength: 80 },
  note: { type: 'string', maxLength: 200 },
  tags: { type: 'string', maxLength: 120 },
  from_account: { type: 'string', maxLength: 40 },
  to_account: { type: 'string', maxLength: 40 },
  transfer_kind: { type: 'string', oneOf: wd.TRANSFER_KINDS },
  refund_of: { type: 'integer', min: 1 },
};
const TX_COLS = ['type', 'amount', 'category', 'subcategory', 'mode', 'date', 'time', 'merchant', 'note', 'tags', 'from_account', 'to_account', 'transfer_kind', 'refund_of'];

// Checks that depend on the type; fills sensible defaults. `prev` = row being edited.
async function checkTx(userId, b, prev = null) {
  const t = { ...(prev || {}), ...b };
  const latest = today();
  if (t.date && t.date > wc.addDays(latest, 1)) throw new HttpError(400, 'Invalid input', ['date cannot be in the future']);
  if (t.date && t.date < '2000-01-01') throw new HttpError(400, 'Invalid input', ['date is too far in the past']);
  if (t.type === 'transfer') {
    b.category = 'Transfer'; // not a spending category (column is NOT NULL); never counted
    if (!t.transfer_kind) b.transfer_kind = 'own_account';
  } else {
    if (!t.category) throw new HttpError(400, 'Invalid input', ['category is required']);
    await assertCategory(userId, t.type === 'income' ? 'income' : 'expense', t.category);
    if (prev && prev.type === 'transfer') b.transfer_kind = null;
  }
  if (t.type === 'refund' && t.refund_of) {
    const orig = await db.get("SELECT id FROM expenses WHERE id = $1 AND user_id = $2 AND type = 'expense'", [t.refund_of, userId]);
    if (!orig) throw new HttpError(400, 'Invalid input', ['refund_of must be one of your expenses']);
  }
  if (!t.mode) b.mode = t.type === 'transfer' ? 'Bank transfer' : 'UPI';
  return b;
}

function txView(r) {
  return { ...r, amount_paise: r.amount_paise != null ? Number(r.amount_paise) : money.toPaise(r.amount) };
}

router.post('/transactions', asyncHandler(async (req, res) => {
  const b = await checkTx(req.user.id, validate(req.body, TX_RULES));
  const key = clientKey(req);
  const vals = { ...b, date: b.date || today() };
  const cols = TX_COLS.filter((c) => vals[c] !== undefined);
  const row = await db.get(`INSERT INTO expenses (user_id, client_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})
    ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING *`,
  [req.user.id, key, ...cols.map((c) => vals[c] ?? null)]);
  if (!row) {
    const existing = await db.get('SELECT * FROM expenses WHERE user_id = $1 AND client_id = $2', [req.user.id, key]);
    return res.status(200).json({ transaction: txView(existing), duplicate: true });
  }
  res.status(201).json({ transaction: txView(row) });
}));

// GET /transactions?month=|from=&to=&type=&category=&mode=&min=&max=&q=&limit=&before_date=&before_id=
// Newest first; pass the last row's date + id as before_date/before_id for the next page.
router.get('/transactions', asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    month: { type: 'month' }, from: { type: 'date' }, to: { type: 'date' },
    type: { type: 'string', oneOf: wc.TYPES }, category: { type: 'string', maxLength: 40 }, mode: { type: 'string', oneOf: MODES },
    min: { type: 'money', min: 0 }, max: { type: 'money', min: 0 }, q: { type: 'string', maxLength: 60 },
    limit: { type: 'integer', min: 1, max: 200 }, before_date: { type: 'date' }, before_id: { type: 'integer', min: 1 },
  });
  const where = ['user_id = @user_id']; const p = { user_id: req.user.id };
  if (q.month) { const r = wc.monthRange(q.month); where.push('date >= @mfrom AND date <= @mto'); p.mfrom = r.from; p.mto = r.to; }
  if (q.from) { where.push('date >= @from'); p.from = q.from; }
  if (q.to) { where.push('date <= @to'); p.to = q.to; }
  if (q.type) { where.push('type = @type'); p.type = q.type; }
  if (q.category) { where.push('category = @category'); p.category = q.category; }
  if (q.mode) { where.push('mode = @mode'); p.mode = q.mode; }
  if (q.min !== undefined) { where.push('amount_paise >= @minp'); p.minp = money.toPaise(q.min); }
  if (q.max !== undefined) { where.push('amount_paise <= @maxp'); p.maxp = money.toPaise(q.max); }
  if (q.q) { where.push("(note ILIKE @q ESCAPE '\\' OR merchant ILIKE @q ESCAPE '\\' OR category ILIKE @q ESCAPE '\\' OR tags ILIKE @q ESCAPE '\\')"); p.q = `%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`; }
  if (q.before_date && q.before_id) { where.push('(date, id) < (@bdate, @bid)'); p.bdate = q.before_date; p.bid = q.before_id; }
  const limit = q.limit || 50;
  const rows = await db.all(`SELECT * FROM expenses WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ${limit + 1}`, p);
  const more = rows.length > limit;
  const page = rows.slice(0, limit).map(txView);
  const last = page[page.length - 1];
  res.json({ transactions: page, next: more && last ? { before_date: last.date, before_id: last.id } : null });
}));

// Totals for a month or any custom period (deterministic, from saved rows)
router.get('/transactions/summary', asyncHandler(async (req, res) => {
  const q = validate(req.query, { month: { type: 'month' }, from: { type: 'date' }, to: { type: 'date' } });
  let from; let to;
  if (q.from && q.to) { from = q.from; to = q.to; } else { ({ from, to } = wc.monthRange(q.month || thisMonth())); }
  if (from > to) throw new HttpError(400, 'from must be before to');
  if (wc.diffDays(from, to) > 3700) throw new HttpError(400, 'Period is too long (max 10 years)');
  res.json({ from, to, ...wc.periodTotals(await wd.txsBetween(req.user.id, from, to)) });
}));

router.put('/transactions/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const prev = await getOwned('expenses', id, req.user.id);
  const b = await checkTx(req.user.id, validate(req.body, TX_RULES, { partial: true }), prev);
  const changes = {}; for (const c of TX_COLS) if (b[c] !== undefined) changes[c] = b[c];
  if (Object.keys(changes).length) {
    await updateRow('expenses', id, req.user.id, changes);
    await db.run('UPDATE expenses SET updated_at = now() WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  }
  res.json({ transaction: txView(await getOwned('expenses', id, req.user.id)) });
}));

router.delete('/transactions/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  await db.tx(async (t) => {
    // A bill marked paid with this transaction stays paid, just unlinked (FK SET NULL)
    await t.run('UPDATE bill_occurrences SET created_expense = false WHERE transaction_id = $1 AND user_id = $2', [id, req.user.id]);
    const info = await t.run('DELETE FROM expenses WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!info.changes) throw new HttpError(404, 'Transaction not found');
  });
  res.json({ deleted: true });
}));

// ================= INSIGHTS + HOME OVERVIEW =================
router.get('/insights', asyncHandler(async (req, res) => {
  const { month } = validate(req.query, { month: { type: 'month' } });
  const m = month || thisMonth();
  const prevMonth = wc.shiftMonth(m, -1);
  const [cur, prev, b] = await Promise.all([wd.monthTotals(req.user.id, m), wd.monthTotals(req.user.id, prevMonth),
    wd.budgetsForMonth(req.user.id, m, today())]);
  const overall = b.budgets.find((x) => x.category === wc.OVERALL) || null;
  res.json({
    month: m, previous_month: prevMonth,
    totals: cur,
    largest: cur.by_category.filter((c) => !c.is_saving && c.total_paise > 0).slice(0, 3),
    month_over_month: wc.monthOverMonth(cur, prev),
    overall_budget: overall,
    over_budget: b.budgets.filter((x) => x.state === 'over'),
    near_limit: b.budgets.filter((x) => x.state === 'near' || x.state === 'reached'),
  });
}));

// One call for the Home "Wealth this month" card
router.get('/overview', asyncHandler(async (req, res) => {
  const D = today(); const m = thisMonth();
  const [totals, b, profile, occ, goals] = await Promise.all([
    wd.monthTotals(req.user.id, m),
    wd.budgetsForMonth(req.user.id, m, D, { record: true }),
    db.get('SELECT income, income_paise FROM profiles WHERE user_id = $1', [req.user.id]),
    wd.billOccurrences(req.user.id, D, wc.addDays(D, 30), D, { includeOverdueSince: `${wc.shiftMonth(m, -1)}-01` }),
    wd.goalsWithProgress(req.user.id, D),
  ]);
  const overall = b.budgets.find((x) => x.category === wc.OVERALL) || null;
  const open = occ.filter((o) => o.status === 'overdue' || o.status === 'due_today' || o.status === 'upcoming');
  const plannedIncomeP = profile ? money.paiseOf(profile, 'income') : 0;
  res.json({
    month: m,
    income_paise: totals.income_paise, has_income_data: totals.has_income_data,
    planned_income_paise: plannedIncomeP || null, // from the profile, not a recorded receipt
    spent_paise: totals.spent_paise, invested_paise: totals.invested_paise, has_spending_data: totals.has_spending_data,
    net_paise: totals.net_paise,
    overall_budget: overall ? { limit_paise: money.paiseOf(overall), remaining_paise: overall.remaining_paise, over_by_paise: overall.over_by_paise, pct_used: overall.pct_used, state: overall.state, days_remaining: overall.days_remaining } : null,
    alerts: b.budgets.filter((x) => x.state !== 'ok').map((x) => ({ category: x.category, state: x.state, pct_used: x.pct_used, over_by_paise: x.over_by_paise })),
    new_alerts: b.new_alerts,
    bills: {
      overdue_count: open.filter((o) => o.status === 'overdue').length,
      next: open.slice(0, 3).map((o) => wd.occurrenceView(o, D)),
      due_30d_paise: open.reduce((s, o) => s + money.paiseOf(o.bill), 0),
    },
    goals: goals.filter((g) => g.goal.status !== 'completed').slice(0, 3).map((g) => ({
      id: g.goal.id, name: g.goal.name, goal_type: g.goal.goal_type, status: g.goal.status,
      saved_paise: g.progress.saved_paise, target_paise: money.paiseOf(g.goal, 'target'), progress_pct: g.progress.progress_pct, needs_review: g.progress.needs_review,
    })),
    goal_count: goals.length,
  });
}));

// ================= BUDGETS =================
// 50/30/20 suggestion from monthly income
router.get('/budgets/suggestion', asyncHandler(async (req, res) => {
  const p = await db.get('SELECT income FROM profiles WHERE user_id = $1', [req.user.id]);
  if (!p.income) throw new HttpError(400, 'Set your monthly income first: PUT /api/profile { "income": 50000 }');
  res.json({
    income: p.income,
    rule: '50% needs, 30% wants, 20% savings',
    ...calc.budget503020(p.income),
    needs_categories: summary.NEEDS,
  });
}));

// Budgets for a month, with spent / remaining / % used / alerts.
// 'Overall' = the whole month's spending (not income, transfers or Investment).
router.get('/budgets', asyncHandler(async (req, res) => {
  const { month } = validate(req.query, { month: { type: 'month' } });
  const m = month || thisMonth();
  const [b, profile] = await Promise.all([
    wd.budgetsForMonth(req.user.id, m, today(), { record: m === thisMonth() }),
    db.get('SELECT income FROM profiles WHERE user_id = $1', [req.user.id]),
  ]);
  res.json({ month: m, budgets: b.budgets, new_alerts: b.new_alerts, suggestion_503020: profile && profile.income ? calc.budget503020(profile.income) : null });
}));

// Create or change a budget (one per category per month; unique in the DB)
router.put('/budgets', asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    category: { type: 'string', required: true, maxLength: 40 },
    amount: { type: 'money', required: true, min: 0, max: 100000000 },
    month: { type: 'month' },
    alert_levels: { type: 'string', maxLength: 20, pattern: /^(off|((50|80|100)(,(50|80|100))*))$/ },
  });
  if (b.category !== wc.OVERALL) await assertCategory(req.user.id, 'expense', b.category);
  const month = b.month || thisMonth();
  // Free plan: a few category budgets a month (the Overall budget and changes are always fine)
  const existing = await db.get('SELECT id FROM budgets WHERE user_id = $1 AND month = $2 AND category = $3', [req.user.id, month, b.category]);
  if (!existing && b.category !== wc.OVERALL && !(await hasPlan(req.user.id, FEATURE_TIERS.unlimited_budgets))) {
    const count = (await db.get('SELECT COUNT(*)::int AS n FROM budgets WHERE user_id = $1 AND month = $2 AND category <> $3', [req.user.id, month, wc.OVERALL])).n;
    if (count >= FREE_LIMITS.budgets_per_month) {
      throw upgradeError(`The Free plan allows ${FREE_LIMITS.budgets_per_month} budgets a month. Upgrade to Plus for unlimited budgets.`, { plan: 'free', upgradeTo: FEATURE_TIERS.unlimited_budgets, limit: FREE_LIMITS.budgets_per_month });
    }
  }
  // '' (or 'off') turns alerts off; validate() treats '' as "not sent", so check the raw body
  const raw = req.body ? req.body.alert_levels : undefined;
  const levels = raw === '' || raw === 'off' ? '' : b.alert_levels !== undefined ? b.alert_levels : null;
  const budget = await db.get(`INSERT INTO budgets (user_id, month, category, amount, alert_levels) VALUES ($1, $2, $3, $4, COALESCE($5, '50,80,100'))
    ON CONFLICT (user_id, month, category) DO UPDATE SET amount = excluded.amount, alert_levels = COALESCE($5, budgets.alert_levels), updated_at = now()
    RETURNING *`, [req.user.id, month, b.category, b.amount, levels]);
  // A changed limit may need fresh alerts: forget levels no longer reached
  const st = (await wd.budgetsForMonth(req.user.id, month, today())).budgets.find((x) => x.id === budget.id);
  if (st) await db.run('DELETE FROM budget_alerts WHERE user_id = $1 AND month = $2 AND category = $3 AND NOT (level = ANY($4::int[]))', [req.user.id, month, b.category, st.crossed]);
  res.json({ budget: st || budget });
}));

// Copy every budget from one month to another (skips ones already set)
router.post('/budgets/copy', asyncHandler(async (req, res) => {
  const b = validate(req.body, { from: { type: 'month', required: true }, to: { type: 'month', required: true } });
  if (b.from === b.to) throw new HttpError(400, 'Pick two different months');
  const src = await db.all('SELECT category, amount, alert_levels FROM budgets WHERE user_id = $1 AND month = $2 ORDER BY (category = $3) DESC, id', [req.user.id, b.from, wc.OVERALL]);
  const unlimited = await hasPlan(req.user.id, FEATURE_TIERS.unlimited_budgets);
  let copied = 0; let skipped = 0;
  await db.tx(async (t) => {
    for (const s of src) {
      if (!unlimited && s.category !== wc.OVERALL) {
        const n = (await t.get('SELECT COUNT(*)::int AS n FROM budgets WHERE user_id = $1 AND month = $2 AND category <> $3', [req.user.id, b.to, wc.OVERALL])).n;
        if (n >= FREE_LIMITS.budgets_per_month) { skipped++; continue; }
      }
      const r = await t.get(`INSERT INTO budgets (user_id, month, category, amount, alert_levels) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, month, category) DO NOTHING RETURNING id`, [req.user.id, b.to, s.category, s.amount, s.alert_levels]);
      if (r) copied++; else skipped++;
    }
  });
  res.json({ copied, skipped });
}));

router.delete('/budgets/:id', asyncHandler(async (req, res) => {
  const row = await db.get('DELETE FROM budgets WHERE id = $1 AND user_id = $2 RETURNING month, category', [idParam(req), req.user.id]);
  if (!row) throw new HttpError(404, 'Budget not found');
  await db.run('DELETE FROM budget_alerts WHERE user_id = $1 AND month = $2 AND category = $3', [req.user.id, row.month, row.category]);
  res.json({ deleted: true });
}));

// ================= SAVINGS GOALS =================
const GOAL_RULES = {
  name: { type: 'string', required: true, maxLength: 80 },
  target: { type: 'money', required: true, min: 1, max: 1000000000 },
  saved: { type: 'money', min: 0, max: 1000000000 },
  deadline: { type: 'date' },
  goal_type: { type: 'string', oneOf: wd.GOAL_TYPES },
  description: { type: 'string', maxLength: 200 },
  status: { type: 'string', oneOf: wd.GOAL_STATUSES },
};

async function oneGoal(userId, id, q = db) {
  const [g] = await wd.goalsWithProgress(userId, today(), q, id);
  if (!g) throw new HttpError(404, 'Goal not found');
  return g;
}

router.post('/goals', asyncHandler(async (req, res) => {
  const b = validate(req.body, GOAL_RULES);
  // Free plan: only a few savings goals
  if (!(await hasPlan(req.user.id, FEATURE_TIERS.unlimited_goals))) {
    const count = (await db.get('SELECT COUNT(*)::int AS n FROM savings_goals WHERE user_id = $1', [req.user.id])).n;
    if (count >= FREE_LIMITS.savings_goals) {
      throw upgradeError(`The Free plan allows ${FREE_LIMITS.savings_goals} savings goals. Upgrade to Plus for unlimited goals.`, { plan: 'free', upgradeTo: FEATURE_TIERS.unlimited_goals, limit: FREE_LIMITS.savings_goals });
    }
  }
  const id = await db.tx(async (t) => {
    const g = await t.get(`INSERT INTO savings_goals (user_id, name, target, saved, deadline, goal_type, description) VALUES ($1, $2, $3, 0, $4, $5, $6) RETURNING id`,
      [req.user.id, b.name, b.target, b.deadline || null, b.goal_type || 'other', b.description || null]);
    // Money already saved when the goal is made = an opening entry in the history
    if (b.saved > 0) {
      await t.run("INSERT INTO goal_entries (user_id, goal_id, kind, amount, date, note) VALUES ($1, $2, 'opening', $3, $4, 'Already saved')", [req.user.id, g.id, b.saved, today()]);
      await wd.syncGoalSaved(t, req.user.id, g.id);
    }
    return g.id;
  });
  res.status(201).json({ goal: wd.goalView(await oneGoal(req.user.id, id)) });
}));

router.get('/goals', asyncHandler(async (req, res) => {
  const rows = await wd.goalsWithProgress(req.user.id, today());
  res.json({ goals: rows.map(wd.goalView) });
}));

router.put('/goals/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const changes = validate(req.body, GOAL_RULES, { partial: true });
  const g = await oneGoal(req.user.id, id);
  const saved = changes.saved; delete changes.saved;
  if (Object.keys(changes).length) await updateRow('savings_goals', id, req.user.id, changes);
  await db.tx(async (t) => {
    // Old app versions send a new `saved` total: store the difference as history
    if (saved !== undefined) {
      const diffP = money.toPaise(saved) - g.progress.saved_paise;
      if (diffP !== 0) {
        await t.run('INSERT INTO goal_entries (user_id, goal_id, kind, amount, date, note) VALUES ($1, $2, $3, $4, $5, $6)',
          [req.user.id, id, diffP > 0 ? 'contribution' : 'withdrawal', money.rupees(Math.abs(diffP)), today(), 'Adjusted total']);
      }
    }
    await wd.syncGoalSaved(t, req.user.id, id);
  });
  res.json({ goal: wd.goalView(await oneGoal(req.user.id, id)) });
}));

// Contribution / withdrawal. record_transfer: also add a transfer to the ledger
// (money moved from your account into savings: never counted as spending).
async function addGoalEntry(req, id, kind, amount, extra = {}) {
  const g = await oneGoal(req.user.id, id); // 404 if it is not yours
  if (g.goal.status === 'completed' && kind === 'contribution') throw new HttpError(409, 'This goal is completed. Reopen it to add money.');
  if (kind === 'withdrawal' && money.toPaise(amount) > g.progress.saved_paise) throw new HttpError(400, 'You cannot withdraw more than is saved in this goal');
  const key = extra.client_id || null;
  const date = extra.date || today();
  return db.tx(async (t) => {
    if (key) {
      const dup = await t.get('SELECT id FROM goal_entries WHERE user_id = $1 AND client_id = $2', [req.user.id, key]);
      if (dup) return { duplicate: true };
    }
    let txId = null;
    if (extra.record_transfer) {
      const tr = await t.get(`INSERT INTO expenses (user_id, type, transfer_kind, amount, category, mode, date, note, from_account, to_account, client_id)
        VALUES ($1, 'transfer', 'goal', $2, 'Transfer', $3, $4, $5, $6, $7, $8)
        ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
      [req.user.id, amount, extra.mode || 'Bank transfer', date, `${kind === 'withdrawal' ? 'From' : 'To'} goal: ${g.goal.name}`.slice(0, 200),
        kind === 'withdrawal' ? g.goal.name.slice(0, 40) : (extra.account || null), kind === 'withdrawal' ? (extra.account || null) : g.goal.name.slice(0, 40), key ? `goal:${key}` : null]);
      txId = tr ? tr.id : null;
    }
    const ins = await t.get(`INSERT INTO goal_entries (user_id, goal_id, kind, amount, date, note, transaction_id, client_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
    [req.user.id, id, kind, amount, date, extra.note || null, txId, key]);
    if (!ins) return { duplicate: true };
    await wd.syncGoalSaved(t, req.user.id, id);
    return { duplicate: false };
  });
}

// Old endpoint: add money to a goal { "amount": 2000 }
router.post('/goals/:id/add', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { amount } = validate(req.body, { amount: { type: 'money', required: true, min: 1, max: 1000000000 } });
  await addGoalEntry(req, id, 'contribution', amount, { client_id: clientKey(req) });
  res.json({ goal: wd.goalView(await oneGoal(req.user.id, id)) });
}));

router.get('/goals/:id/entries', asyncHandler(async (req, res) => {
  const g = await oneGoal(req.user.id, idParam(req));
  res.json({ goal: wd.goalView(g), entries: g.entries.map((e) => ({ ...e, amount_paise: Number(e.amount_paise) })).reverse() });
}));

router.post('/goals/:id/entries', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const b = validate(req.body, {
    kind: { type: 'string', required: true, oneOf: ['contribution', 'withdrawal'] },
    amount: { type: 'money', required: true, min: 1, max: 1000000000 },
    date: { type: 'date' }, note: { type: 'string', maxLength: 120 },
    record_transfer: { type: 'boolean' }, account: { type: 'string', maxLength: 40 }, mode: { type: 'string', oneOf: MODES },
  });
  if (b.date && b.date > today()) throw new HttpError(400, 'Invalid input', ['date cannot be in the future']);
  const r = await addGoalEntry(req, id, b.kind, b.amount, { ...b, client_id: clientKey(req) });
  res.status(r.duplicate ? 200 : 201).json({ goal: wd.goalView(await oneGoal(req.user.id, id)), duplicate: r.duplicate });
}));

router.delete('/goals/:id/entries/:entryId', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const entryId = Number(req.params.entryId);
  if (!Number.isInteger(entryId) || entryId <= 0) throw new HttpError(400, 'Invalid id');
  await db.tx(async (t) => {
    const e = await t.get('DELETE FROM goal_entries WHERE id = $1 AND goal_id = $2 AND user_id = $3 RETURNING transaction_id', [entryId, id, req.user.id]);
    if (!e) throw new HttpError(404, 'Entry not found');
    // the transfer this entry made goes too (it only existed because of the entry)
    if (e.transaction_id) await t.run("DELETE FROM expenses WHERE id = $1 AND user_id = $2 AND type = 'transfer' AND transfer_kind = 'goal'", [e.transaction_id, req.user.id]);
    await wd.syncGoalSaved(t, req.user.id, id);
  });
  res.json({ goal: wd.goalView(await oneGoal(req.user.id, id)) });
}));

router.delete('/goals/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM savings_goals WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Goal not found');
  res.json({ deleted: true });
}));

// Emergency fund planning estimate.
// GET /emergency-fund?essential=25000&months=6&current=40000&target_date=2027-11-01
// Without `essential`, returns a hint: average essential spending of the last
// 3 full months (needs categories + EMI + insurance), when there is data.
const ESSENTIALS = [...summary.NEEDS, 'Mobile & Internet', 'Insurance', 'EMI & Loans', 'Family & Household'];
router.get('/emergency-fund', asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    essential: { type: 'money', min: 1, max: 100000000 }, months: { type: 'integer', min: 1, max: 24 },
    current: { type: 'money', min: 0, max: 1000000000 }, target_date: { type: 'date' },
  });
  const m = thisMonth();
  const months = [-3, -2, -1].map((k) => wc.shiftMonth(m, k));
  const totals = await Promise.all(months.map((x) => wd.monthTotals(req.user.id, x)));
  const withData = totals.filter((t) => t.has_spending_data);
  const hintP = withData.length === 3
    ? Math.round(withData.reduce((s, t) => s + ESSENTIALS.reduce((a, c) => a + wc.categorySpent(t, c), 0), 0) / 3)
    : null;
  let plan = null;
  if (q.essential) {
    plan = wc.emergencyFund({ essentialP: money.toPaise(q.essential), months: q.months || 6, currentP: money.toPaise(q.current || 0), targetDate: q.target_date || null, today: today() });
  }
  res.json({
    essentials_hint_paise: hintP, essentials_hint_months: months, essentials_categories: ESSENTIALS,
    plan,
    note: 'A planning estimate only. The right size depends on how steady your income is, who depends on you, your insurance and your debts.',
  });
}));

// ================= BILLS =================
const BILL_RULES = {
  name: { type: 'string', required: true, maxLength: 80 },
  amount: { type: 'money', required: true, min: 1, max: 100000000 },
  due_day: { type: 'integer', min: 1, max: 31 },
  recurring: { type: 'boolean' },
  frequency: { type: 'string', oneOf: wc.FREQUENCIES },
  bill_type: { type: 'string', oneOf: wd.BILL_TYPES },
  category: { type: 'string', maxLength: 40 },
  start_date: { type: 'date' },
  end_date: { type: 'date' },
  reminder_days: { type: 'integer', min: 0, max: 30 },
  reminders_on: { type: 'boolean' },
  notes: { type: 'string', maxLength: 200 },
};

/**
 * A bill as seen in one month (old shape, kept for older app versions):
 * due_date, paid, overdue for that month's (first) occurrence + next_due.
 */
async function billView(bill, month) {
  const D = today();
  const { from, to } = wc.monthRange(month);
  const occ = await wd.billOccurrences(bill.user_id, from, to, D, { billId: bill.id });
  const first = occ.find((o) => o.due_date >= from) || occ[0] || null;
  const paid = first ? first.status === 'paid' : !bill.recurring;
  const day = Math.min(bill.due_day, daysInMonth(month));
  return {
    ...bill,
    recurring: Boolean(bill.recurring),
    month,
    due_date: first ? first.due_date : `${month}-${String(day).padStart(2, '0')}`,
    effective_date: first ? first.effective_date : null,
    occurrence_status: first ? first.status : 'none',
    has_occurrence: Boolean(first),
    paid,
    paid_at: first && first.row ? first.row.paid_on : null,
    overdue: first ? first.status === 'overdue' : false,
    next_due: wc.nextDue(bill, D),
  };
}

function billCols(b) {
  const c = { ...b };
  if (c.recurring !== undefined) c.recurring = c.recurring ? 1 : 0;
  if (c.category) c.category = String(c.category);
  return c;
}

router.post('/bills', asyncHandler(async (req, res) => {
  const b = validate(req.body, BILL_RULES);
  const freq = b.frequency || 'monthly';
  const start = b.start_date || null;
  if (freq === 'monthly' && !b.due_day && !start) throw new HttpError(400, 'Invalid input', ['due_day is required']);
  if (freq !== 'monthly' && !start) throw new HttpError(400, 'Invalid input', ['start_date (first due date) is required for weekly, quarterly and yearly bills']);
  if (b.end_date && start && b.end_date < start) throw new HttpError(400, 'Invalid input', ['end_date must be after start_date']);
  if (b.category) await assertCategory(req.user.id, 'expense', b.category);
  const dueDay = b.due_day || Number(start.slice(8, 10));
  // A monthly bill without a start date starts this month (no made-up past dues)
  const startDate = start || `${thisMonth()}-01`;
  const recurring = b.recurring === undefined ? 1 : b.recurring ? 1 : 0;
  const row = await db.get(`INSERT INTO bills (user_id, name, amount, due_day, recurring, frequency, bill_type, category, start_date, end_date, reminder_days, reminders_on, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 1), COALESCE($12, true), $13) RETURNING *`,
  [req.user.id, b.name, b.amount, dueDay, recurring, freq, b.bill_type || null, b.category || null, startDate, b.end_date || null, b.reminder_days ?? null, b.reminders_on ?? null, b.notes || null]);
  res.status(201).json({ bill: await billView(row, thisMonth()) });
}));

// GET /bills?month=2026-10 (old shape: one line per bill for the month)
router.get('/bills', asyncHandler(async (req, res) => {
  const { month } = validate(req.query, { month: { type: 'month' } });
  const m = month || thisMonth();
  const rows = await db.all("SELECT * FROM bills WHERE user_id = $1 AND (cancelled_from IS NULL OR cancelled_from > $2) ORDER BY due_day, id", [req.user.id, `${m}-01`]);
  const bills = (await Promise.all(rows.map((b) => billView(b, m)))).filter((b) => b.has_occurrence || b.next_due);
  const unpaid = bills.filter((b) => b.has_occurrence && !b.paid && b.occurrence_status !== 'skipped');
  res.json({
    month: m,
    bills,
    total_due: money.rupees(money.sumPaise(unpaid)),
    total_due_paise: money.sumPaise(unpaid),
    overdue_count: bills.filter((b) => b.overdue).length,
  });
}));

// Upcoming + overdue occurrences: GET /bills/upcoming?days=45
router.get('/bills/upcoming', asyncHandler(async (req, res) => {
  const { days } = validate(req.query, { days: { type: 'integer', min: 1, max: 400 } });
  const D = today();
  const occ = await wd.billOccurrences(req.user.id, D, wc.addDays(D, days || 45), D, { includeOverdueSince: wc.addDays(D, -90) });
  const list = occ.map((o) => wd.occurrenceView(o, D));
  res.json({
    today: D,
    overdue: list.filter((o) => o.status === 'overdue'),
    upcoming: list.filter((o) => o.status === 'upcoming' || o.status === 'due_today'),
    done: list.filter((o) => o.status === 'paid' || o.status === 'skipped'),
  });
}));

router.get('/bills/:id/history', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const bill = await getOwned('bills', id, req.user.id);
  const rows = await db.all('SELECT * FROM bill_occurrences WHERE bill_id = $1 AND user_id = $2 ORDER BY due_date DESC LIMIT 60', [id, req.user.id]);
  res.json({ bill: await billView(bill, thisMonth()), history: rows.map((r) => ({ ...r, paid_amount_paise: r.paid_amount_paise != null ? Number(r.paid_amount_paise) : null })) });
}));

router.put('/bills/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const changes = validate(req.body, BILL_RULES, { partial: true });
  if (changes.category) await assertCategory(req.user.id, 'expense', changes.category);
  const prev = await getOwned('bills', id, req.user.id);
  const t = { ...prev, ...changes };
  if (t.end_date && t.start_date && t.end_date < t.start_date) throw new HttpError(400, 'Invalid input', ['end_date must be after start_date']);
  if (t.frequency !== 'monthly' && !t.start_date) throw new HttpError(400, 'Invalid input', ['start_date is required for this frequency']);
  await updateRow('bills', id, req.user.id, billCols(changes));
  await db.run('UPDATE bills SET updated_at = now() WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  res.json({ bill: await billView(await getOwned('bills', id, req.user.id), thisMonth()) });
}));

// Stop future occurrences from a date (default today); history stays
router.post('/bills/:id/cancel', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { from } = validate(req.body, { from: { type: 'date' } });
  await getOwned('bills', id, req.user.id);
  await db.run('UPDATE bills SET cancelled_from = $1, updated_at = now() WHERE id = $2 AND user_id = $3', [from || today(), id, req.user.id]);
  res.json({ bill: await billView(await getOwned('bills', id, req.user.id), thisMonth()) });
}));

router.delete('/bills/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM bills WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Bill not found');
  res.json({ deleted: true });
}));

// Is `date` a real due date of this bill? (stops made-up occurrences)
async function assertOccurrence(bill, date) {
  if (!DATE_RE.test(date)) throw new HttpError(400, 'Invalid due date');
  const ok = wc.occurrences(bill, date, date).length === 1;
  const stored = await db.get('SELECT 1 FROM bill_occurrences WHERE bill_id = $1 AND due_date = $2', [bill.id, date]);
  if (!ok && !stored && !(bill.recurring === 0 && Number(date.slice(8, 10)) === Math.min(bill.due_day, wc.daysInMonthKey(date.slice(0, 7))))) {
    throw new HttpError(404, 'This bill is not due on that date');
  }
}

// Possible existing payments to link (no second expense)
router.get('/bills/:id/occurrences/:date/matches', asyncHandler(async (req, res) => {
  const bill = await getOwned('bills', idParam(req), req.user.id);
  await assertOccurrence(bill, req.params.date);
  const d = req.params.date;
  const txs = await db.all(`SELECT id, type, category, amount, amount_paise, date, mode, note, merchant FROM expenses
    WHERE user_id = $1 AND type = 'expense' AND date >= $2 AND date <= $3`, [req.user.id, wc.addDays(d, -7), wc.addDays(d, 7)]);
  const linked = (await db.all('SELECT transaction_id FROM bill_occurrences WHERE user_id = $1 AND transaction_id IS NOT NULL', [req.user.id])).map((r) => r.transaction_id);
  res.json({ matches: wc.matchCandidates(money.paiseOf(bill), d, txs.map(txView), linked).slice(0, 5) });
}));

/**
 * Mark one occurrence paid. Body (all optional):
 *  amount (default: the bill amount), paid_on (default today), mode,
 *  link_transaction_id: an existing expense that WAS this payment (no new row), or
 *  record_expense: true -> add the payment to the ledger as an expense.
 * Paying twice (double tap / retry) changes nothing the second time.
 */
router.post('/bills/:id/occurrences/:date/pay', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const bill = await getOwned('bills', id, req.user.id);
  const d = req.params.date;
  await assertOccurrence(bill, d);
  const b = validate(req.body, {
    amount: { type: 'money', min: 1, max: 100000000 }, paid_on: { type: 'date' }, mode: { type: 'string', oneOf: MODES },
    link_transaction_id: { type: 'integer', min: 1 }, record_expense: { type: 'boolean' },
  });
  if (b.link_transaction_id && b.record_expense) throw new HttpError(400, 'Choose either link_transaction_id or record_expense');
  const paidOn = b.paid_on || today();
  if (paidOn > today()) throw new HttpError(400, 'Invalid input', ['paid_on cannot be in the future']);
  const result = await db.tx(async (t) => {
    let txRow = null;
    if (b.link_transaction_id) {
      txRow = await t.get("SELECT id, amount FROM expenses WHERE id = $1 AND user_id = $2 AND type = 'expense'", [b.link_transaction_id, req.user.id]);
      if (!txRow) throw new HttpError(400, 'That transaction is not one of your expenses');
      const other = await t.get('SELECT bill_id, due_date FROM bill_occurrences WHERE transaction_id = $1 AND NOT (bill_id = $2 AND due_date = $3)', [txRow.id, id, d]);
      if (other) throw new HttpError(409, 'That transaction is already linked to another bill payment');
    }
    const amount = b.amount || (txRow ? txRow.amount : bill.amount);
    const occ = await t.get(`INSERT INTO bill_occurrences (user_id, bill_id, due_date, status, paid_on, paid_amount, transaction_id)
      VALUES ($1, $2, $3, 'paid', $4, $5, $6)
      ON CONFLICT (bill_id, due_date) DO UPDATE SET status = 'paid', paid_on = excluded.paid_on, paid_amount = excluded.paid_amount,
        transaction_id = COALESCE(excluded.transaction_id, bill_occurrences.transaction_id), updated_at = now()
      WHERE bill_occurrences.status <> 'paid'
      RETURNING *`, [req.user.id, id, d, paidOn, amount, txRow ? txRow.id : null]);
    if (!occ) return { already: true };
    if (b.record_expense && !occ.transaction_id) {
      const ex = await t.get(`INSERT INTO expenses (user_id, type, amount, category, mode, date, note) VALUES ($1, 'expense', $2, $3, $4, $5, $6) RETURNING id`,
        [req.user.id, amount, bill.category || 'Bills', b.mode || 'UPI', paidOn, `Bill: ${bill.name}`.slice(0, 200)]);
      await t.run('UPDATE bill_occurrences SET transaction_id = $1, created_expense = true WHERE id = $2', [ex.id, occ.id]);
    }
    // Keep the old monthly paid table in step (older readers use it)
    if ((bill.frequency || 'monthly') === 'monthly') {
      await t.run('INSERT INTO bill_payments (bill_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, d.slice(0, 7)]);
    }
    return { already: false };
  });
  const row = await db.get('SELECT * FROM bill_occurrences WHERE bill_id = $1 AND due_date = $2', [id, d]);
  res.json({ occurrence: { ...row, paid_amount_paise: row.paid_amount_paise != null ? Number(row.paid_amount_paise) : null }, already_paid: result.already });
}));

// Undo "paid". The expense this app created for it is removed; a linked
// expense you recorded yourself is kept (only unlinked).
router.delete('/bills/:id/occurrences/:date/pay', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const bill = await getOwned('bills', id, req.user.id);
  const d = req.params.date;
  if (!DATE_RE.test(d)) throw new HttpError(400, 'Invalid due date');
  await db.tx(async (t) => {
    const occ = await t.get("DELETE FROM bill_occurrences WHERE bill_id = $1 AND due_date = $2 AND user_id = $3 AND status = 'paid' RETURNING transaction_id, created_expense", [id, d, req.user.id]);
    if (occ && occ.created_expense && occ.transaction_id) await t.run('DELETE FROM expenses WHERE id = $1 AND user_id = $2', [occ.transaction_id, req.user.id]);
    if ((bill.frequency || 'monthly') === 'monthly') await t.run('DELETE FROM bill_payments WHERE bill_id = $1 AND month = $2', [id, d.slice(0, 7)]);
  });
  res.json({ ok: true });
}));

// Skip one occurrence (e.g. not charged this month)
router.post('/bills/:id/occurrences/:date/skip', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const bill = await getOwned('bills', id, req.user.id);
  await assertOccurrence(bill, req.params.date);
  const row = await db.get(`INSERT INTO bill_occurrences (user_id, bill_id, due_date, status) VALUES ($1, $2, $3, 'skipped')
    ON CONFLICT (bill_id, due_date) DO UPDATE SET status = 'skipped', postponed_to = NULL, updated_at = now() WHERE bill_occurrences.status <> 'paid' RETURNING *`,
  [req.user.id, id, req.params.date]);
  if (!row) throw new HttpError(409, 'Already paid. Undo the payment first.');
  res.json({ occurrence: row });
}));

// Postpone one occurrence to a later date: { to: 'YYYY-MM-DD' }
router.post('/bills/:id/occurrences/:date/postpone', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const bill = await getOwned('bills', id, req.user.id);
  const d = req.params.date;
  await assertOccurrence(bill, d);
  const { to } = validate(req.body, { to: { type: 'date', required: true } });
  if (to <= d) throw new HttpError(400, 'Invalid input', ['to must be after the due date']);
  if (wc.diffDays(d, to) > 90) throw new HttpError(400, 'Invalid input', ['You can postpone by up to 90 days']);
  const row = await db.get(`INSERT INTO bill_occurrences (user_id, bill_id, due_date, status, postponed_to) VALUES ($1, $2, $3, 'postponed', $4)
    ON CONFLICT (bill_id, due_date) DO UPDATE SET status = 'postponed', postponed_to = excluded.postponed_to, updated_at = now() WHERE bill_occurrences.status <> 'paid' RETURNING *`,
  [req.user.id, id, d, to]);
  if (!row) throw new HttpError(409, 'Already paid. Undo the payment first.');
  res.json({ occurrence: row });
}));

// Old endpoints: mark paid / undo for a month (monthly bills)
router.post('/bills/:id/pay', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { month } = validate(req.body, { month: { type: 'month' } });
  const bill = await getOwned('bills', id, req.user.id);
  const m = month || thisMonth();
  const { from, to } = wc.monthRange(m);
  const occ = (await wd.billOccurrences(req.user.id, from, to, today(), { billId: id }))[0];
  const due = occ ? occ.due_date : `${m}-${String(Math.min(bill.due_day, daysInMonth(m))).padStart(2, '0')}`;
  await db.tx(async (t) => {
    await t.run(`INSERT INTO bill_occurrences (user_id, bill_id, due_date, status, paid_on, paid_amount) VALUES ($1, $2, $3, 'paid', $4, $5)
      ON CONFLICT (bill_id, due_date) DO UPDATE SET status = 'paid', paid_on = excluded.paid_on, paid_amount = excluded.paid_amount, updated_at = now()
      WHERE bill_occurrences.status <> 'paid'`, [req.user.id, id, due, today(), bill.amount]);
    await t.run('INSERT INTO bill_payments (bill_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, m]);
  });
  res.json({ bill: await billView(bill, m) });
}));

router.delete('/bills/:id/pay', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { month } = validate(req.query, { month: { type: 'month' } });
  const bill = await getOwned('bills', id, req.user.id);
  const m = month || thisMonth();
  const { from, to } = wc.monthRange(m);
  await db.tx(async (t) => {
    const occ = await t.all("DELETE FROM bill_occurrences WHERE bill_id = $1 AND user_id = $2 AND due_date >= $3 AND due_date <= $4 AND status = 'paid' RETURNING transaction_id, created_expense", [id, req.user.id, from, to]);
    for (const o of occ) if (o.created_expense && o.transaction_id) await t.run('DELETE FROM expenses WHERE id = $1 AND user_id = $2', [o.transaction_id, req.user.id]);
    await t.run('DELETE FROM bill_payments WHERE bill_id = $1 AND month = $2', [id, m]);
  });
  res.json({ bill: await billView(bill, m) });
}));

// ================= CALCULATORS =================
// GET /calculators/sip?monthly=5000&rate=12&years=10
// Calculators are a Plus feature (and above)
router.get('/calculators/sip', requirePlan(FEATURE_TIERS.calculators), (req, res) => {
  const q = validate(req.query, {
    monthly: { type: 'number', required: true, min: 100 },
    rate: { type: 'number', required: true, min: 0, max: 50 },
    years: { type: 'number', required: true, min: 0.1, max: 50 },
  });
  res.json({ input: q, ...calc.sip(q.monthly, q.rate, q.years), note: 'Returns are not guaranteed. This is an estimate.' });
});

// GET /calculators/emi?principal=500000&rate=9.5&months=60
router.get('/calculators/emi', requirePlan(FEATURE_TIERS.calculators), (req, res) => {
  const q = validate(req.query, {
    principal: { type: 'number', required: true, min: 1000 },
    rate: { type: 'number', required: true, min: 0, max: 60 },
    months: { type: 'integer', required: true, min: 1, max: 480 },
  });
  res.json({ input: q, ...calc.emi(q.principal, q.rate, q.months) });
});

module.exports = router;
