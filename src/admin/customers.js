// admin/customers.js
// ------------------------------------------------------------
// The owner's customer directory (CRM). IDENTITY + SUBSCRIPTION fields only.
//
// NEVER returned here (Google Play Health Connect policy, DPDP Act, our
// Privacy Policy): any individual's health readings (steps, weight, height,
// heart rate, sleep, calories, water, mood, body measurements), finance
// entries (income, expenses, budgets, goals, bills, amounts) or coach chats.
// Those exist only as aggregates in admin/metrics.js. Every query below
// names its columns explicitly (no SELECT *), so a new column never leaks.
//
// Fields the app does not store come back as "Not collected".
// ------------------------------------------------------------

const db = require('../db');
const { PLANS } = require('../utils/plans');
const { SUB_STATE_SQL, classify, listPrice } = require('./metrics');

const NOT_COLLECTED = 'Not collected';
const NOT_PROVIDED = 'Not provided';
const INACTIVE_DAYS = 90;

// 9812345621 -> 98xxxxxx21 (keeps the first 2 and last 2 digits)
function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone).replace(/[^\d+]/g, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6) return 'x'.repeat(digits.length);
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return `${local.slice(0, 2)}${'x'.repeat(local.length - 4)}${local.slice(-2)}`;
}

const iso = (v) => (v ? new Date(v).toISOString() : null);
// users.created_at is TEXT 'YYYY-MM-DD HH:MM:SS' in UTC
const signupIso = (v) => (v ? new Date(`${String(v).replace(' ', 'T')}Z`).toISOString() : null);

function planLabel(r) {
  const c = classify(r);
  const name = PLANS[r.plan] ? PLANS[r.plan].name : r.plan;
  if (c === 'free') return 'Free';
  const per = r.period && r.period !== 'trial' ? ` ${String(r.period).replace('_', ' ')}` : '';
  if (c === 'trial') return `Trial (${name}${per})`;
  return `${name}${per}`;
}

function subStatus(r) {
  const c = classify(r);
  if (c === 'free') {
    if (r.plan && r.plan !== 'free') return 'Expired';
    return 'No subscription';
  }
  if (c === 'trial') return 'Trial';
  if (r.source === 'google_play' && Number(r.auto_renew) === 0 && r.period !== 'monthly_prepaid') return 'Active, will not renew';
  if (r.period === 'monthly_prepaid') return 'Active (prepaid)';
  return 'Active';
}

function renewal(r) {
  const c = classify(r);
  if (c === 'free' || !r.expires_at) return null;
  const willRenew = r.source === 'google_play' && Number(r.auto_renew) === 1 && c === 'paid';
  return { kind: willRenew ? 'renews' : 'expires', at: iso(r.expires_at) };
}

function consentSummary(cs) {
  const c = cs || {};
  const yn = (t) => (c[t] ? (c[t].granted ? 'Yes' : 'No') : 'Not asked');
  return {
    terms_privacy: c.terms_privacy ? `${c.terms_privacy.granted ? 'Accepted' : 'Withdrawn'} (v${c.terms_privacy.version})` : 'Not recorded',
    health_connect: yn('health_connect'),
    background_health: yn('background_health'),
    gemini_ai: yn('gemini'),
    personalised_ads: yn('ads_personalised'),
  };
}

function accountStatus(r) {
  const last = r.last_active_at ? new Date(r.last_active_at) : null;
  if (r.tokens_valid_after && (!last || new Date(r.tokens_valid_after) >= last)) return 'Active (signed out on all devices)';
  if (!last || Date.now() - last.getTime() > INACTIVE_DAYS * 86400000) return `Inactive (${INACTIVE_DAYS}+ days)`;
  return 'Active';
}

