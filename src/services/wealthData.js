// services/wealthData.js
// ------------------------------------------------------------
// Database side of HeartPurse Wealth: loads a user's rows and hands them to
// the pure functions in wealthCalc.js. Every query is scoped by user_id.
// Never logs amounts, notes or merchants.
// ------------------------------------------------------------
const db = require('../db');
const money = require('../utils/money');
const wc = require('./wealthCalc');

// Built-in categories. The first 13 are the original HeartPurse ones (kept
// so existing records and budgets stay valid); the rest were added for the
// Wealth MVP. Users can add their own (wealth_categories).
const EXPENSE_CATEGORIES = [
  'Food', 'Groceries', 'Rent', 'Transport', 'Bills', 'Health', 'Education',
  'Shopping', 'Entertainment', 'Travel', 'Personal Care', 'Investment', 'Other',
  'Mobile & Internet', 'Insurance', 'EMI & Loans', 'Family & Household',
];
const INCOME_CATEGORIES = ['Salary', 'Freelance', 'Business', 'Interest', 'Gifts', 'Other Income'];
// Payment methods are LABELS only. HeartPurse has no bank/UPI/card access.
// 'Card' is the old label (kept for existing records).
const MODES = ['UPI', 'Cash', 'Debit card', 'Credit card', 'Bank transfer', 'Net banking', 'Wallet', 'Other', 'Card'];
const NEW_MODES = MODES.filter((m) => m !== 'Card');
const TRANSFER_KINDS = ['own_account', 'card_bill', 'goal'];
const GOAL_TYPES = ['emergency', 'travel', 'education', 'vehicle', 'home', 'electronics', 'other'];
const GOAL_STATUSES = ['active', 'paused', 'completed'];
const BILL_TYPES = ['rent', 'electricity', 'water', 'mobile_internet', 'insurance', 'subscription', 'loan_emi', 'education', 'household', 'other'];

async function customCategories(userId, q = db) {
  return q.all('SELECT id, kind, name FROM wealth_categories WHERE user_id = $1 AND NOT archived ORDER BY lower(name)', [userId]);
}

async function categoriesFor(userId, q = db) {
  const custom = await customCategories(userId, q);
  return {
    expense: [...EXPENSE_CATEGORIES, ...custom.filter((c) => c.kind === 'expense').map((c) => c.name)],
    income: [...INCOME_CATEGORIES, ...custom.filter((c) => c.kind === 'income').map((c) => c.name)],
    custom,
  };
}

// All ledger rows of a user between two dates (inclusive)
async function txsBetween(userId, from, to, q = db) {
  return q.all(`SELECT id, type, category, amount_paise, date, mode, transfer_kind FROM expenses
    WHERE user_id = $1 AND date >= $2 AND date <= $3`, [userId, from, to]);
}

async function monthTotals(userId, month, q = db) {
  const { from, to } = wc.monthRange(month);
  return wc.periodTotals(await txsBetween(userId, from, to, q));
}

// ---------------- bills ----------------
/**
 * Every occurrence of the user's bills with an effective date in [from, to],
 * plus overdue unpaid ones before `from` when includeOverdueSince is given.
 * Each: { bill, due_date, effective_date, status, row }
 */
