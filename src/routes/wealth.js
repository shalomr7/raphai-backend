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
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const calc = require('../utils/calc');
const { validate, idParam, HttpError, asyncHandler } = require('../utils/http');
const { today, thisMonth, daysInMonth } = require('../utils/dates');
const summary = require('../services/summary');
const { hasPlan, requirePlan } = require('../middleware/requirePlan');
const { FREE_LIMITS } = require('../utils/plans');

const router = express.Router();
const MODES = ['UPI', 'Card', 'Cash'];

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

router.get('/categories', (req, res) => {
  res.json({
    categories: summary.EXPENSE_CATEGORIES, needs: summary.NEEDS, savings: summary.SAVINGS, modes: MODES,
    free_limits: FREE_LIMITS,
  });
});

// ================= EXPENSES =================
const EXPENSE_RULES = {
  amount: { type: 'number', required: true, min: 1, max: 10000000 },
  category: { type: 'string', required: true, oneOf: summary.EXPENSE_CATEGORIES },
  mode: { type: 'string', required: true, oneOf: MODES },
  note: { type: 'string', maxLength: 200 },
  date: { type: 'date' },
};

router.post('/expenses', asyncHandler(async (req, res) => {
  const b = validate(req.body, EXPENSE_RULES);
  const info = await db.get('INSERT INTO expenses (user_id, amount, category, mode, note, date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [req.user.id, b.amount, b.category, b.mode, b.note || null, b.date || today()]);
  res.status(201).json({ expense: await getOwned('expenses', info.id, req.user.id) });
}));

// GET /expenses?month=2026-10  or  ?from=&to=  and optional &category=Food
router.get('/expenses', asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    month: { type: 'month' }, from: { type: 'date' }, to: { type: 'date' },
    category: { type: 'string', oneOf: summary.EXPENSE_CATEGORIES },
  });
  let sql = 'SELECT * FROM expenses WHERE user_id = @user_id';
  const params = { user_id: req.user.id };
  if (q.month) { sql += ' AND substr(date, 1, 7) = @month'; params.month = q.month; }
  if (q.from) { sql += ' AND date >= @from'; params.from = q.from; }
  if (q.to) { sql += ' AND date <= @to'; params.to = q.to; }
  if (q.category) { sql += ' AND category = @category'; params.category = q.category; }
  const rows = await db.all(sql + ' ORDER BY date DESC, id DESC', params);
  res.json({ expenses: rows, total: calc.round(rows.reduce((s, e) => s + e.amount, 0)) });
}));

// Monthly summary by category (put BEFORE "/expenses/:id" style routes)
router.get('/expenses/summary', asyncHandler(async (req, res) => {
  const { month } = validate(req.query, { month: { type: 'month' } });
  const m = await summary.wealthMonth(req.user.id, month || thisMonth());
  const byMode = await db.all(`SELECT mode, SUM(amount) AS total FROM expenses
    WHERE user_id = $1 AND substr(date,1,7) = $2 GROUP BY mode`, [req.user.id, m.month]);
  res.json({
    month: m.month,
    income: m.income,
    total_spent: m.spent,
    invested: m.invested,
    left_over: calc.round(m.income - m.spent - m.invested),
    needs: m.needs,
    wants: m.wants,
    by_category: m.by_category,
    by_mode: byMode,
  });
}));

router.put('/expenses/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  await updateRow('expenses', id, req.user.id, validate(req.body, EXPENSE_RULES, { partial: true }));
  res.json({ expense: await getOwned('expenses', id, req.user.id) });
}));

router.delete('/expenses/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM expenses WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Expense not found');
  res.json({ deleted: true });
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

// Budgets for a month, with how much is spent in each
router.get('/budgets', asyncHandler(async (req, res) => {
  const { month } = validate(req.query, { month: { type: 'month' } });
  const m = await summary.wealthMonth(req.user.id, month || thisMonth());
  const spentIn = Object.fromEntries(m.by_category.map((c) => [c.category, c.total]));
  const rows = (await db.all('SELECT * FROM budgets WHERE user_id = $1 AND month = $2 ORDER BY category', [req.user.id, m.month])).map((b) => {
    const spent = spentIn[b.category] || 0;
    return { ...b, spent, left: calc.round(b.amount - spent), over_budget: spent > b.amount };
  });
  res.json({ month: m.month, budgets: rows, suggestion_503020: m.income ? calc.budget503020(m.income) : null });
}));