function toCustomer(r) {
  const consents = consentSummary(r.consents);
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: NOT_COLLECTED,          // the app does not ask for a phone number
    phone_masked: null,
    gender: r.sex ? (r.sex === 'male' ? 'Male' : r.sex === 'female' ? 'Female' : String(r.sex)) : NOT_PROVIDED,
    age: r.age != null ? r.age : NOT_PROVIDED,
    date_of_birth: NOT_COLLECTED,  // only age is stored
    sign_in_method: 'Email + password',
    plan: planLabel(r),
    plan_group: classify(r) === 'paid' ? r.plan : classify(r),
    subscription_status: subStatus(r),
    renewal: renewal(r),
    billing: r.source === 'google_play' ? 'Google Play' : (classify(r) === 'trial' && r.period === 'trial' ? 'HeartPurse trial' : null),
    signup_at: signupIso(r.created_at),
    last_active_at: iso(r.last_active_at),
    health_connect_connected: consents.health_connect === 'Yes' ? 'Yes' : 'No',
    consents,
    account_status: accountStatus(r),
  };
}

// The ONLY columns read for the directory (identity + subscription + consent flags)
const BASE_SQL = `
  WITH st AS (${SUB_STATE_SQL})
  SELECT u.id, u.name, u.email, u.created_at, u.last_active_at, u.tokens_valid_after,
         p.sex, p.age,
         st.plan, st.period, st.status, st.expires_at, st.auto_renew, st.source, st.trial_used, st.in_trial, st.test_purchase, st.is_active,
         c.consents
  FROM users u
  JOIN st ON st.user_id = u.id
  LEFT JOIN profiles p ON p.user_id = u.id
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(x.type, jsonb_build_object('granted', x.granted, 'version', x.version)) AS consents
    FROM (SELECT DISTINCT ON (type) type, granted, version FROM consents
          WHERE user_id = u.id AND account_deleted_at IS NULL ORDER BY type, created_at DESC, id DESC) x
  ) c ON true`;

const PLAN_FILTERS = {
  free: 'NOT st.is_active',
  trial: "st.is_active AND (st.period = 'trial' OR st.in_trial = 1)",
  paid: "st.is_active AND COALESCE(st.period, '') <> 'trial' AND st.in_trial = 0",
  plus: "st.is_active AND COALESCE(st.period, '') <> 'trial' AND st.in_trial = 0 AND st.plan = 'plus'",
  pro: "st.is_active AND COALESCE(st.period, '') <> 'trial' AND st.in_trial = 0 AND st.plan = 'pro'",
  elite: "st.is_active AND COALESCE(st.period, '') <> 'trial' AND st.in_trial = 0 AND st.plan = 'elite'",
};

function where({ q, plan }) {
  const parts = []; const params = {};
  const term = String(q || '').trim().slice(0, 100);
  if (term) {
    params.like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const asId = /^#?\d{1,9}$/.test(term) ? Number(term.replace('#', '')) : null;
    if (asId) { params.qid = asId; parts.push('(u.id = @qid OR u.name ILIKE @like OR u.email ILIKE @like)'); } else parts.push('(u.name ILIKE @like OR u.email ILIKE @like)');
  }
  if (plan && PLAN_FILTERS[plan]) parts.push(PLAN_FILTERS[plan]);
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

async function list({ q, plan, page = 1, perPage = 25 }) {
  perPage = Math.min(100, Math.max(5, Number(perPage) || 25));
  page = Math.max(1, Number(page) || 1);
  const w = where({ q, plan });
  const total = (await db.get(`SELECT count(*)::int AS n FROM (${BASE_SQL}${w.sql}) z`, w.params)).n;
  const rows = await db.all(`${BASE_SQL}${w.sql} ORDER BY u.id DESC LIMIT @lim OFFSET @off`, { ...w.params, lim: perPage, off: (page - 1) * perPage });
  return { total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)), customers: rows.map(toCustomer) };
}

async function all({ q, plan }) {
  const w = where({ q, plan });
  return (await db.all(`${BASE_SQL}${w.sql} ORDER BY u.id LIMIT 50000`, w.params)).map(toCustomer);
}

