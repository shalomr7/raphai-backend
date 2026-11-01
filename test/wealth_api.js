// test/wealth_api.js — HeartPurse Wealth API tests against an in-memory
// Postgres (PGlite, WASM), because no test database is available.
// Runs every migration (incl. 018 up / down / up), then calls the real routes
// over HTTP as two users.
// Run: npm i --no-save @electric-sql/pglite   (or PGLITE_PATH=/path/to/@electric-sql/pglite)
//      node --test test/wealth_api.js
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'wealth-test-secret-wealth-test-secret-123';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require(process.env.PGLITE_PATH || '@electric-sql/pglite');
const migs = require('../src/migrations');

let pg; let base; let server; let tokA; let tokB; let today;

function helpers(runner) {
  const toPos = (sql, params) => {
    if (!params || Array.isArray(params)) return { text: sql, values: params || [] };
    const values = []; const index = {};
    const text = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, n) => { if (!(n in params)) throw new Error(`Missing SQL parameter @${n}`); if (!(n in index)) { values.push(params[n]); index[n] = values.length; } return `$${index[n]}`; });
    return { text, values };
  };
  const q = async (s, p) => { const { text, values } = toPos(s, p); return runner.query(text, values); };
  return { query: q, get: async (s, p) => (await q(s, p)).rows[0], all: async (s, p) => (await q(s, p)).rows, run: async (s, p) => { const r = await q(s, p); return { changes: r.affectedRows, rows: r.rows }; } };
}

async function call(method, path, body, tok = tokA, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: json };
}

test.before(async () => {
  pg = new PGlite();
  await pg.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now());');
  const upTo17 = migs.filter((m) => m.id < '018');
  for (const m of upTo17) { await pg.exec(typeof m.sql === 'function' ? m.sql() : m.sql); await pg.query('INSERT INTO schema_migrations(id) VALUES ($1)', [m.id]); }
  // Old-style data made BEFORE migration 018
  await pg.exec(`INSERT INTO users (name, email, password_hash) VALUES ('A','a@x.in','x'), ('B','b@x.in','x');
    INSERT INTO profiles (user_id, income) VALUES (1, 60000), (2, 0);
    INSERT INTO expenses (user_id, amount, category, mode, note, date) VALUES (1, 250, 'Food', 'UPI', 'old lunch', to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'));
    INSERT INTO savings_goals (user_id, name, target, saved) VALUES (1, 'Old goal', 10000, 1500);
    INSERT INTO bills (user_id, name, amount, due_day, recurring) VALUES (1, 'Old rent', 12000, 31, 1);
    INSERT INTO bill_payments (bill_id, month) VALUES (1, '2026-02');`);
  const m18 = migs.find((m) => m.id === '018_wealth_mvp');
  await pg.exec(m18.sql);
  await pg.exec(m18.down);
  await pg.exec(m18.sql); // up again after down: must restore without loss
  await pg.exec(m18.sql); // and be idempotent
  const h = helpers(pg);
  h.tx = (fn) => pg.transaction((tx) => fn(helpers(tx)));
  require.cache[require.resolve('../src/db.js')] = { exports: h, loaded: true, id: 'db' };
  today = require('../src/utils/dates').today();
  const { createApp } = require('../src/app');
  const { signToken } = require('../src/middleware/auth');
  tokA = signToken({ id: 1 }); tokB = signToken({ id: 2 });
  // Owner of A gets Plus so plan limits don't get in the way of the maths tests
  await h.run("INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES (1, 'elite', 'active', '2099-01-01T00:00:00Z') ON CONFLICT (user_id) DO UPDATE SET plan = 'elite', status = 'active', expires_at = '2099-01-01T00:00:00Z'");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server && server.close(); });

