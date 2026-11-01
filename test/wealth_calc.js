// test/wealth_calc.js — pure tests for services/wealthCalc.js (no database).
// Run: node --test test/wealth_calc.js
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/services/wealthCalc');

const tx = (type, category, rupees, date = '2026-11-05', extra = {}) => ({ type, category, amount_paise: Math.round(rupees * 100), date, ...extra });

// ---------------- transactions / totals ----------------
test('income and expenses total separately; net = income − spending − invested', () => {
  const t = w.periodTotals([tx('income', 'Salary', 50000), tx('expense', 'Food', 1200.5), tx('expense', 'Groceries', 3000), tx('expense', 'Investment', 5000)]);
  assert.equal(t.income_paise, 5000000);
  assert.equal(t.spent_paise, 420050);
  assert.equal(t.invested_paise, 500000);
  assert.equal(t.net_paise, 5000000 - 420050 - 500000);
  assert.equal(t.expense_count, 3);
});

test('own-account transfers are neither income nor spending', () => {
  const t = w.periodTotals([tx('transfer', null, 10000, '2026-11-02', { transfer_kind: 'own_account' }), tx('expense', 'Food', 100)]);
  assert.equal(t.income_paise, 0);
  assert.equal(t.spent_paise, 10000);
  assert.equal(t.transfer_paise, 1000000);
});

test('credit-card purchase then card-bill payment counts the spend once', () => {
  const t = w.periodTotals([
    tx('expense', 'Shopping', 4999, '2026-11-03', { mode: 'Credit card' }),
    tx('transfer', null, 4999, '2026-11-20', { transfer_kind: 'card_bill' }),
  ]);
  assert.equal(t.spent_paise, 499900);
  assert.equal(t.net_paise, -499900);
});

test('refund reduces its category, never becomes income, never below zero', () => {
  const t = w.periodTotals([tx('expense', 'Shopping', 2000), tx('refund', 'Shopping', 500), tx('refund', 'Travel', 300)]);
  assert.equal(w.categorySpent(t, 'Shopping'), 150000);
  assert.equal(w.categorySpent(t, 'Travel'), 0);
  assert.equal(t.income_paise, 0);
  assert.equal(t.spent_paise, 150000);
});

test('bad rows (zero/negative/NaN amounts) are ignored, paise sums exact', () => {
  const rows = [tx('expense', 'Food', 0.1), tx('expense', 'Food', 0.2), { type: 'expense', category: 'Food', amount_paise: -5 }, { type: 'expense', category: 'Food', amount_paise: NaN }];
  assert.equal(w.periodTotals(rows).spent_paise, 30);
});

test('no records -> has_spending_data false (missing data is not zero spending)', () => {
  const t = w.periodTotals([]);
  assert.equal(t.has_spending_data, false);
  assert.equal(t.spent_paise, 0);
});

// ---------------- budgets ----------------
test('budget remaining, % used, days remaining (today counts)', () => {
  const s = w.budgetStatus({ limitP: 1000000, spentP: 450000, month: '2026-11', today: '2026-11-21' });
  assert.equal(s.remaining_paise, 550000);
  assert.equal(s.pct_used, 45);
  assert.equal(s.days_remaining, 10);
  assert.equal(s.per_day_left_paise, 55000);
  assert.deepEqual(s.crossed, []);
});

test('threshold crossings at 50/80/100 and exceeded', () => {
  const at = (spent) => w.budgetStatus({ limitP: 10000, spentP: spent, month: '2026-11', today: '2026-11-10' }).crossed;
  assert.deepEqual(at(4999), []);
  assert.deepEqual(at(5000), [50]);
  assert.deepEqual(at(8000), [50, 80]);
  assert.deepEqual(at(10000), [50, 80, 100]);
  assert.deepEqual(at(10001), [50, 80, 100, w.EXCEEDED]);
  const s = w.budgetStatus({ limitP: 10000, spentP: 12500, month: '2026-11', today: '2026-11-10' });
  assert.equal(s.over_by_paise, 2500);
  assert.equal(s.state, 'over');
});

test('alert levels configurable; disabled = none; no repeat for same crossing', () => {
  assert.deepEqual(w.parseLevels('80,100'), [80, 100]);
  assert.deepEqual(w.parseLevels(''), []);
  assert.deepEqual(w.parseLevels(null), [50, 80, 100]);
  const s = w.budgetStatus({ limitP: 10000, spentP: 9000, month: '2026-11', today: '2026-11-10', levels: [80] });
  assert.deepEqual(s.crossed, [80]);
  assert.deepEqual(w.newCrossings([50, 80], [50]), [80]);
  assert.deepEqual(w.newCrossings([50, 80], [50, 80]), []);
});

test('budget period boundaries: past month 0 days left, future month full', () => {
  assert.equal(w.budgetStatus({ limitP: 100, spentP: 0, month: '2026-10', today: '2026-11-01' }).days_remaining, 0);
  assert.equal(w.budgetStatus({ limitP: 100, spentP: 0, month: '2026-12', today: '2026-11-01' }).days_remaining, 31);
  assert.equal(w.budgetStatus({ limitP: 100, spentP: 0, month: '2026-02', today: '2026-02-28' }).days_remaining, 1);
});

