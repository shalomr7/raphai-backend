// services/wealthCalc.js
// ------------------------------------------------------------
// HeartPurse Wealth: PURE calculation functions (no database, no clock,
// no network). Every function takes plain data (amounts in integer paise,
// dates as 'YYYY-MM-DD' strings) and returns plain data, so each one is
// tested directly in test/wealth_calc.js.
//
// Accounting rules (docs/WEALTH.md):
//  - type 'expense'  : money spent. Counts toward spending and budgets.
//                      A credit-card purchase is an expense on the day it is made.
//  - type 'income'   : money received (salary, freelance, interest...).
//  - type 'refund'   : money back for an earlier spend. It REDUCES the
//                      spending of its category in the month it arrives
//                      (never shown as income). A category never goes below 0.
//  - type 'transfer' : money moved between the user's own places
//                      (bank -> wallet, paying the credit-card bill, moving
//                      money into a savings goal). Never income, never spending.
//                      So a card purchase + the later card-bill payment counts once.
//  - category 'Investment' (SIP/FD...) is saving, not spending: it is shown
//    as "invested" and is left out of spending and of the overall budget.
// ------------------------------------------------------------

const TYPES = ['expense', 'income', 'transfer', 'refund'];
const SAVING_CATEGORIES = ['Investment'];
const OVERALL = 'Overall'; // reserved budget "category" = whole month's spending
const ALERT_LEVELS = [50, 80, 100];
const EXCEEDED = 101; // stored marker for "went over the limit"