async function detail(id) {
  const row = await db.get(`${BASE_SQL} WHERE u.id = @id`, { id });
  if (!row) return null;
  const c = toCustomer(row);
  const sub = await db.get(`SELECT plan, period, status, expires_at, trial_used, source, auto_renew FROM subscriptions WHERE user_id = $1`, [id]);
  const play = await db.all(`SELECT product_id, base_plan_id, offer_id, plan, period, subscription_state, expires_at, auto_renew,
      in_trial, latest_order_id, test_purchase, revoked_at, created_at, updated_at
    FROM google_play_purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
  const legacy = await db.all(`SELECT order_id, plan, period, amount_paise, status, created_at
    FROM payments WHERE user_id = $1 ORDER BY id DESC LIMIT 50`, [id]);
  const access = await db.all(`SELECT event, created_at FROM security_logs
    WHERE user_id = $1 AND event LIKE 'admin_%' ORDER BY created_at DESC LIMIT 10`, [id]);
  c.subscription = sub ? {
    plan: sub.plan, period: sub.period, status: sub.status, expires_at: iso(sub.expires_at),
    trial_used: Boolean(sub.trial_used), billed_by: sub.source === 'google_play' ? 'Google Play' : (sub.plan === 'free' ? null : 'HeartPurse (trial / manual)'),
    auto_renew: Boolean(sub.auto_renew),
  } : null;
  c.payments = [
    ...play.map((p) => {
      const lp = listPrice(p.plan, p.period);
      return {
        source: 'Google Play',
        order_id: p.latest_order_id || 'Not provided by Google yet',
        product: `${PLANS[p.plan] ? PLANS[p.plan].name : p.plan} ${p.base_plan_id || p.period || ''}`.trim(),
        offer: p.offer_id || null,
        amount_inr: Number(p.in_trial) === 1 ? 0 : (lp ? lp.price : null),
        amount_note: Number(p.in_trial) === 1 ? 'Free trial' : 'List price (Google Play has the exact amount charged)',
        state: String(p.subscription_state || '').replace('SUBSCRIPTION_STATE_', '').toLowerCase(),
        test_purchase: Boolean(p.test_purchase),
        refunded_or_revoked_at: iso(p.revoked_at),
        date: iso(p.created_at),
        updated_at: iso(p.updated_at),
        expires_at: iso(p.expires_at),
      };
    }),
    ...legacy.map((p) => ({
      source: 'Old payment order (before Google Play)',
      order_id: p.order_id,
      product: `${PLANS[p.plan] ? PLANS[p.plan].name : p.plan} ${p.period}`,
      amount_inr: Math.round(p.amount_paise) / 100,
      amount_note: null,
      state: p.status,
      date: signupIso(p.created_at),
    })),
  ];
  c.admin_access_log = access.map((a) => ({ event: a.event, at: iso(a.created_at) }));
  return c;
}

// CSV (identity + subscription only). Cells that start with = + - @ are
// prefixed with ' so a spreadsheet never runs them as formulas.
const CSV_COLUMNS = [
  ['id', (c) => c.id], ['name', (c) => c.name], ['email', (c) => c.email], ['phone', (c) => c.phone_masked || c.phone],
  ['gender', (c) => c.gender], ['age', (c) => c.age], ['date_of_birth', (c) => c.date_of_birth],
  ['sign_in_method', (c) => c.sign_in_method], ['plan', (c) => c.plan], ['subscription_status', (c) => c.subscription_status],
  ['renews_or_expires', (c) => (c.renewal ? `${c.renewal.kind} ${c.renewal.at}` : '')], ['billing', (c) => c.billing || ''],
  ['signup_at', (c) => c.signup_at], ['last_active_at', (c) => c.last_active_at || ''],
  ['health_connect_connected', (c) => c.health_connect_connected], ['terms_privacy', (c) => c.consents.terms_privacy],
  ['account_status', (c) => c.account_status],
];
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(customers) {
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const c of customers) lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f(c))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { list, all, detail, toCsv, maskPhone, NOT_COLLECTED, PLAN_FILTERS };