test('overall budget uses total spending (not income, not transfers, not investment)', () => {
  const t = w.periodTotals([tx('expense', 'Food', 100), tx('expense', 'Rent', 900), tx('income', 'Salary', 5000), tx('transfer', null, 700), tx('expense', 'Investment', 400)]);
  assert.equal(w.categorySpent(t, w.OVERALL), 100000);
});

test('month over month needs 3+ records in both months', () => {
  const cur = w.periodTotals([tx('expense', 'Food', 300), tx('expense', 'Food', 300), tx('expense', 'Travel', 400)]);
  const prev = w.periodTotals([tx('expense', 'Food', 200), tx('expense', 'Food', 200), tx('expense', 'Rent', 100)]);
  const m = w.monthOverMonth(cur, prev);
  assert.equal(m.enough_data, true);
  assert.equal(m.change_paise, 50000);
  assert.equal(m.change_pct, 100);
  assert.equal(m.by_category.find((r) => r.category === 'Food').change_paise, 20000);
  const thin = w.monthOverMonth(cur, w.periodTotals([tx('expense', 'Food', 10)]));
  assert.equal(thin.enough_data, false);
  assert.deepEqual(thin.by_category, []);
});

// ---------------- savings ----------------
test('goal progress = sum of contributions − withdrawals; suggested monthly', () => {
  const entries = [
    { kind: 'opening', amount_paise: 1000000, date: '2026-10-01' },
    { kind: 'contribution', amount_paise: 500000, date: '2026-11-01' },
    { kind: 'withdrawal', amount_paise: 200000, date: '2026-11-02' },
  ];
  const g = w.goalProgress({ targetP: 10000000, entries, targetDate: '2027-05-02', today: '2026-11-02' });
  assert.equal(g.saved_paise, 1300000);
  assert.equal(g.remaining_paise, 8700000);
  assert.equal(g.progress_pct, 13);
  assert.equal(g.months_left, 6);
  assert.equal(g.suggested_monthly_paise, 1450000);
});

test('months remaining counts the target month only when its day has not passed', () => {
  assert.equal(w.monthsRemaining('2026-11-02', '2027-05-02'), 6);
  assert.equal(w.monthsRemaining('2026-11-02', '2027-05-01'), 5);
  assert.equal(w.monthsRemaining('2026-11-02', '2026-11-30'), 1);
  assert.equal(w.monthsRemaining('2026-11-02', '2026-11-02'), null);
  assert.equal(w.monthsRemaining('2026-11-02', '2026-01-01'), null);
});

test('missing / passed / invalid target dates and targets', () => {
  const none = w.goalProgress({ targetP: 100000, entries: [], targetDate: null, today: '2026-11-02' });
  assert.equal(none.suggested_monthly_paise, null);
  assert.equal(none.needs_review, null);
  const passed = w.goalProgress({ targetP: 100000, entries: [], targetDate: '2026-10-01', today: '2026-11-02' });
  assert.equal(passed.needs_review, 'target_date_passed');
  assert.equal(passed.suggested_monthly_paise, null);
  const bad = w.goalProgress({ targetP: 0, entries: [], targetDate: null, today: '2026-11-02' });
  assert.equal(bad.needs_review, 'invalid_target');
  assert.equal(bad.progress_pct, null);
  const done = w.goalProgress({ targetP: 100000, entries: [{ kind: 'contribution', amount_paise: 150000, date: '2026-11-01' }], targetDate: '2026-10-01', today: '2026-11-02' });
  assert.equal(done.complete, true);
  assert.equal(done.progress_pct, 100);
  assert.equal(done.needs_review, null);
});

test('estimated completion only with 2+ contributions over 30+ days', () => {
  const one = w.goalProgress({ targetP: 1000000, entries: [{ kind: 'contribution', amount_paise: 100000, date: '2026-09-01' }], today: '2026-11-02' });
  assert.equal(one.estimated_completion, null);
  const e = [{ kind: 'contribution', amount_paise: 100000, date: '2026-09-03' }, { kind: 'contribution', amount_paise: 100000, date: '2026-10-03' }];
  const g = w.goalProgress({ targetP: 1000000, entries: e, today: '2026-11-02' });
  // 2000 saved over 60 days -> 3333.33 paise/day; 800000 left -> 240 days
  assert.equal(g.estimated_completion, w.addDays('2026-11-02', 240));
});

test('emergency fund target = essentials × months; validation', () => {
  const e = w.emergencyFund({ essentialP: 2500000, months: 6, currentP: 4000000, targetDate: '2027-11-02', today: '2026-11-02' });
  assert.equal(e.target_paise, 15000000);
  assert.equal(e.gap_paise, 11000000);
  assert.equal(e.covered_months, 1.6);
  assert.equal(e.months_left, 12);
  assert.equal(e.suggested_monthly_paise, Math.ceil(11000000 / 12));
  assert.equal(w.emergencyFund({ essentialP: 0, months: 6, today: '2026-11-02' }).ok, false);
  assert.equal(w.emergencyFund({ essentialP: 100, months: 0, today: '2026-11-02' }).ok, false);
  assert.equal(w.emergencyFund({ essentialP: 100, months: 3, currentP: -1, today: '2026-11-02' }).ok, false);
});