// ---------------- dates (pure, calendar only) ----------------
const pad = (n) => String(n).padStart(2, '0');
function parse(d) { const [y, m, day] = d.split('-').map(Number); return { y, m, d: day }; }
function fmt(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysIn(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
function daysInMonthKey(month) { const [y, m] = month.split('-').map(Number); return daysIn(y, m); }
function addDays(date, n) {
  const t = Date.UTC(...(([y, m, d]) => [y, m - 1, d])(date.split('-').map(Number))) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function diffDays(a, b) { // b - a in whole days
  const ta = Date.parse(`${a}T00:00:00Z`); const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86400000);
}
// The `day`-th of the month that is `k` months after (y, m), clamped to that
// month's length: 31 Jan + 1 month = 28 Feb (29 in a leap year).
function monthPlus(y, m, k, day) {
  const idx = y * 12 + (m - 1) + k;
  const ny = Math.floor(idx / 12); const nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(day, daysIn(ny, nm)));
}
function shiftMonth(month, k) { const [y, m] = month.split('-').map(Number); return monthPlus(y, m, k, 1).slice(0, 7); }
function monthRange(month) { return { from: `${month}-01`, to: `${month}-${pad(daysInMonthKey(month))}` }; }

// ---------------- totals ----------------
/**
 * Totals for a list of transactions (already limited to one period).
 * tx: { type, category, amount_paise, date }
 * Returns integer paise. Missing data is shown as counts, so the app can say
 * "no spends recorded" instead of "you spent ₹0".
 */
function periodTotals(txs) {
  const cat = {}; // category -> { spent, refunds, count }
  let incomeP = 0; let incomeN = 0; let transferP = 0; let transferN = 0; let expenseN = 0; let refundN = 0;
  for (const t of txs) {
    const p = Number(t.amount_paise);
    if (!Number.isFinite(p) || p <= 0) continue; // never trust a bad row
    if (t.type === 'income') { incomeP += p; incomeN++; continue; }
    if (t.type === 'transfer') { transferP += p; transferN++; continue; }
    if (t.type !== 'expense' && t.type !== 'refund') continue;
    const c = cat[t.category] || (cat[t.category] = { gross: 0, refunds: 0, count: 0 });
    if (t.type === 'expense') { c.gross += p; c.count++; expenseN++; } else { c.refunds += p; refundN++; }
  }
  let spentP = 0; let investedP = 0;
  const byCategory = Object.entries(cat).map(([category, c]) => {
    const net = Math.max(0, c.gross - c.refunds); // a refund never makes a category negative
    if (SAVING_CATEGORIES.includes(category)) investedP += net; else spentP += net;
    return { category, total_paise: net, gross_paise: c.gross, refunds_paise: c.refunds, count: c.count, is_saving: SAVING_CATEGORIES.includes(category) };
  }).sort((a, b) => b.total_paise - a.total_paise || a.category.localeCompare(b.category));
  return {
    income_paise: incomeP, income_count: incomeN,
    spent_paise: spentP, invested_paise: investedP,
    net_paise: incomeP - spentP - investedP, // recorded cash flow, NOT a bank balance
    transfer_paise: transferP, transfer_count: transferN,
    expense_count: expenseN, refund_count: refundN,
    has_spending_data: expenseN > 0 || refundN > 0,
    has_income_data: incomeN > 0,
    by_category: byCategory,
  };
}

// Net spending of one category from a periodTotals() result (0 if none)
function categorySpent(totals, category) {
  if (category === OVERALL) return totals.spent_paise;
  const c = totals.by_category.find((x) => x.category === category);
  return c ? c.total_paise : 0;
}

// ---------------- budgets ----------------
function parseLevels(s) {
  if (s === null || s === undefined) return ALERT_LEVELS.slice();
  return String(s).split(',').map((x) => Number(x.trim())).filter((x) => ALERT_LEVELS.includes(x)).sort((a, b) => a - b);
}

/**
 * Status of one monthly budget.
 * limitP, spentP: paise. month 'YYYY-MM'. today 'YYYY-MM-DD'.
 * levels: thresholds the user wants alerts for (subset of 50/80/100).
 * crossed: every enabled level reached (+ EXCEEDED when spent > limit and 100 is on).
 */
function budgetStatus({ limitP, spentP, month, today, levels = ALERT_LEVELS }) {
  const remaining = limitP - spentP;
  const pct = limitP > 0 ? Math.round((spentP / limitP) * 1000) / 10 : (spentP > 0 ? null : 0);
  const { from, to } = monthRange(month);
  let daysRemaining;
  if (today < from) daysRemaining = daysInMonthKey(month);
  else if (today > to) daysRemaining = 0;
  else daysRemaining = diffDays(today, to) + 1; // today counts
  const crossed = [];
  if (limitP > 0) {
    for (const l of levels) if (spentP * 100 >= limitP * l) crossed.push(l);
    if (levels.includes(100) && spentP > limitP) crossed.push(EXCEEDED);
  }
  let state = 'ok';
  if (limitP > 0 && spentP > limitP) state = 'over';
  else if (limitP > 0 && spentP * 100 >= limitP * 100) state = 'reached';
  else if (limitP > 0 && spentP * 100 >= limitP * 80) state = 'near';
  return {
    limit_paise: limitP, spent_paise: spentP,
    remaining_paise: Math.max(0, remaining), over_by_paise: Math.max(0, -remaining),
    pct_used: pct, days_remaining: daysRemaining,
    per_day_left_paise: daysRemaining > 0 && remaining > 0 ? Math.floor(remaining / daysRemaining) : 0,
    state, crossed,
  };
}

/** Which crossings are new: in `crossed` but not in the stored set `already`. */
function newCrossings(crossed, already) {
  const seen = new Set((already || []).map(Number));
  return crossed.filter((l) => !seen.has(l));
}

// ---------------- month vs month ----------------
const MIN_RECORDS_FOR_COMPARISON = 3;
function monthOverMonth(cur, prev) {
  const enough = cur.expense_count >= MIN_RECORDS_FOR_COMPARISON && prev.expense_count >= MIN_RECORDS_FOR_COMPARISON;
  const cats = new Set([...cur.by_category, ...prev.by_category].map((c) => c.category));
  const rows = [...cats].map((category) => {
    const a = categorySpent(cur, category); const b = categorySpent(prev, category);
    return { category, this_paise: a, last_paise: b, change_paise: a - b, change_pct: b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null };
  }).sort((x, y) => Math.abs(y.change_paise) - Math.abs(x.change_paise));
  return {
    enough_data: enough,
    min_records: MIN_RECORDS_FOR_COMPARISON,
    spent_this_paise: cur.spent_paise, spent_last_paise: prev.spent_paise,
    change_paise: cur.spent_paise - prev.spent_paise,
    change_pct: prev.spent_paise > 0 ? Math.round(((cur.spent_paise - prev.spent_paise) / prev.spent_paise) * 1000) / 10 : null,
    by_category: enough ? rows : [],
  };
}

// ---------------- savings goals ----------------
// entries: { kind: 'opening'|'contribution'|'withdrawal', amount_paise, date }
function goalSaved(entries) {
  let s = 0;
  for (const e of entries || []) {
    const p = Number(e.amount_paise);
    if (!Number.isFinite(p) || p <= 0) continue;
    s += e.kind === 'withdrawal' ? -p : p;
  }
  return s;
}

// Remaining monthly periods from `today` up to `target` (both 'YYYY-MM-DD').
// The month of the target date counts when its day has not passed yet,
// e.g. 2026-11-02 -> 2027-05-02 = 6, -> 2027-05-01 = 5, -> 2026-11-30 = 1.
// null when the target date is today or in the past.
function monthsRemaining(today, target) {
  if (!target || target <= today) return null;
  const a = parse(today); const b = parse(target);
  let n = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) n -= 1;
  return Math.max(1, n);
}