// Create or change a budget (one per category per month)
router.put('/budgets', asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    category: { type: 'string', required: true, oneOf: summary.EXPENSE_CATEGORIES },
    amount: { type: 'number', required: true, min: 0 },
    month: { type: 'month' },
  });
  const month = b.month || thisMonth();
  // Free plan: only a few budgets per month (changing an existing one is always fine)
  const existing = await db.get('SELECT id FROM budgets WHERE user_id = $1 AND month = $2 AND category = $3', [req.user.id, month, b.category]);
  if (!existing && !(await hasPlan(req.user.id, 'pro'))) {
    const count = (await db.get('SELECT COUNT(*)::int AS n FROM budgets WHERE user_id = $1 AND month = $2', [req.user.id, month])).n;
    if (count >= FREE_LIMITS.budgets_per_month) {
      throw new HttpError(402, `The Free plan allows ${FREE_LIMITS.budgets_per_month} budgets a month. Upgrade to Pro for unlimited budgets.`);
    }
  }
  const budget = await db.get(`INSERT INTO budgets (user_id, month, category, amount) VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, month, category) DO UPDATE SET amount = excluded.amount
    RETURNING *`, [req.user.id, month, b.category, b.amount]);
  res.json({ budget });
}));

router.delete('/budgets/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM budgets WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Budget not found');
  res.json({ deleted: true });
}));

// ================= SAVINGS GOALS =================
const GOAL_RULES = {
  name: { type: 'string', required: true, maxLength: 80 },
  target: { type: 'number', required: true, min: 1 },
  saved: { type: 'number', min: 0 },
  deadline: { type: 'date' },
};

// Add helpful numbers: % done, and how much to save per month to hit the deadline
function goalView(g) {
  const left = Math.max(0, g.target - g.saved);
  let monthsLeft = null; let perMonth = null;
  if (g.deadline) {
    const days = (new Date(g.deadline) - new Date(today())) / 86400000;
    monthsLeft = Math.max(1, Math.ceil(days / 30.44));
    perMonth = calc.round(left / monthsLeft);
  }
  return { ...g, left: calc.round(left), progress_pct: calc.round((g.saved / g.target) * 100, 1), months_left: monthsLeft, save_per_month: perMonth };
}

router.post('/goals', asyncHandler(async (req, res) => {
  const b = validate(req.body, GOAL_RULES);
  // Free plan: only a few savings goals
  if (!(await hasPlan(req.user.id, 'pro'))) {
    const count = (await db.get('SELECT COUNT(*)::int AS n FROM savings_goals WHERE user_id = $1', [req.user.id])).n;
    if (count >= FREE_LIMITS.savings_goals) {
      throw new HttpError(402, `The Free plan allows ${FREE_LIMITS.savings_goals} savings goals. Upgrade to Pro for unlimited goals.`);
    }
  }
  const info = await db.get('INSERT INTO savings_goals (user_id, name, target, saved, deadline) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.user.id, b.name, b.target, b.saved || 0, b.deadline || null]);
  res.status(201).json({ goal: goalView(await getOwned('savings_goals', info.id, req.user.id)) });
}));

router.get('/goals', asyncHandler(async (req, res) => {
  const rows = await db.all('SELECT * FROM savings_goals WHERE user_id = $1 ORDER BY id', [req.user.id]);
  res.json({ goals: rows.map(goalView) });
}));

router.put('/goals/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  await updateRow('savings_goals', id, req.user.id, validate(req.body, GOAL_RULES, { partial: true }));
  res.json({ goal: goalView(await getOwned('savings_goals', id, req.user.id)) });
}));

// Add money to a goal: { "amount": 2000 }
router.post('/goals/:id/add', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { amount } = validate(req.body, { amount: { type: 'number', required: true, min: 1 } });
  await getOwned('savings_goals', id, req.user.id); // 404 if it is not yours
  // "saved = saved + amount" in one statement, so two quick taps both count
  await db.run('UPDATE savings_goals SET saved = saved + $1 WHERE id = $2 AND user_id = $3', [amount, id, req.user.id]);
  res.json({ goal: goalView(await getOwned('savings_goals', id, req.user.id)) });
}));

router.delete('/goals/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM savings_goals WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Goal not found');
  res.json({ deleted: true });
}));

// ================= BILLS =================
const BILL_RULES = {
  name: { type: 'string', required: true, maxLength: 80 },
  amount: { type: 'number', required: true, min: 1 },
  due_day: { type: 'integer', required: true, min: 1, max: 31 },
  recurring: { type: 'boolean' },
};