async function billOccurrences(userId, from, to, today, { includeOverdueSince = null, billId = null } = {}, q = db) {
  const bills = await q.all(`SELECT * FROM bills WHERE user_id = $1 ${billId ? 'AND id = $2' : ''} ORDER BY id`, billId ? [userId, billId] : [userId]);
  if (!bills.length) return [];
  const lo = includeOverdueSince && includeOverdueSince < from ? includeOverdueSince : from;
  // Postponed rows may move a date into the window, so read a wider span of rows
  const rows = await q.all(`SELECT * FROM bill_occurrences WHERE user_id = $1 AND (due_date >= $2 OR postponed_to >= $2) ${billId ? 'AND bill_id = $3' : ''}`,
    billId ? [userId, wc.addDays(lo, -400), billId] : [userId, wc.addDays(lo, -400)]);
  const byKey = new Map(rows.map((r) => [`${r.bill_id}|${r.due_date}`, r]));
  const legacyPaid = await q.all(`SELECT p.bill_id, p.month FROM bill_payments p JOIN bills b ON b.id = p.bill_id WHERE b.user_id = $1`, [userId]);
  const paidAny = new Set(legacyPaid.map((p) => p.bill_id));
  const out = [];
  for (const b of bills) {
    // One-time bills from the old API: shown each month until paid once
    if (!b.recurring) {
      if (paidAny.has(b.id) || rows.some((r) => r.bill_id === b.id && r.status === 'paid')) continue;
    }
    const dates = wc.occurrences(b, lo, to);
    const mine = [];
    // Also include dates whose stored row was postponed into the window
    const extra = rows.filter((r) => r.bill_id === b.id && r.status === 'postponed' && r.postponed_to >= lo && r.postponed_to <= to && !dates.includes(r.due_date)).map((r) => r.due_date);
    for (const d of [...dates, ...extra]) {
      const row = byKey.get(`${b.id}|${d}`) || null;
      const status = wc.occurrenceStatus(d, row, today);
      const effective = row && row.status === 'postponed' && row.postponed_to ? row.postponed_to : d;
      // before `from` only keep what is still overdue
      if (effective < from && status !== 'overdue') continue;
      if (effective > to) continue;
      mine.push({ bill: b, due_date: d, effective_date: effective, status, row });
    }
    // a legacy one-time bill: only its first open month
    out.push(...(b.recurring ? mine : mine.slice(0, 1)));
  }
  return out.sort((a, b) => (a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : a.bill.id - b.bill.id));
}

function occurrenceView(o, today) {
  const expectedP = money.paiseOf(o.bill);
  return {
    bill_id: o.bill.id, name: o.bill.name, category: o.bill.category || null, bill_type: o.bill.bill_type || null,
    frequency: o.bill.frequency || 'monthly',
    due_date: o.due_date, effective_date: o.effective_date, status: o.status,
    expected: money.rupees(expectedP), expected_paise: expectedP,
    paid_amount: o.row && o.row.paid_amount != null ? o.row.paid_amount : null,
    paid_amount_paise: o.row && o.row.paid_amount_paise != null ? Number(o.row.paid_amount_paise) : null,
    paid_on: o.row ? o.row.paid_on : null,
    transaction_id: o.row ? o.row.transaction_id : null,
    // expected = the bill amount; recorded = paid_amount the user entered;
    // confirmed = linked to a transaction in the ledger
    payment_state: !o.row || o.row.status !== 'paid' ? 'expected' : o.row.transaction_id ? 'confirmed' : 'recorded',
    days_until: wc.diffDays(today, o.effective_date),
    reminder_on: o.bill.reminders_on !== false ? wc.reminderDate(o.effective_date, Number(o.bill.reminder_days), today) : null,
  };
}

// ---------------- goals ----------------
async function goalsWithProgress(userId, today, q = db, goalId = null) {
  const goals = await q.all(`SELECT * FROM savings_goals WHERE user_id = $1 ${goalId ? 'AND id = $2' : ''} ORDER BY id`, goalId ? [userId, goalId] : [userId]);
  if (!goals.length) return [];
  const entries = await q.all(`SELECT id, goal_id, kind, amount, amount_paise, date, note, transaction_id, created_at FROM goal_entries
    WHERE user_id = $1 ${goalId ? 'AND goal_id = $2' : ''} ORDER BY date, id`, goalId ? [userId, goalId] : [userId]);
  return goals.map((g) => {
    const mine = entries.filter((e) => e.goal_id === g.id);
    const targetP = money.paiseOf(g, 'target');
    const p = wc.goalProgress({ targetP, entries: mine, targetDate: g.deadline, today, status: g.status });
    return { goal: g, entries: mine, progress: p };
  });
}