/**
 * Goal numbers. targetP, entries, targetDate (optional), today.
 * suggested monthly = ceil(max(0, T − S) / N) paise (N = monthsRemaining).
 */
function goalProgress({ targetP, entries, targetDate, today, status = 'active' }) {
  const savedP = goalSaved(entries);
  const valid = Number.isFinite(targetP) && targetP > 0;
  const remainingP = valid ? Math.max(0, targetP - savedP) : null;
  const pct = valid ? Math.min(100, Math.round((Math.max(0, savedP) / targetP) * 1000) / 10) : null;
  let review = null;
  if (!valid) review = 'invalid_target';
  else if (targetDate && targetDate <= today && remainingP > 0 && status !== 'completed') review = 'target_date_passed';
  const n = targetDate ? monthsRemaining(today, targetDate) : null;
  const perMonthP = valid && n && remainingP > 0 ? Math.ceil(remainingP / n) : (valid && n ? 0 : null);

  // Estimated completion: only from real history (2+ positive entries over 30+ days)
  let estimate = null;
  const dated = (entries || []).filter((e) => e.kind === 'contribution' && Number(e.amount_paise) > 0).map((e) => e.date).sort();
  if (valid && remainingP > 0 && dated.length >= 2) {
    const first = dated[0];
    const span = diffDays(first, today);
    if (span >= 30) {
      const net = (entries || []).filter((e) => e.kind !== 'opening' && e.date >= first)
        .reduce((s, e) => s + (e.kind === 'withdrawal' ? -1 : 1) * Number(e.amount_paise), 0);
      const perDay = net / span;
      if (perDay > 0) estimate = addDays(today, Math.ceil(remainingP / perDay));
    }
  }
  return {
    saved_paise: savedP, remaining_paise: remainingP, progress_pct: pct,
    complete: valid && savedP >= targetP,
    months_left: n, suggested_monthly_paise: perMonthP,
    estimated_completion: estimate, needs_review: review,
  };
}

/**
 * Emergency fund planning estimate.
 * essentialP: essential monthly expenses (paise), months: chosen months (1–24),
 * currentP: savings already set aside, targetDate optional.
 */
function emergencyFund({ essentialP, months, currentP = 0, targetDate = null, today }) {
  const errors = [];
  if (!Number.isFinite(essentialP) || essentialP <= 0) errors.push('essential_monthly');
  if (!Number.isInteger(months) || months < 1 || months > 24) errors.push('months');
  if (!Number.isFinite(currentP) || currentP < 0) errors.push('current_savings');
  if (errors.length) return { ok: false, errors };
  const targetP = essentialP * months;
  const gapP = Math.max(0, targetP - currentP);
  const n = targetDate ? monthsRemaining(today, targetDate) : null;
  return {
    ok: true,
    target_paise: targetP, gap_paise: gapP,
    covered_months: Math.floor((currentP / essentialP) * 10) / 10,
    progress_pct: Math.min(100, Math.round((currentP / targetP) * 1000) / 10),
    months_left: n,
    suggested_monthly_paise: n ? Math.ceil(gapP / n) : null,
    target_date_passed: Boolean(targetDate && targetDate <= today && gapP > 0),
  };
}

// ---------------- recurring bills ----------------
const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];

/**
 * Every due date of a bill between from and to (inclusive), deterministic.
 * bill: { frequency, due_day, start_date, end_date, cancelled_from }
 *  - monthly: the bill's due_day each month (31 -> last day of short months)
 *  - quarterly / yearly: start_date's day every 3 / 12 months (clamped, so
 *    29 Feb yearly -> 28 Feb in non-leap years, back to 29 Feb in leap years)
 *  - weekly: every 7 days from start_date
 * Without start_date (bills made before 2026-11) a monthly bill runs forever.
 */