/**
 * Show a bill for a given month:
 *  - due_date: the real date it is due (31st becomes 30th in a 30-day month)
 *  - paid: paid for that month? (one-time bills: paid in ANY month)
 *  - overdue: not paid and the due date has passed
 */
async function billView(bill, month) {
  const day = Math.min(bill.due_day, daysInMonth(month));
  const dueDate = `${month}-${String(day).padStart(2, '0')}`;
  const paidRow = bill.recurring
    ? await db.get('SELECT paid_at FROM bill_payments WHERE bill_id = $1 AND month = $2', [bill.id, month])
    : await db.get('SELECT paid_at FROM bill_payments WHERE bill_id = $1 ORDER BY month LIMIT 1', [bill.id]);
  const paid = Boolean(paidRow);
  return {
    ...bill,
    recurring: Boolean(bill.recurring),
    month,
    due_date: dueDate,
    paid,
    paid_at: paidRow ? paidRow.paid_at : null,
    overdue: !paid && dueDate < today(),
  };
}

router.post('/bills', asyncHandler(async (req, res) => {
  const b = validate(req.body, BILL_RULES);
  const recurring = b.recurring === undefined ? 1 : b.recurring ? 1 : 0;
  const info = await db.get('INSERT INTO bills (user_id, name, amount, due_day, recurring) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.user.id, b.name, b.amount, b.due_day, recurring]);
  res.status(201).json({ bill: await billView(await getOwned('bills', info.id, req.user.id), thisMonth()) });
}));

// GET /bills?month=2026-10
router.get('/bills', asyncHandler(async (req, res) => {
  const { month } = validate(req.query, { month: { type: 'month' } });
  const m = month || thisMonth();
  const rows = await db.all('SELECT * FROM bills WHERE user_id = $1 ORDER BY due_day, id', [req.user.id]);
  const bills = await Promise.all(rows.map((b) => billView(b, m)));
  const unpaid = bills.filter((b) => !b.paid);
  res.json({
    month: m,
    bills,
    total_due: calc.round(unpaid.reduce((s, b) => s + b.amount, 0)),
    overdue_count: bills.filter((b) => b.overdue).length,
  });
}));

router.put('/bills/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const changes = validate(req.body, BILL_RULES, { partial: true });
  if (changes.recurring !== undefined) changes.recurring = changes.recurring ? 1 : 0;
  await updateRow('bills', id, req.user.id, changes);
  res.json({ bill: await billView(await getOwned('bills', id, req.user.id), thisMonth()) });
}));

router.delete('/bills/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM bills WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Bill not found');
  res.json({ deleted: true });
}));

// Mark paid: POST /bills/:id/pay  { "month": "2026-10" } (month optional)
router.post('/bills/:id/pay', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { month } = validate(req.body, { month: { type: 'month' } });
  const bill = await getOwned('bills', id, req.user.id);
  const m = month || thisMonth();
  await db.run('INSERT INTO bill_payments (bill_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, m]);
  res.json({ bill: await billView(bill, m) });
}));

// Undo "paid": DELETE /bills/:id/pay?month=2026-10
router.delete('/bills/:id/pay', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { month } = validate(req.query, { month: { type: 'month' } });
  const bill = await getOwned('bills', id, req.user.id);
  const m = month || thisMonth();
  await db.run('DELETE FROM bill_payments WHERE bill_id = $1 AND month = $2', [id, m]);
  res.json({ bill: await billView(bill, m) });
}));

// ================= CALCULATORS =================
// GET /calculators/sip?monthly=5000&rate=12&years=10
// Calculators are a Pro feature
router.get('/calculators/sip', requirePlan('pro'), (req, res) => {
  const q = validate(req.query, {
    monthly: { type: 'number', required: true, min: 100 },
    rate: { type: 'number', required: true, min: 0, max: 50 },
    years: { type: 'number', required: true, min: 0.1, max: 50 },
  });
  res.json({ input: q, ...calc.sip(q.monthly, q.rate, q.years), note: 'Returns are not guaranteed. This is an estimate.' });
});

// GET /calculators/emi?principal=500000&rate=9.5&months=60
router.get('/calculators/emi', requirePlan('pro'), (req, res) => {
  const q = validate(req.query, {
    principal: { type: 'number', required: true, min: 1000 },
    rate: { type: 'number', required: true, min: 0, max: 60 },
    months: { type: 'integer', required: true, min: 1, max: 480 },
  });
  res.json({ input: q, ...calc.emi(q.principal, q.rate, q.months) });
});

module.exports = router;