function goalView({ goal: g, progress: p }) {
  const targetP = money.paiseOf(g, 'target');
  return {
    ...g,
    // `saved` always equals the sum of the history
    saved: money.rupees(p.saved_paise), saved_paise: p.saved_paise,
    target_paise: targetP,
    left: money.rupees(p.remaining_paise || 0), left_paise: p.remaining_paise || 0,
    progress_pct: p.progress_pct ?? 0,
    months_left: p.months_left,
    save_per_month: p.suggested_monthly_paise != null ? money.rupees(p.suggested_monthly_paise) : null,
    save_per_month_paise: p.suggested_monthly_paise,
    estimated_completion: p.estimated_completion,
    needs_review: p.needs_review,
    complete: p.complete,
  };
}

// Keep the legacy `saved` column equal to the history (old app versions read it)
async function syncGoalSaved(t, userId, goalId) {
  await t.run(`UPDATE savings_goals SET saved = COALESCE((SELECT SUM(CASE WHEN kind = 'withdrawal' THEN -amount_paise ELSE amount_paise END)
      FROM goal_entries WHERE goal_id = $1), 0)::float8 / 100, updated_at = now() WHERE id = $1 AND user_id = $2`, [goalId, userId]);
}

// ---------------- budgets ----------------
/**
 * Budgets of a month with their status. When record is true (current month
 * only) newly crossed alert levels are stored and returned once in new_alerts.
 */
async function budgetsForMonth(userId, month, today, { record = false } = {}, q = db) {
  const [rows, totals] = await Promise.all([
    q.all('SELECT * FROM budgets WHERE user_id = $1 AND month = $2 ORDER BY (category = $3) DESC, category', [userId, month, wc.OVERALL]),
    monthTotals(userId, month, q),
  ]);
  const newAlerts = [];
  let already = [];
  if (record && rows.length) already = await q.all('SELECT category, level FROM budget_alerts WHERE user_id = $1 AND month = $2', [userId, month]);
  const out = [];
  for (const b of rows) {
    const limitP = money.paiseOf(b);
    const spentP = wc.categorySpent(totals, b.category);
    const levels = wc.parseLevels(b.alert_levels);
    const s = wc.budgetStatus({ limitP, spentP, month, today, levels });
    if (record) {
      const fresh = wc.newCrossings(s.crossed, already.filter((a) => a.category === b.category).map((a) => a.level));
      for (const level of fresh) {
        const ins = await q.get(`INSERT INTO budget_alerts (user_id, month, category, level) VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING RETURNING level`, [userId, month, b.category, level]);
        if (ins) newAlerts.push({ category: b.category, level, pct_used: s.pct_used, over_by_paise: s.over_by_paise });
      }
    }
    out.push({
      ...b,
      alert_levels: levels,
      spent: money.rupees(spentP), spent_paise: spentP,
      left: money.rupees(limitP - spentP), left_paise: limitP - spentP,
      over_budget: spentP > limitP,
      remaining_paise: s.remaining_paise, over_by_paise: s.over_by_paise, pct_used: s.pct_used,
      days_remaining: s.days_remaining, per_day_left_paise: s.per_day_left_paise, state: s.state, crossed: s.crossed,
    });
  }
  // Only the highest new level per budget is worth a notification
  const top = {};
  for (const a of newAlerts) if (!top[a.category] || a.level > top[a.category].level) top[a.category] = a;
  return { budgets: out, totals, new_alerts: Object.values(top) };
}

module.exports = {
  EXPENSE_CATEGORIES, INCOME_CATEGORIES, MODES, NEW_MODES, TRANSFER_KINDS, GOAL_TYPES, GOAL_STATUSES, BILL_TYPES,
  customCategories, categoriesFor, txsBetween, monthTotals,
  billOccurrences, occurrenceView, goalsWithProgress, goalView, syncGoalSaved, budgetsForMonth,
};