// ---------------- bills ----------------
test('monthly bill on the 31st clamps to month end, incl. leap February', () => {
  const b = { frequency: 'monthly', due_day: 31, start_date: '2027-12-31' };
  assert.deepEqual(w.occurrences(b, '2028-01-01', '2028-04-30'), ['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30']);
  assert.deepEqual(w.occurrences({ frequency: 'monthly', due_day: 30 }, '2027-02-01', '2027-03-31'), ['2027-02-28', '2027-03-30']);
});

test('quarterly from 31 Jan uses the anchor day each time (not drifting)', () => {
  const b = { frequency: 'quarterly', start_date: '2026-01-31' };
  assert.deepEqual(w.occurrences(b, '2026-01-01', '2026-12-31'), ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
});

test('yearly on 29 Feb: 28 Feb in normal years, 29 Feb in leap years', () => {
  const b = { frequency: 'yearly', start_date: '2024-02-29' };
  assert.deepEqual(w.occurrences(b, '2024-01-01', '2028-12-31'), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
});

test('weekly every 7 days from start; end date and cancel-from respected', () => {
  const b = { frequency: 'weekly', start_date: '2026-11-02', end_date: '2026-11-30' };
  assert.deepEqual(w.occurrences(b, '2026-11-01', '2026-12-31'), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  assert.deepEqual(w.occurrences({ ...b, cancelled_from: '2026-11-16' }, '2026-11-01', '2026-12-31'), ['2026-11-02', '2026-11-09']);
});

test('occurrences are unique and identical on repeated calls (deterministic)', () => {
  const b = { frequency: 'monthly', due_day: 5, start_date: '2026-01-05' };
  const a1 = w.occurrences(b, '2026-01-01', '2026-12-31');
  const a2 = w.occurrences(b, '2026-01-01', '2026-12-31');
  assert.deepEqual(a1, a2);
  assert.equal(new Set(a1).size, 12);
  // overlapping windows give the same dates
  const a3 = [...w.occurrences(b, '2026-01-01', '2026-06-30'), ...w.occurrences(b, '2026-07-01', '2026-12-31')];
  assert.deepEqual(a3, a1);
});

test('no occurrence before start date; legacy bill without start date', () => {
  assert.deepEqual(w.occurrences({ frequency: 'monthly', due_day: 10, start_date: '2026-11-15' }, '2026-11-01', '2026-12-31'), ['2026-12-10']);
  assert.deepEqual(w.occurrences({ due_day: 10 }, '2026-11-01', '2026-11-30'), ['2026-11-10']);
});

test('overdue / due today / upcoming / paid / postponed status and next due', () => {
  assert.equal(w.occurrenceStatus('2026-11-01', null, '2026-11-02'), 'overdue');
  assert.equal(w.occurrenceStatus('2026-11-02', null, '2026-11-02'), 'due_today');
  assert.equal(w.occurrenceStatus('2026-11-05', null, '2026-11-02'), 'upcoming');
  assert.equal(w.occurrenceStatus('2026-11-01', { status: 'paid' }, '2026-11-02'), 'paid');
  assert.equal(w.occurrenceStatus('2026-11-01', { status: 'postponed', postponed_to: '2026-11-10' }, '2026-11-02'), 'upcoming');
  assert.equal(w.nextDue({ frequency: 'monthly', due_day: 1 }, '2026-11-02'), '2026-12-01');
  assert.equal(w.nextDue({ frequency: 'monthly', due_day: 1, end_date: '2026-11-30' }, '2026-11-02'), null);
});

test('reminder lead time; past reminders skipped', () => {
  assert.equal(w.reminderDate('2026-11-10', 3, '2026-11-02'), '2026-11-07');
  assert.equal(w.reminderDate('2026-11-03', 3, '2026-11-02'), null);
  assert.equal(w.reminderDate('2026-11-10', 99, '2026-11-02'), '2026-11-09'); // invalid -> 1 day
});

test('payment match candidates: ±7 days, ±10% amount, expense only, not already linked', () => {
  const txs = [
    { id: 1, type: 'expense', amount_paise: 99900, date: '2026-11-04' },
    { id: 2, type: 'expense', amount_paise: 120000, date: '2026-11-05' },
    { id: 3, type: 'transfer', amount_paise: 99900, date: '2026-11-05' },
    { id: 4, type: 'expense', amount_paise: 100000, date: '2026-11-20' },
    { id: 5, type: 'expense', amount_paise: 100000, date: '2026-11-06' },
    { id: 6, type: 'expense', amount_paise: 100000, date: '2026-11-05' },
  ];
  assert.deepEqual(w.matchCandidates(100000, '2026-11-05', txs, [6]).map((t) => t.id), [5, 1]); // same distance -> closer amount first
});
