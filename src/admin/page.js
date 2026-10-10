// admin/page.js
// ------------------------------------------------------------
// The admin dashboard web page: HTML shell, CSS and the browser script.
// Served by routes/adminPage.js at /admin, /admin/app.css, /admin/app.js.
// The shell holds NO data: after sign-in the script calls /api/admin/*.
// The script builds every element with textContent (never innerHTML with
// data), so names or emails can never inject markup.
// ------------------------------------------------------------

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#000000">
<title>HeartPurse Admin</title>
<link rel="stylesheet" href="/admin/app.css">
</head>
<body>
<header class="top">
  <div class="brand"><span class="dot"></span>HeartPurse <small>Admin</small></div>
  <button id="logout" class="ghost" hidden>Sign out</button>
</header>
<nav id="tabs" class="tabs" hidden></nav>
<main id="app">
  <section id="login" class="card narrow">
    <h1>Owner sign-in</h1>
    <p class="muted">Private dashboard. Every view is recorded in the security log.</p>
    <form id="step1" autocomplete="on">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" required maxlength="120">
      <label for="password">HeartPurse password</label>
      <input id="password" type="password" autocomplete="current-password" required maxlength="100">
      <button type="submit">Continue</button>
    </form>
    <form id="step2" hidden autocomplete="off">
      <label id="codeLabel" for="code">Code</label>
      <input id="code" type="password" required maxlength="100" autocomplete="one-time-code">
      <button type="submit">Sign in</button>
      <button type="button" id="restart" class="ghost">Start again</button>
    </form>
    <p id="loginMsg" class="msg" role="alert"></p>
  </section>