function occurrences(bill, from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  const freq = FREQUENCIES.includes(bill.frequency) ? bill.frequency : 'monthly';
  const start = bill.start_date || null;
  let end = bill.end_date || null;
  if (bill.cancelled_from) { const c = addDays(bill.cancelled_from, -1); end = !end || c < end ? c : end; }
  const lo = start && start > from ? start : from;
  const hi = end && end < to ? end : to;
  if (lo > hi) return out;
  if (freq === 'weekly') {
    if (!start) return out; // a weekly bill needs a first date
    const k0 = Math.max(0, Math.ceil(diffDays(start, lo) / 7));
    for (let k = k0; ; k++) { const d = addDays(start, 7 * k); if (d > hi) break; if (d >= lo) out.push(d); if (out.length > 600) break; }
    return out;
  }
  const step = freq === 'monthly' ? 1 : freq === 'quarterly' ? 3 : 12;
  let anchorY; let anchorM; let day;
  if (freq === 'monthly') {
    day = Number(bill.due_day) || (start ? parse(start).d : 1);
    const a = parse(start || lo); anchorY = a.y; anchorM = a.m;
  } else {
    if (!start) return out;
    const a = parse(start); anchorY = a.y; anchorM = a.m; day = a.d;
  }
  // first k whose date could be >= lo
  const l = parse(lo);
  let k = Math.max(0, Math.floor(((l.y * 12 + l.m) - (anchorY * 12 + anchorM)) / step) - 1);
  for (; ; k++) {
    const d = monthPlus(anchorY, anchorM, k * step, day);
    if (d > hi) break;
    if (d >= lo && (!start || d >= start)) out.push(d);
    if (out.length > 600) break;
  }
  return out;
}

/** Next due date on/after `today` (null if the bill has ended). */
function nextDue(bill, today, horizonDays = 800) {
  const list = occurrences(bill, today, addDays(today, horizonDays));
  return list.length ? list[0] : null;
}

/**
 * Status of one occurrence given its stored row (or none).
 * row: { status: 'paid'|'skipped'|'postponed', postponed_to }
 */
function occurrenceStatus(dueDate, row, today) {
  if (row && row.status === 'paid') return 'paid';
  if (row && row.status === 'skipped') return 'skipped';
  const effective = row && row.status === 'postponed' && row.postponed_to ? row.postponed_to : dueDate;
  if (effective < today) return 'overdue';
  if (effective === today) return 'due_today';
  return 'upcoming';
}

/** When to remind: `leadDays` before the effective due date at 9:00 local; null if in the past. */
function reminderDate(effectiveDue, leadDays, today) {
  const lead = Number.isInteger(leadDays) && leadDays >= 0 && leadDays <= 30 ? leadDays : 1;
  const d = addDays(effectiveDue, -lead);
  return d >= today ? d : null;
}

/**
 * Transactions that could be the payment of a bill occurrence (to link
 * instead of recording a second expense): expenses within ±7 days of the
 * due date, amount within 10% of the expected amount, not already linked.
 */
function matchCandidates(expectedP, dueDate, txs, linkedIds = []) {
  const linked = new Set(linkedIds.map(Number));
  return txs.filter((t) => t.type === 'expense' && !linked.has(Number(t.id))
      && Math.abs(diffDays(dueDate, t.date)) <= 7
      && Math.abs(Number(t.amount_paise) - expectedP) * 10 <= expectedP)
    .sort((a, b) => Math.abs(diffDays(dueDate, a.date)) - Math.abs(diffDays(dueDate, b.date))
      || Math.abs(Number(a.amount_paise) - expectedP) - Math.abs(Number(b.amount_paise) - expectedP));
}

module.exports = {
  TYPES, SAVING_CATEGORIES, OVERALL, ALERT_LEVELS, EXCEEDED, FREQUENCIES, MIN_RECORDS_FOR_COMPARISON,
  isLeap, daysIn, daysInMonthKey, addDays, diffDays, monthPlus, shiftMonth, monthRange,
  periodTotals, categorySpent, parseLevels, budgetStatus, newCrossings, monthOverMonth,
  goalSaved, monthsRemaining, goalProgress, emergencyFund,
  occurrences, nextDue, occurrenceStatus, reminderDate, matchCandidates,
};