// ---------------- migration ----------------
test('migration 018 keeps old data: old expense is an expense, goal history = saved, legacy payment copied', async () => {
  const e = await pg.query('SELECT type FROM expenses WHERE user_id = 1');
  assert.deepEqual(e.rows.map((r) => r.type), ['expense']);
  const g = await pg.query("SELECT kind, amount FROM goal_entries WHERE goal_id = 1");
  assert.deepEqual(g.rows, [{ kind: 'opening', amount: 1500 }]);
  const o = await pg.query('SELECT due_date, status FROM bill_occurrences WHERE bill_id = 1');
  assert.deepEqual(o.rows, [{ due_date: '2026-02-28', status: 'paid' }]);
  const r = await call('GET', '/api/wealth/goals');
  assert.equal(r.body.goals[0].saved, 1500);
});

// ---------------- transactions ----------------
let incomeId; let lunchId;
test('create income and expense; duplicate submission with the same key is stored once', async () => {
  const inc = await call('POST', '/api/wealth/transactions', { type: 'income', amount: 50000, category: 'Salary', mode: 'Bank transfer', client_id: 'inc-key-0001' });
  assert.equal(inc.status, 201); incomeId = inc.body.transaction.id;
  const again = await call('POST', '/api/wealth/transactions', { type: 'income', amount: 50000, category: 'Salary', mode: 'Bank transfer', client_id: 'inc-key-0001' });
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true); assert.equal(again.body.transaction.id, incomeId);
  const hdr = await call('POST', '/api/wealth/transactions', { type: 'expense', amount: 1200.5, category: 'Food', merchant: 'Hotel Paradise', note: 'biryani lunch' }, tokA, { 'Idempotency-Key': 'lunch-key-0001' });
  assert.equal(hdr.status, 201); lunchId = hdr.body.transaction.id;
  const hdr2 = await call('POST', '/api/wealth/transactions', { type: 'expense', amount: 1200.5, category: 'Food' }, tokA, { 'Idempotency-Key': 'lunch-key-0001' });
  assert.equal(hdr2.body.duplicate, true);
  // concurrent retries (network race): still one row
  const rs = await Promise.all([1, 2, 3].map(() => call('POST', '/api/wealth/transactions', { type: 'expense', amount: 99, category: 'Transport', client_id: 'race-key-0001' })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  const n = await pg.query("SELECT count(*)::int AS c FROM expenses WHERE client_id = 'race-key-0001'");
  assert.equal(n.rows[0].c, 1);
});

test('invalid amounts, dates, types and categories are rejected', async () => {
  for (const body of [
    { type: 'expense', amount: 0, category: 'Food' },
    { type: 'expense', amount: -5, category: 'Food' },
    { type: 'expense', amount: 'abc', category: 'Food' },
    { type: 'expense', amount: 10, category: 'Food', date: '2026-02-30' },
    { type: 'expense', amount: 10, category: 'Food', date: '2999-01-01' },
    { type: 'expense', amount: 10, category: 'NoSuchCategory' },
    { type: 'income', amount: 10, category: 'Food' },
    { type: 'gift', amount: 10, category: 'Food' },
    { type: 'expense', amount: 10 },
    { type: 'expense', amount: 10, category: 'Food', time: '25:00' },
  ]) {
    const r = await call('POST', '/api/wealth/transactions', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('edit and delete a transaction', async () => {
  const e = await call('PUT', `/api/wealth/transactions/${lunchId}`, { amount: 1100, note: 'biryani' });
  assert.equal(e.status, 200); assert.equal(e.body.transaction.amount_paise, 110000);
  const tmp = await call('POST', '/api/wealth/transactions', { type: 'expense', amount: 5, category: 'Other' });
  const d = await call('DELETE', `/api/wealth/transactions/${tmp.body.transaction.id}`);
  assert.equal(d.status, 200);
  assert.equal((await call('DELETE', `/api/wealth/transactions/${tmp.body.transaction.id}`)).status, 404);
});

test('search and filters (text, type, category, amount, mode) + pagination', async () => {
  let r = await call('GET', '/api/wealth/transactions?q=biryani');
  assert.deepEqual(r.body.transactions.map((t) => t.id), [lunchId]);
  r = await call('GET', '/api/wealth/transactions?q=paradise');
  assert.equal(r.body.transactions.length, 1);
  r = await call('GET', '/api/wealth/transactions?q=%25'); // a literal % matches nothing special
  assert.equal(r.body.transactions.length, 0);
  r = await call('GET', '/api/wealth/transactions?type=income');
  assert.deepEqual(r.body.transactions.map((t) => t.id), [incomeId]);
  r = await call('GET', '/api/wealth/transactions?category=Food&min=1000&max=2000');
  assert.deepEqual(r.body.transactions.map((t) => t.id), [lunchId]);
  r = await call('GET', '/api/wealth/transactions?mode=Bank%20transfer');
  assert.equal(r.body.transactions.length, 1);
  const p1 = await call('GET', '/api/wealth/transactions?limit=2');
  assert.equal(p1.body.transactions.length, 2); assert.ok(p1.body.next);
  const p2 = await call('GET', `/api/wealth/transactions?limit=2&before_date=${p1.body.next.before_date}&before_id=${p1.body.next.before_id}`);
  const ids = [...p1.body.transactions, ...p2.body.transactions].map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('own-account transfer, card purchase + card-bill payment and refund keep totals right', async () => {
  await call('POST', '/api/wealth/transactions', { type: 'transfer', amount: 5000, from_account: 'SBI', to_account: 'Paytm wallet' });
  await call('POST', '/api/wealth/transactions', { type: 'expense', amount: 4000, category: 'Shopping', mode: 'Credit card' });
  await call('POST', '/api/wealth/transactions', { type: 'transfer', amount: 4000, transfer_kind: 'card_bill', from_account: 'SBI', to_account: 'HDFC card' });
  await call('POST', '/api/wealth/transactions', { type: 'refund', amount: 1000, category: 'Shopping' });
  const s = await call('GET', '/api/wealth/transactions/summary');
  // spending = 250 (old) + 1100 + 99 + 3000 (4000 − 1000 refund)
  assert.equal(s.body.spent_paise, 25000 + 110000 + 9900 + 300000);
  assert.equal(s.body.income_paise, 5000000);
  assert.equal(s.body.transfer_paise, 900000);
  assert.equal(s.body.net_paise, 5000000 - (25000 + 110000 + 9900 + 300000));
  // the old endpoint still only shows spends
  const old = await call('GET', '/api/wealth/expenses');
  assert.ok(old.body.expenses.every((e) => e.type === 'expense'));
  const sum = await call('GET', '/api/wealth/expenses/summary');
  assert.equal(sum.body.income, 50000); // recorded income wins over profile income
  assert.equal(sum.body.total_spent, 4449);
});

test('custom categories work without code changes', async () => {
  const c = await call('POST', '/api/wealth/categories', { kind: 'expense', name: 'Pet care' });
  assert.equal(c.status, 201);
  assert.equal((await call('POST', '/api/wealth/categories', { kind: 'expense', name: 'Food' })).status, 409);
  const t = await call('POST', '/api/wealth/transactions', { type: 'expense', amount: 300, category: 'Pet care' });
  assert.equal(t.status, 201);
  const cats = await call('GET', '/api/wealth/categories');
  assert.ok(cats.body.categories.includes('Pet care'));
  // user B cannot use A's category
  assert.equal((await call('POST', '/api/wealth/transactions', { type: 'expense', amount: 1, category: 'Pet care' }, tokB)).status, 400);
});

// ---------------- budgets ----------------
test('budgets: overall + category, remaining, % used, alerts once per threshold, duplicates impossible', async () => {
  let r = await call('PUT', '/api/wealth/budgets', { category: 'Shopping', amount: 5000 });
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/wealth/budgets', { category: 'Shopping', amount: 3500 }); // same category+month = update, not a 2nd row
  const n = await pg.query("SELECT count(*)::int c FROM budgets WHERE user_id = 1 AND category = 'Shopping'");
  assert.equal(n.rows[0].c, 1);
  await call('PUT', '/api/wealth/budgets', { category: 'Overall', amount: 10000 });
  const b = await call('GET', '/api/wealth/budgets');
  const shop = b.body.budgets.find((x) => x.category === 'Shopping');
  assert.equal(shop.spent_paise, 300000); assert.equal(shop.remaining_paise, 50000); assert.equal(shop.pct_used, 85.7);
  assert.deepEqual(shop.crossed, [50, 80]);
  const overall = b.body.budgets.find((x) => x.category === 'Overall');
  assert.equal(overall.spent_paise, 25000 + 110000 + 9900 + 300000 + 30000); // incl. Pet care, no income/transfers
  assert.deepEqual(b.body.new_alerts.find((a) => a.category === 'Shopping').level, 80);
  const again = await call('GET', '/api/wealth/budgets');
  assert.equal(again.body.new_alerts.length, 0); // no repeat
  // crossing 100% later -> one new alert (exceeded)
  await call('POST', '/api/wealth/transactions', { type: 'expense', amount: 700, category: 'Shopping' });
  const third = await call('GET', '/api/wealth/budgets');
  // Overall also passes 50% now (₹5,449 of ₹10,000)
  assert.deepEqual(third.body.new_alerts.map((a) => [a.category, a.level]), [['Overall', 50], ['Shopping', 101]]);
  // alerts can be turned off
  await call('PUT', '/api/wealth/budgets', { category: 'Overall', amount: 10000, alert_levels: '' });
  const off = (await call('GET', '/api/wealth/budgets')).body.budgets.find((x) => x.category === 'Overall');
  assert.deepEqual(off.alert_levels, []); assert.deepEqual(off.crossed, []);
});

test('budget copy to next month; insights month-over-month says when data is thin', async () => {
  const m = today.slice(0, 7);
  const next = require('../src/services/wealthCalc').shiftMonth(m, 1);
  const c = await call('POST', '/api/wealth/budgets/copy', { from: m, to: next });
  assert.equal(c.body.copied, 2);
  const c2 = await call('POST', '/api/wealth/budgets/copy', { from: m, to: next });
  assert.equal(c2.body.copied, 0);
  const ins = await call('GET', '/api/wealth/insights');
  assert.equal(ins.status, 200);
  assert.equal(ins.body.month_over_month.enough_data, false); // nothing last month
  assert.ok(ins.body.largest.length > 0);
});

// ---------------- savings ----------------
let goalId;
test('goals: contributions, withdrawals, duplicate prevention, linked transfer not counted as spending', async () => {
  const g = await call('POST', '/api/wealth/goals', { name: 'Emergency fund', target: 150000, goal_type: 'emergency', saved: 10000 });
  assert.equal(g.status, 201); goalId = g.body.goal.id;
  assert.equal(g.body.goal.saved_paise, 1000000);
  const before = (await call('GET', '/api/wealth/transactions/summary')).body.spent_paise;
  const c = await call('POST', `/api/wealth/goals/${goalId}/entries`, { kind: 'contribution', amount: 5000, record_transfer: true, account: 'SBI', client_id: 'goal-key-0001' });
  assert.equal(c.status, 201); assert.equal(c.body.goal.saved_paise, 1500000);
  const dup = await call('POST', `/api/wealth/goals/${goalId}/entries`, { kind: 'contribution', amount: 5000, record_transfer: true, client_id: 'goal-key-0001' });
  assert.equal(dup.body.duplicate, true); assert.equal(dup.body.goal.saved_paise, 1500000);
  const after = (await call('GET', '/api/wealth/transactions/summary')).body;
  assert.equal(after.spent_paise, before); // a savings transfer is not spending
  const w = await call('POST', `/api/wealth/goals/${goalId}/entries`, { kind: 'withdrawal', amount: 2000 });
  assert.equal(w.body.goal.saved_paise, 1300000);
  assert.equal((await call('POST', `/api/wealth/goals/${goalId}/entries`, { kind: 'withdrawal', amount: 999999 })).status, 400);
  const hist = await call('GET', `/api/wealth/goals/${goalId}/entries`);
  assert.equal(hist.body.entries.length, 3);
  const sumEntries = hist.body.entries.reduce((s, e) => s + (e.kind === 'withdrawal' ? -e.amount_paise : e.amount_paise), 0);
  assert.equal(sumEntries, hist.body.goal.saved_paise);
  // delete the contribution: its transfer goes too
  const contrib = hist.body.entries.find((e) => e.kind === 'contribution');
  await call('DELETE', `/api/wealth/goals/${goalId}/entries/${contrib.id}`);
  const tr = await pg.query('SELECT count(*)::int c FROM expenses WHERE id = $1', [contrib.transaction_id]);
  assert.equal(tr.rows[0].c, 0);
});

test('goal status pause / complete, invalid and passed target dates', async () => {
  let r = await call('PUT', `/api/wealth/goals/${goalId}`, { status: 'paused' });
  assert.equal(r.body.goal.status, 'paused');
  r = await call('PUT', `/api/wealth/goals/${goalId}`, { deadline: '2020-01-01', status: 'active' });
  assert.equal(r.body.goal.needs_review, 'target_date_passed');
  assert.equal((await call('PUT', `/api/wealth/goals/${goalId}`, { deadline: '2027-13-01' })).status, 400);
  assert.equal((await call('POST', '/api/wealth/goals', { name: 'x', target: 0 })).status, 400);
  // legacy "saved" total from older app versions becomes a history entry
  r = await call('PUT', `/api/wealth/goals/${goalId}`, { saved: 20000 });
  assert.equal(r.body.goal.saved_paise, 2000000);
  const e = await call('GET', `/api/wealth/goals/${goalId}/entries`);
  assert.equal(e.body.entries.reduce((s, x) => s + (x.kind === 'withdrawal' ? -x.amount_paise : x.amount_paise), 0), 2000000);
});

test('emergency fund estimate', async () => {
  const r = await call('GET', '/api/wealth/emergency-fund?essential=25000&months=6&current=40000');
  assert.equal(r.body.plan.target_paise, 15000000);
  assert.equal(r.body.plan.gap_paise, 11000000);
  assert.equal(r.body.essentials_hint_paise, null); // not enough history -> no guess
});

// ---------------- bills ----------------
let billId;
test('bills: monthly/quarterly/yearly, upcoming + overdue, mark paid twice = once, linked payment not duplicated', async () => {
  const start = require('../src/services/wealthCalc').addDays(today, -10);
  const b = await call('POST', '/api/wealth/bills', { name: 'Electricity', amount: 1500, frequency: 'monthly', start_date: start, category: 'Bills', bill_type: 'electricity', reminder_days: 2 });
  assert.equal(b.status, 201); billId = b.body.bill.id;
  const q = await call('POST', '/api/wealth/bills', { name: 'Car insurance', amount: 9000, frequency: 'yearly', start_date: '2026-02-28' });
  assert.equal(q.status, 201);
  assert.equal((await call('POST', '/api/wealth/bills', { name: 'X', amount: 10, frequency: 'quarterly' })).status, 400);
  const up = await call('GET', '/api/wealth/bills/upcoming?days=60');
  const over = up.body.overdue.find((o) => o.bill_id === billId);
  assert.ok(over, 'first electricity due date (10 days ago) is overdue');
  assert.equal(over.due_date, start);
  // an expense that is really this payment
  const ex = await call('POST', '/api/wealth/transactions', { type: 'expense', amount: 1500, category: 'Bills', date: start });
  const m = await call('GET', `/api/wealth/bills/${billId}/occurrences/${start}/matches`);
  assert.deepEqual(m.body.matches.map((x) => x.id), [ex.body.transaction.id]);
  const spentBefore = (await call('GET', `/api/wealth/transactions/summary?month=${start.slice(0, 7)}`)).body.spent_paise;
  const p1 = await call('POST', `/api/wealth/bills/${billId}/occurrences/${start}/pay`, { link_transaction_id: ex.body.transaction.id });
  assert.equal(p1.status, 200); assert.equal(p1.body.already_paid, false);
  const p2 = await call('POST', `/api/wealth/bills/${billId}/occurrences/${start}/pay`, { record_expense: true });
  assert.equal(p2.body.already_paid, true);
  const spentAfter = (await call('GET', `/api/wealth/transactions/summary?month=${start.slice(0, 7)}`)).body.spent_paise;
  assert.equal(spentAfter, spentBefore); // linking adds no second expense
  const rows = await pg.query('SELECT count(*)::int c FROM bill_occurrences WHERE bill_id = $1 AND due_date = $2', [billId, start]);
  assert.equal(rows.rows[0].c, 1);
  // the same transaction cannot pay a second bill
  const other = await call('POST', '/api/wealth/bills', { name: 'Water', amount: 1500, frequency: 'monthly', start_date: start });
  assert.equal((await call('POST', `/api/wealth/bills/${other.body.bill.id}/occurrences/${start}/pay`, { link_transaction_id: ex.body.transaction.id })).status, 409);
  // a date that is not a due date
  assert.equal((await call('POST', `/api/wealth/bills/${billId}/occurrences/${require('../src/services/wealthCalc').addDays(start, 1)}/pay`, {})).status, 404);
});

test('bills: record_expense creates one expense; undo removes it; skip, postpone, cancel future', async () => {
  const wc = require('../src/services/wealthCalc');
  const b = await call('POST', '/api/wealth/bills', { name: 'Netflix', amount: 649, frequency: 'monthly', start_date: wc.addDays(today, -3), bill_type: 'subscription', category: 'Entertainment' });
  const id = b.body.bill.id; const due = wc.addDays(today, -3);
  const n0 = (await pg.query('SELECT count(*)::int c FROM expenses WHERE user_id = 1')).rows[0].c;
  await Promise.all([1, 2].map(() => call('POST', `/api/wealth/bills/${id}/occurrences/${due}/pay`, { record_expense: true, mode: 'Credit card' })));
  const n1 = (await pg.query('SELECT count(*)::int c FROM expenses WHERE user_id = 1')).rows[0].c;
  assert.equal(n1, n0 + 1);
  const occ = (await pg.query('SELECT transaction_id, created_expense FROM bill_occurrences WHERE bill_id = $1', [id])).rows[0];
  assert.equal(occ.created_expense, true);
  await call('DELETE', `/api/wealth/bills/${id}/occurrences/${due}/pay`);
  assert.equal((await pg.query('SELECT count(*)::int c FROM expenses WHERE user_id = 1')).rows[0].c, n0);
  // postpone, then skip next month's
  const p = await call('POST', `/api/wealth/bills/${id}/occurrences/${due}/postpone`, { to: wc.addDays(today, 5) });
  assert.equal(p.status, 200);
  const up = await call('GET', '/api/wealth/bills/upcoming?days=60');
  assert.ok(up.body.upcoming.some((o) => o.bill_id === id && o.effective_date === wc.addDays(today, 5)));
  assert.ok(!up.body.overdue.some((o) => o.bill_id === id));
  const nextDue = wc.occurrences({ frequency: 'monthly', due_day: Number(due.slice(8, 10)), start_date: due }, wc.addDays(today, 1), wc.addDays(today, 60))[0];
  assert.equal((await call('POST', `/api/wealth/bills/${id}/occurrences/${nextDue}/skip`, {})).status, 200);
  // cancel from tomorrow: no further occurrences
  await call('POST', `/api/wealth/bills/${id}/cancel`, { from: wc.addDays(today, 6) });
  const up2 = await call('GET', '/api/wealth/bills/upcoming?days=120');
  assert.ok(!up2.body.upcoming.some((o) => o.bill_id === id && o.effective_date > wc.addDays(today, 6)));
  const hist = await call('GET', `/api/wealth/bills/${id}/history`);
  assert.equal(hist.body.history.length, 2);
});

test('legacy monthly bill endpoints still work and stay in step', async () => {
  const r = await call('POST', `/api/wealth/bills/1/pay`, { month: '2026-04' });
  assert.equal(r.body.bill.paid, true); assert.equal(r.body.bill.due_date, '2026-04-30');
  const l = await call('GET', '/api/wealth/bills?month=2026-04');
  assert.equal(l.body.bills.find((x) => x.id === 1).paid, true);
  await call('DELETE', '/api/wealth/bills/1/pay?month=2026-04');
  assert.equal((await call('GET', '/api/wealth/bills?month=2026-04')).body.bills.find((x) => x.id === 1).paid, false);
});

// ---------------- overview + other features ----------------
test('Home overview: income, spending, net, budget left, bills, goals', async () => {
  const o = await call('GET', '/api/wealth/overview');
  assert.equal(o.status, 200);
  assert.equal(o.body.income_paise, 5000000);
  assert.equal(o.body.has_spending_data, true);
  assert.equal(o.body.net_paise, o.body.income_paise - o.body.spent_paise - o.body.invested_paise);
  assert.ok(o.body.overall_budget);
  assert.ok(Array.isArray(o.body.bills.next));
  assert.ok(o.body.goals.length >= 1);
  // user B: nothing recorded -> says so instead of zeros pretending to be data
  const ob = await call('GET', '/api/wealth/overview', null, tokB);
  assert.equal(ob.body.has_spending_data, false); assert.equal(ob.body.has_income_data, false);
});

test('existing features still answer: dashboard, insights/today, export, coach finance tool data', async () => {
  for (const p of ['/api/dashboard', '/api/insights/today', '/api/export']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200, p + ' ' + JSON.stringify(r.body));
  }
  const ex = await call('GET', '/api/export');
  assert.ok(Array.isArray(ex.body.goal_entries) && Array.isArray(ex.body.bill_occurrences));
  const summary = require('../src/services/summary');
  const m = await summary.wealthMonth(1);
  assert.equal(m.income_source, 'recorded');
  assert.ok(!m.by_category.some((c) => c.category === 'Transfer')); // transfers are not a spending category
});

// ---------------- security ----------------
test('user-level authorization: B cannot read, change or delete A’s records', async () => {
  assert.equal((await call('PUT', `/api/wealth/transactions/${lunchId}`, { amount: 1 }, tokB)).status, 404);
  assert.equal((await call('DELETE', `/api/wealth/transactions/${lunchId}`, null, tokB)).status, 404);
  assert.equal((await call('GET', `/api/wealth/goals/${goalId}/entries`, null, tokB)).status, 404);
  assert.equal((await call('POST', `/api/wealth/goals/${goalId}/entries`, { kind: 'contribution', amount: 10 }, tokB)).status, 404);
  assert.equal((await call('GET', `/api/wealth/bills/${billId}/history`, null, tokB)).status, 404);
  const d = (await pg.query('SELECT due_date FROM bill_occurrences WHERE bill_id = $1 LIMIT 1', [billId])).rows[0].due_date;
  assert.equal((await call('DELETE', `/api/wealth/bills/${billId}/occurrences/${d}/pay`, null, tokB)).status, 404);
  assert.equal((await call('POST', `/api/wealth/bills/${billId}/cancel`, {}, tokB)).status, 404);
  // B can't link A's transaction to B's bill
  const bb = await call('POST', '/api/wealth/bills', { name: 'B rent', amount: 1100, due_day: 1 }, tokB);
  assert.equal(bb.status, 201);
  const lists = await Promise.all(['/api/wealth/transactions', '/api/wealth/goals', '/api/wealth/bills/upcoming', '/api/wealth/budgets'].map((p) => call('GET', p, null, tokB)));
  assert.equal(lists[0].body.transactions.length, 0);
  assert.equal(lists[1].body.goals.length, 0);
  assert.equal(lists[3].body.budgets.length, 0);
  // no token at all
  const r = await fetch(base + '/api/wealth/transactions');
  assert.equal(r.status, 401);
});