</main>
<noscript><p class="card narrow">This dashboard needs JavaScript.</p></noscript>
<script src="/admin/app.js"></script>
</body>
</html>`;

const CSS = `
:root { color-scheme: dark; --bg:#000; --card:#141414; --line:#262626; --text:#f2f2f2; --muted:#9a9a9a; --gold:#D4AF37; --red:#e5484d; --green:#3fb950; }
* { box-sizing: border-box; }
html, body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.top { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:rgba(0,0,0,.92); border-bottom:1px solid var(--line); }
.brand { font-weight:700; letter-spacing:.2px; display:flex; align-items:center; gap:8px; }
.brand small { color:var(--gold); font-weight:600; }
.dot { width:10px; height:10px; border-radius:50%; background:var(--gold); display:inline-block; }
.tabs { position:sticky; top:49px; z-index:4; display:flex; gap:8px; overflow-x:auto; padding:10px 12px; background:#000; border-bottom:1px solid var(--line); scrollbar-width:none; }
.tabs::-webkit-scrollbar { display:none; }
.tabs button { flex:0 0 auto; width:auto; margin:0; padding:8px 14px; border-radius:999px; background:var(--card); color:var(--text); border:1px solid var(--line); font-weight:600; font-size:14px; }
.tabs button.on { background:var(--gold); color:#000; border-color:var(--gold); }
main { max-width:1100px; margin:0 auto; padding:14px 12px 60px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin:0 0 12px; }
.narrow { max-width:420px; margin:24px auto; }
h1 { font-size:1.35rem; margin:0 0 6px; } h2 { font-size:1.1rem; margin:0 0 10px; } h3 { font-size:.95rem; margin:14px 0 8px; color:var(--muted); font-weight:600; }
.muted { color:var(--muted); font-size:.85rem; }
label { display:block; font-weight:600; margin:12px 0 6px; font-size:.9rem; }
input, select { width:100%; padding:12px; font-size:16px; color:var(--text); background:#0a0a0a; border:1px solid #333; border-radius:10px; }
button { width:100%; margin-top:14px; padding:13px; font-size:15px; font-weight:700; color:#000; background:var(--gold); border:0; border-radius:10px; cursor:pointer; }
button.ghost { background:transparent; color:var(--text); border:1px solid #333; }
button.small { width:auto; margin:0; padding:7px 12px; font-size:13px; }
button.danger { background:var(--red); color:#fff; }
.top button { width:auto; margin:0; padding:7px 12px; font-size:13px; }
.msg { min-height:1.2em; color:var(--red); font-size:.9rem; }
.grid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:10px; }
@media (min-width:720px) { .grid { grid-template-columns:repeat(4, minmax(0,1fr)); } .two { display:grid; grid-template-columns:1fr 1fr; gap:12px; } }
.kpi { background:#0b0b0b; border:1px solid var(--line); border-radius:12px; padding:12px; min-width:0; }
.kpi .v { font-size:1.45rem; font-weight:800; color:var(--text); overflow-wrap:anywhere; }
.kpi .v.na { font-size:.95rem; font-weight:600; color:var(--muted); }
.kpi .l { font-size:.78rem; color:var(--muted); margin-top:2px; }
.note { font-size:.78rem; color:var(--muted); margin:8px 0 0; }
.nt { display:inline-block; font-size:.75rem; color:#bbb; border:1px dashed #444; border-radius:6px; padding:1px 6px; }
svg { display:block; width:100%; height:auto; }
.hbar { display:grid; grid-template-columns:minmax(90px, 38%) 1fr auto; align-items:center; gap:8px; margin:6px 0; font-size:.85rem; }
.hbar .track { background:#0b0b0b; border-radius:6px; height:12px; overflow:hidden; }
.hbar .fill { background:var(--gold); height:100%; border-radius:6px; }
.hbar .fill.small { background:#444; }
.tbl { width:100%; border-collapse:collapse; font-size:.85rem; }
.tbl th, .tbl td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
.tbl th { color:var(--muted); font-weight:600; }
.scroll { overflow-x:auto; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.row > * { flex:1 1 140px; }
.cust { display:block; padding:12px 0; border-bottom:1px solid var(--line); cursor:pointer; }
.cust:last-child { border-bottom:0; }
.cust .n { font-weight:700; } .cust .e { color:var(--muted); font-size:.85rem; overflow-wrap:anywhere; }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.chip { font-size:.75rem; padding:2px 8px; border-radius:999px; background:#0b0b0b; border:1px solid var(--line); color:#ddd; }
.chip.gold { border-color:var(--gold); color:var(--gold); }
dl { display:grid; grid-template-columns:minmax(110px, 40%) 1fr; gap:8px 10px; margin:0; font-size:.9rem; }
dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
.pager { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:12px; }
.pager button { width:auto; margin:0; padding:8px 14px; }
.banner { border-left:4px solid var(--gold); background:#17140a; padding:10px 12px; border-radius:8px; font-size:.85rem; margin-bottom:12px; }
`;

// ---------------- Browser script ----------------
const JS = `(() => {
'use strict';
const KEY = 'hp_admin_token';
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem(KEY) || null;
let challenge = null;
let current = 'growth';
const custState = { q: '', plan: '', page: 1 };

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) { if (k == null || k === false) continue; e.append(k instanceof Node ? k : document.createTextNode(String(k))); }
  return e;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, text) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api/admin' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'omit', cache: 'no-store' });
  if ((res.status === 401 || res.status === 403) && !opts.login) { signOut(res.status === 403 ? 'This account has no admin access.' : 'Please sign in again.'); throw new Error('auth'); }
  if (opts.raw) { if (!res.ok) throw new Error('HTTP ' + res.status); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ---- formatting ----
const isNT = (v) => v && typeof v === 'object' && v.not_tracked;
function fmt(v, unit) {
  if (isNT(v)) return 'Not tracked yet';
  if (v === null || v === undefined) return 'No data yet';
  if (v === '<5') return '<5';
  if (typeof v === 'number') {
    if (unit === '%') return v.toLocaleString('en-IN') + '%';
    if (unit === 'inr') return '\\u20B9' + Math.round(v).toLocaleString('en-IN');
    return v.toLocaleString('en-IN') + (unit ? ' ' + unit : '');
  }
  return String(v);
}
function kpi(label, v, unit) {
  const text = fmt(v, unit);
  const na = isNT(v) || v === null || v === undefined;
  return el('div', { class: 'kpi' }, el('div', { class: 'v' + (na ? ' na' : '') }, text), el('div', { class: 'l' }, label));
}
const note = (t) => (t ? el('p', { class: 'note' }, t) : null);
const ntNote = (v) => (isNT(v) ? el('p', { class: 'note' }, el('span', { class: 'nt' }, 'Not tracked yet'), ' ', v.note) : null);
const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '\\u2014');
const dOnly = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '\\u2014');

// ---- charts (inline SVG) ----
function barChart(series, title) {
  const W = 340, H = 140, P = 22;
  const nums = series.map((p) => (typeof p.value === 'number' ? p.value : 0));
  const max = Math.max(5, ...nums);
  const bw = (W - P) / series.length;
  const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': title || 'chart' });
  svg.append(s('line', { x1: P, y1: H - 18, x2: W, y2: H - 18, stroke: '#333' }));
  svg.append(s('text', { x: 0, y: 12, fill: '#777', 'font-size': 10 }, String(max)));
  series.forEach((p, i) => {
    const x = P + i * bw + 1;
    let h = 0, fill = '#D4AF37';
    if (p.value === '<5') { h = 6; fill = '#555'; } else if (typeof p.value === 'number') h = (p.value / max) * (H - 34);
    if (h > 0) {
      const r = s('rect', { x, y: H - 18 - h, width: Math.max(1, bw - 2), height: h, rx: 2, fill });
      r.append(s('title', {}, p.date + ': ' + fmt(p.value)));
      svg.append(r);
    }
    if (i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2)) {
      svg.append(s('text', { x: x + bw / 2, y: H - 4, fill: '#777', 'font-size': 9, 'text-anchor': 'middle' }, p.date.slice(5)));
    }
  });
  return el('div', {}, svg, el('p', { class: 'note' }, 'Grey stubs = fewer than 5 users that day ("<5").'));
}
function hbars(items, key, unit) {
  key = key || 'value';
  if (!Array.isArray(items) || !items.length) return el('p', { class: 'muted' }, items === '<5' ? '<5 users so far' : 'No data yet');
  const max = Math.max(1, ...items.map((i) => (typeof i[key] === 'number' ? i[key] : 0)));
  return el('div', {}, items.map((i) => {
    const v = i[key]; const small = v === '<5';
    const w = small ? 3 : (typeof v === 'number' ? Math.max(2, (v / max) * 100) : 0);
    return el('div', { class: 'hbar' }, el('span', {}, i.label), el('div', { class: 'track' }, el('div', { class: 'fill' + (small ? ' small' : ''), style: 'width:' + w + '%' })), el('b', {}, fmt(v, unit)));
  }));
}
const card = (title, ...kids) => el('section', { class: 'card' }, el('h2', {}, title), ...kids);
const grid = (...k) => el('div', { class: 'grid' }, ...k);

// ---- sections ----
const SECTIONS = {
  growth: ['Growth', (d) => [
    card('Users', grid(kpi('Total users', d.total_users), kpi('New (30 days)', d.new_signups_30d), kpi('Deleted (30 days)', d.deleted_accounts.last_30_days), kpi('Deleted (12 months)', d.deleted_accounts.last_12_months))),
    card('New signups by day (30 days)', barChart(d.signups_by_day, 'Signups by day')),
    card('Active users', grid(kpi('DAU', d.dau), kpi('WAU', d.wau), kpi('MAU', d.mau), kpi('DAU / MAU', d.stickiness_dau_mau_pct, '%')), note(d.notes.active)),
    card('Retention', grid(kpi('D1', d.retention.d1.pct, '%'), kpi('D7', d.retention.d7.pct, '%'), kpi('D30', d.retention.d30.pct, '%'), kpi('D1 cohort size', d.retention.d1.cohort)), note(d.notes.retention)),
  ]],
  revenue: ['Revenue', (d) => [
    card('Plans', grid(kpi('Free', d.plans.free), kpi('On trial', d.plans.trial), kpi('Paid', d.plans.paid), kpi('Active subscriptions', d.active_subscriptions))),
    card('Money in', grid(kpi('Estimated MRR', d.estimated_mrr_inr, 'inr'), kpi('Trial \\u2192 paid', d.trial_to_paid_pct, '%'), kpi('Trials ended', d.trial_ended_users), kpi('Test purchases (excluded)', d.test_purchases_excluded)), note(d.notes.mrr), note(d.notes.conversion)),
    card('Paid plans', hbars(d.paid_by_plan)),
    card('Cancellations', grid(kpi('Paid, set to not renew', d.cancellations.paid_set_to_not_renew), kpi('Play cancelled / expired (30d)', d.cancellations.play_cancelled_or_expired_30d), kpi('Refunded / revoked (30d)', d.cancellations.refunded_or_revoked_30d), kpi('In-app downgrades', d.cancellations.in_app_downgrades)), ntNote(d.cancellations.in_app_downgrades)),
  ]],
  health: ['Health', (d) => [
    el('div', { class: 'banner' }, 'Aggregates only. No one\\'s individual readings are shown anywhere in this dashboard.'),
    card('Activity (7 days)', grid(kpi('Avg daily steps', d.avg_daily_steps_7d), kpi('Hitting step goal', d.step_goal_hit_pct_7d, '%'), kpi('Users with steps', d.users_with_steps_7d), kpi('Avg water / day', d.avg_water_ml_7d, 'ml')), note(d.notes.steps)),
    card('Health Connect', grid(kpi('Connected', d.health_connect_connected_pct, '%'), kpi('Synced in 7 days', d.health_connect_syncing_7d))),
    card('Calorie logging', grid(kpi('Users logging (7d)', d.calorie_logging.users_logging_food_7d), kpi('% of users (7d)', d.calorie_logging.pct_of_users_7d, '%'), kpi('Avg logging days / week', d.calorie_logging.avg_logging_days_per_week)), el('h3', {}, 'Users logging food per day'), barChart(d.calorie_logging.loggers_by_day)),
    el('div', { class: 'two' }, card('BMI distribution', hbars(d.bmi_distribution), note(d.notes.bmi)), card('Weight trend (30 days)', hbars(d.weight_trend_30d))),
    card('Most-used fitness features (30 days, users)', hbars(d.fitness_features_30d), note(d.notes.fitness),
      el('h3', {}, 'Top workouts (5+ users)'), d.top_workouts_30d.length ? hbars(d.top_workouts_30d, 'users') : el('p', { class: 'muted' }, 'No workout type has 5+ users yet.'),
      el('p', { class: 'note' }, 'HIIT plans: ', el('span', { class: 'nt' }, 'Not tracked yet'))),
  ]],
  money: ['Money', (d) => [
    el('div', { class: 'banner' }, 'Aggregates only. No one\\'s transactions, budgets or amounts are shown.'),
    card('Planning', grid(kpi('Have a budget this month', d.users_with_budget_this_month_pct, '%'), kpi('Have a savings goal', d.users_with_savings_goal_pct, '%'), kpi('Avg savings rate (30d)', d.avg_savings_rate_30d_pct, '%'), kpi('Goals completed', d.goal_completion.goals_completed_pct, '%')), note(d.notes.savings_rate)),
    card('Top spending categories (share, 30 days)', hbars(d.top_spending_categories_30d, 'share_pct', '%'), note(d.notes.categories)),
    card('SIP / EMI calculators', grid(kpi('SIP (since server start)', d.calculators.since_server_start.sip), kpi('EMI (since server start)', d.calculators.since_server_start.emi), kpi('Daily history', d.calculators.persistent)), note('Counted since ' + dt(d.calculators.since_server_start.since) + '.'), ntNote(d.calculators.persistent)),
  ]],
  coach: ['AI coach', (d) => [
    card('Chats per day (14 days)', barChart(d.chats_by_day), note(d.notes.chats)),
    card('Engine (30 days)', grid(kpi('Chat users', d.chat_users_30d), kpi('AI (Gemini) answers', d.ai_answers_30d), kpi('Free rule-based answers', d.free_rule_based_answers_30d), kpi('Gemini vs fallback share', d.gemini_vs_fallback)), ntNote(d.gemini_vs_fallback)),
    card('Daily limits (30 days)', grid(kpi('Free limit reached (user-days)', d.daily_limit_hits_30d.free_limit_reached_user_days), kpi('Users who hit it', d.daily_limit_hits_30d.free_limit_users), kpi('AI allowance used up (user-days)', d.daily_limit_hits_30d.ai_allowance_used_up_user_days), kpi('Users', d.daily_limit_hits_30d.ai_allowance_users)), note(d.notes.limits)),
    card('Safety and topics', grid(kpi('Topics (health / money / other)', d.topics), kpi('Guardrail blocks', d.guardrail_blocks)), ntNote(d.topics), ntNote(d.guardrail_blocks)),
  ]],
  app: ['App health', (d) => [
    card('Deploy', el('dl', {}, el('dt', {}, 'Version'), el('dd', {}, d.deploy.version), el('dt', {}, 'Commit'), el('dd', {}, d.deploy.commit || 'Not reported'), el('dt', {}, 'Branch'), el('dd', {}, d.deploy.branch || '\\u2014'), el('dt', {}, 'Server started'), el('dd', {}, dt(d.deploy.started_at)), el('dt', {}, 'Node'), el('dd', {}, d.deploy.node), el('dt', {}, 'Latest migration'), el('dd', {}, d.deploy.latest_migrations[0] ? d.deploy.latest_migrations[0].id : '\\u2014')), ntNote(d.deploy.deploy_history)),
    card('API since server start', grid(kpi('Requests', d.requests.requests), kpi('5xx errors', d.requests.errors_5xx), kpi('4xx', d.requests.errors_4xx), kpi('5xx rate', d.requests.error_rate_5xx_pct, '%')), grid(kpi('p50 latency', d.requests.latency_ms.p50, 'ms'), kpi('p95 latency', d.requests.latency_ms.p95, 'ms'), kpi('p99 latency', d.requests.latency_ms.p99, 'ms'), kpi('Sample', d.requests.latency_ms.sample)), note(d.notes.requests)),
    card('Busiest routes', el('div', { class: 'scroll' }, el('table', { class: 'tbl' }, el('tr', {}, el('th', {}, 'Route'), el('th', {}, 'Calls'), el('th', {}, '5xx'), el('th', {}, 'Avg ms')),
      d.requests.routes.slice(0, 15).map((r) => el('tr', {}, el('td', {}, r.route), el('td', {}, r.count), el('td', {}, r.errors_5xx), el('td', {}, r.avg_ms)))))),
  ]],
};

// ---- customers ----
const PLAN_OPTS = [['', 'All plans'], ['free', 'Free'], ['trial', 'Trial'], ['paid', 'Any paid'], ['plus', 'Plus'], ['pro', 'Pro'], ['elite', 'Elite']];
async function renderCustomers(root) {
  const q = el('input', { type: 'search', placeholder: 'Search name, email or ID', value: custState.q, maxlength: 100 });
  const plan = el('select', {}, PLAN_OPTS.map(([v, l]) => el('option', { value: v, selected: v === custState.plan }, l)));
  const listBox = el('div', {}, el('p', { class: 'muted' }, 'Loading\\u2026'));
  const go = () => { custState.q = q.value.trim(); custState.plan = plan.value; custState.page = 1; load(); };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  plan.addEventListener('change', go);
  root.append(
    el('div', { class: 'banner' }, 'Identity and subscription details only. Health readings, money entries and coach chats are never shown here. Every search, view, reveal and export is logged.'),
    card('Customers', el('div', { class: 'row' }, q, plan, el('button', { class: 'small', onclick: go }, 'Search'), el('button', { class: 'small ghost', onclick: () => downloadCsv() }, 'Export CSV')), listBox),
  );
  async function load() {
    listBox.replaceChildren(el('p', { class: 'muted' }, 'Loading\\u2026'));
    const params = new URLSearchParams({ page: custState.page, per_page: 25 });
    if (custState.q) params.set('q', custState.q);
    if (custState.plan) params.set('plan', custState.plan);
    let d; try { d = await api('/customers?' + params); } catch (e) { if (e.message !== 'auth') listBox.replaceChildren(el('p', { class: 'msg' }, e.message)); return; }
    if (!d.customers.length) { listBox.replaceChildren(el('p', { class: 'muted' }, 'No customers match.')); return; }
    listBox.replaceChildren(
      el('p', { class: 'muted' }, d.total + ' customer' + (d.total === 1 ? '' : 's')),
      ...d.customers.map((c) => el('div', { class: 'cust', role: 'button', tabindex: 0, onclick: () => { location.hash = 'customer/' + c.id; } },
        el('div', { class: 'n' }, '#' + c.id + ' \\u00B7 ' + c.name), el('div', { class: 'e' }, c.email),
        el('div', { class: 'chips' }, el('span', { class: 'chip gold' }, c.plan), el('span', { class: 'chip' }, c.subscription_status),
          el('span', { class: 'chip' }, 'Joined ' + dOnly(c.signup_at)), el('span', { class: 'chip' }, 'Active ' + dOnly(c.last_active_at)),
          el('span', { class: 'chip' }, 'Health Connect: ' + c.health_connect_connected), el('span', { class: 'chip' }, c.account_status)))),
      el('div', { class: 'pager' },
        el('button', { class: 'ghost', disabled: d.page <= 1, onclick: () => { custState.page--; load(); } }, '\\u2190 Prev'),
        el('span', { class: 'muted' }, 'Page ' + d.page + ' of ' + d.pages),
        el('button', { class: 'ghost', disabled: d.page >= d.pages, onclick: () => { custState.page++; load(); } }, 'Next \\u2192')),
    );
  }
  load();
}

async function download(path, filename, opts) {
  const res = await api(path, { raw: true, ...(opts || {}) });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function downloadCsv() {
  const params = new URLSearchParams();
  if (custState.q) params.set('q', custState.q);
  if (custState.plan) params.set('plan', custState.plan);
  download('/customers/export.csv?' + params, 'heartpurse-customers.csv').catch((e) => { if (e.message !== 'auth') alert(e.message); });
}

async function renderCustomer(root, id) {
  root.append(el('p', {}, el('a', { href: '#customers', style: 'color:#D4AF37' }, '\\u2190 All customers')));
  let c; try { c = (await api('/customers/' + id)).customer; } catch (e) { if (e.message !== 'auth') root.append(el('p', { class: 'msg' }, e.message)); return; }
  const phoneDd = el('dd', {}, c.phone_masked || c.phone, ' ');
  phoneDd.append(el('button', { class: 'small ghost', onclick: async () => {
    try { const r = await api('/customers/' + id + '/reveal-phone', { method: 'POST' }); phoneDd.replaceChildren(r.phone || r.status, el('span', { class: 'muted' }, ' (reveal logged)')); } catch (e) { if (e.message !== 'auth') alert(e.message); }
  } }, 'Reveal'));
  const row = (k, v) => [el('dt', {}, k), v instanceof Node ? v : el('dd', {}, v == null ? '\\u2014' : String(v))];
  const ren = c.renewal ? (c.renewal.kind === 'renews' ? 'Renews ' : 'Expires ') + dOnly(c.renewal.at) : '\\u2014';
  root.append(
    card('#' + c.id + ' \\u00B7 ' + c.name, el('dl', {},
      row('Email', c.email), [el('dt', {}, 'Phone'), phoneDd], row('Gender', c.gender), row('Age', c.age), row('Date of birth', c.date_of_birth),
      row('Sign-in method', c.sign_in_method), row('Plan', c.plan), row('Subscription', c.subscription_status), row('Renewal / expiry', ren),
      row('Billed by', c.billing || '\\u2014'), row('Signed up', dt(c.signup_at)), row('Last active', dt(c.last_active_at)),
      row('Health Connect', c.health_connect_connected), row('Account status', c.account_status))),
    card('Consents', el('dl', {}, row('Terms + Privacy', c.consents.terms_privacy), row('Health Connect', c.consents.health_connect), row('Background health', c.consents.background_health), row('Gemini AI', c.consents.gemini_ai), row('Personalised ads', c.consents.personalised_ads))),
    card('Subscription and payment history', c.payments.length ? el('div', { class: 'scroll' }, el('table', { class: 'tbl' },
      el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Order ID'), el('th', {}, 'Product'), el('th', {}, 'Amount'), el('th', {}, 'State')),
      c.payments.map((p) => el('tr', {}, el('td', {}, dOnly(p.date)), el('td', {}, p.order_id), el('td', {}, p.product + (p.offer ? ' (' + p.offer + ')' : '') + (p.test_purchase ? ' [test]' : '')),
        el('td', {}, p.amount_inr == null ? '\\u2014' : fmt(p.amount_inr, 'inr'), p.amount_note ? el('div', { class: 'muted' }, p.amount_note) : null), el('td', {}, p.state || '\\u2014'))))) : el('p', { class: 'muted' }, 'No purchases yet.')),
    card('Support actions',
      el('p', { class: 'muted' }, 'Only on the customer\\'s own request. Both are logged with your account and the reason.'),
      el('button', { class: 'ghost', onclick: async () => {
        const reason = prompt('Reason for exporting this customer\\'s data (e.g. request reference):'); if (!reason) return;
        try { await download('/customers/' + id + '/export', 'heartpurse-export-' + id + '.json', { method: 'POST', body: { reason } }); } catch (e) { if (e.message !== 'auth') alert(e.message); }
      } }, 'Export this user\\'s data (JSON)'),
      el('button', { class: 'danger', onclick: async () => {
        const typed = prompt('This permanently deletes the account and all its data. Type the customer ID (' + id + ') to confirm:'); if (typed === null) return;
        if (String(typed).trim() !== String(id)) { alert('ID did not match. Nothing was deleted.'); return; }
        const reason = prompt('Reason / deletion request reference:'); if (!reason) return;
        try { await api('/customers/' + id + '/delete', { method: 'POST', body: { confirm_id: Number(id), reason } }); alert('Account deleted.'); location.hash = 'customers'; } catch (e) { if (e.message !== 'auth') alert(e.message); }
      } }, 'Delete account (on request)')),
    card('Admin access to this record', c.admin_access_log.length ? el('table', { class: 'tbl' }, c.admin_access_log.map((a) => el('tr', {}, el('td', {}, a.event.replace('admin_', '').replace(/_/g, ' ')), el('td', {}, dt(a.at))))) : el('p', { class: 'muted' }, 'None before this view.')),
  );
}

// ---- shell ----
const TABS = [['growth', 'Growth'], ['revenue', 'Revenue'], ['health', 'Health'], ['money', 'Money'], ['coach', 'AI coach'], ['app', 'App health'], ['customers', 'Customers']];
function drawTabs() {
  const nav = $('tabs'); nav.hidden = false;
  nav.replaceChildren(...TABS.map(([id, label]) => el('button', { class: id === current ? 'on' : '', onclick: () => { location.hash = id; } }, label)));
}
async function route() {
  if (!token) return;
  const h = (location.hash || '#growth').slice(1);
  const m = h.match(/^customer\\/(\\d+)$/);
  current = m ? 'customers' : (TABS.some(([id]) => id === h) ? h : 'growth');
  drawTabs();
  const root = $('app'); root.replaceChildren();
  if (m) return renderCustomer(root, m[1]);
  if (current === 'customers') return renderCustomers(root);
  const [title, render] = SECTIONS[current];
  root.append(el('p', { class: 'muted' }, 'Loading ' + title + '\\u2026'));
  try {
    const d = await api('/' + current);
    root.replaceChildren(...render(d), el('p', { class: 'note' }, 'Updated ' + dt(d.generated_at) + ' IST. Groups of 1\\u20134 people show "<5".'));
  } catch (e) { if (e.message !== 'auth') root.replaceChildren(el('p', { class: 'msg' }, 'Could not load: ' + e.message)); }
}
function signOut(msg) {
  token = null; sessionStorage.removeItem(KEY);
  if (msg) sessionStorage.setItem('hp_admin_msg', msg);
  location.replace('/admin');
}

function initLogin() {
  const m = sessionStorage.getItem('hp_admin_msg'); if (m) { $('loginMsg').textContent = m; sessionStorage.removeItem('hp_admin_msg'); }
  $('step1').addEventListener('submit', async (e) => {
    e.preventDefault(); $('loginMsg').textContent = '';
    try {
      const r = await api('/login', { method: 'POST', body: { email: $('email').value, password: $('password').value }, login: true });
      challenge = r.challenge; $('password').value = '';
      $('codeLabel').textContent = r.step === 'email_code' ? '6-digit code we just emailed you' : 'Admin password';
      $('code').setAttribute('inputmode', r.step === 'email_code' ? 'numeric' : 'text');
      $('step1').hidden = true; $('step2').hidden = false; $('code').focus();
    } catch (err) { $('loginMsg').textContent = err.message; }
  });
  $('step2').addEventListener('submit', async (e) => {
    e.preventDefault(); $('loginMsg').textContent = '';
    try {
      const r = await api('/verify', { method: 'POST', body: { challenge, code: $('code').value }, login: true });
      token = r.token; sessionStorage.setItem(KEY, token); $('code').value = '';
      start();
    } catch (err) { $('loginMsg').textContent = err.message; }
  });
  $('restart').addEventListener('click', () => { challenge = null; $('step2').hidden = true; $('step1').hidden = false; $('loginMsg').textContent = ''; });
}
function start() {
  $('logout').hidden = false;
  if (!location.hash) location.hash = 'growth'; else route();
}
$('logout').addEventListener('click', () => signOut(''));
window.addEventListener('hashchange', route);
initLogin();
if (token) start();
})();
`;

module.exports = { HTML, CSS, JS };
