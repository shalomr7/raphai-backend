// ai/tools.js
// ------------------------------------------------------------
// Server-side tool registry for the AI coach.
//
// The model can only ASK for one of these named tools. It never writes SQL,
// never names a table and never chooses whose data it gets:
//   - userId always comes from the verified login token (the caller passes
//     it in), never from the model's arguments;
//   - every argument is checked with the same validate() rules the API uses
//     (unknown arguments are dropped);
//   - each tool returns a small, summarised JSON object (no ids, emails or
//     raw rows), capped in size;
//   - the only "write" tool, proposeLogEntry, does NOT write. It returns a
//     proposal plus a signed, single-use confirmation token. Nothing is saved
//     until the USER taps confirm (POST /api/coach/confirm).
// ------------------------------------------------------------

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const calc = require('../utils/calc');
const summary = require('../services/summary');
const intelligence = require('../services/intelligence');
const { validate, HttpError } = require('../utils/http');
const { today, thisMonth } = require('../utils/dates');
const { jwtSecret, ALGORITHM } = require('../middleware/auth');
const { planAndLimits } = require('../middleware/requirePlan');

const MAX_RESULT_CHARS = 6000;
const PROPOSAL_AUDIENCE = 'raphai:ai-proposal';
const PROPOSAL_TTL = '15m';

const r1 = (v) => (v == null ? null : calc.round(v, 1));

// ---------------- proposals (write only after the user confirms) ----------------
const PROPOSAL_KINDS = {
  water: { rules: { ml: { type: 'number', required: true, min: 10, max: 5000 }, date: { type: 'date' } }, label: (v) => `Log ${v.ml} ml of water` },
  weight: { rules: { weight_kg: { type: 'number', required: true, min: 25, max: 300 }, date: { type: 'date' } }, label: (v) => `Log weight ${v.weight_kg} kg` },
  mood: { rules: { mood: { type: 'integer', required: true, min: 1, max: 5 }, note: { type: 'string', maxLength: 300 }, date: { type: 'date' } }, label: (v) => `Log mood ${v.mood}/5` },
  sleep: { rules: { hours: { type: 'number', required: true, min: 0, max: 24 }, quality: { type: 'integer', min: 1, max: 5 }, date: { type: 'date' } }, label: (v) => `Log ${v.hours} h of sleep` },
  expense: {
    rules: {
      amount: { type: 'money', required: true, min: 1, max: 10000000 },
      category: { type: 'string', required: true, oneOf: summary.EXPENSE_CATEGORIES },
      mode: { type: 'string', required: true, oneOf: ['UPI', 'Card', 'Cash'] },
      note: { type: 'string', maxLength: 200 },
      date: { type: 'date' },
    },
    label: (v) => `Add expense ₹${v.amount} (${v.category}, ${v.mode})`,
  },
};

function validateProposal(kind, values) {
  const k = PROPOSAL_KINDS[kind];
  if (!k) throw new HttpError(400, 'Unknown entry type', [`kind must be one of: ${Object.keys(PROPOSAL_KINDS).join(', ')}`]);
  const clean = validate(values, k.rules);
  clean.date = clean.date || today();
  return clean;
}

function signProposal(userId, kind, values) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ kind, values }, jwtSecret(), {
    algorithm: ALGORITHM, audience: PROPOSAL_AUDIENCE, subject: String(userId), expiresIn: PROPOSAL_TTL, jwtid: jti,
  });
  return { jti, token };
}

// Confirm a proposal: verify the token belongs to THIS user, re-validate the
// values, mark it used (once only), then write. Returns the saved entry.
async function confirmProposal(userId, token) {
  let p;
  try {
    p = jwt.verify(String(token || ''), jwtSecret(), { algorithms: [ALGORITHM], audience: PROPOSAL_AUDIENCE });
  } catch {
    throw new HttpError(400, 'This suggestion has expired or is not valid. Ask again.');
  }
  if (String(p.sub) !== String(userId)) throw new HttpError(403, 'This suggestion belongs to another account.');
  const values = validateProposal(p.kind, p.values);

  return db.tx(async (t) => {
    const used = await t.get('INSERT INTO ai_proposals_used (jti, user_id, kind) VALUES ($1, $2, $3) ON CONFLICT (jti) DO NOTHING RETURNING jti', [p.jti, userId, p.kind]);
    if (!used) throw new HttpError(409, 'This suggestion was already saved.');
    let entry;
    switch (p.kind) {
      case 'water':
        entry = await t.get('INSERT INTO water_logs (user_id, date, ml) VALUES ($1, $2, $3) RETURNING *', [userId, values.date, values.ml]); break;
      case 'weight':
        entry = await t.get('INSERT INTO weight_logs (user_id, date, weight_kg) VALUES ($1, $2, $3) RETURNING *', [userId, values.date, values.weight_kg]);
        await t.run('UPDATE profiles SET weight_kg = $1 WHERE user_id = $2', [values.weight_kg, userId]); break;
      case 'mood':
        entry = await t.get('INSERT INTO mood_logs (user_id, date, mood, note) VALUES ($1, $2, $3, $4) RETURNING *', [userId, values.date, values.mood, values.note || null]); break;
      case 'sleep':
        entry = await t.get('INSERT INTO sleep_logs (user_id, date, hours, quality) VALUES ($1, $2, $3, $4) RETURNING *', [userId, values.date, values.hours, values.quality || null]); break;
      case 'expense':
        entry = await t.get('INSERT INTO expenses (user_id, amount, category, mode, note, date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
          [userId, values.amount, values.category, values.mode, values.note || null, values.date]); break;
      default: throw new HttpError(400, 'Unknown entry type');
    }
    return { kind: p.kind, entry };
  });
}

// ---------------- the registry ----------------
// parameters: JSON schema shown to the model (Gemini "functionDeclarations")
// rules: what validate() accepts (the real check)
const TOOLS = {
  getHealthSummary: {
    description: "The user's nutrition, water and sleep for one day, with their daily targets. Missing data is null.",
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD. Default: today.' } } },
    rules: { date: { type: 'date' } },
    async run(userId, a) {
      const d = await summary.healthDay(userId, a.date || today());
      return {
        date: d.date,
        profile_complete: Boolean(d.targets),
        targets: d.targets ? { calories: d.targets.calories, protein_g: d.targets.protein_g, water_ml: d.targets.water_ml } : null,
        eaten: d.eaten && d.eaten.kcal ? { kcal: d.eaten.kcal, protein_g: d.eaten.protein_g, carbs_g: d.eaten.carbs_g, fat_g: d.eaten.fat_g } : null,
        calories_left: d.targets && d.eaten && d.eaten.kcal ? d.calories_left : null,
        water_ml: d.water_ml || null,
        sleep_hours: d.sleep_hours || null,
      };
    },
  },
  getFitnessSummary: {
    description: "The user's steps, step goal, workouts and phone/watch activity for one day.",
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD. Default: today.' } } },
    rules: { date: { type: 'date' } },
    async run(userId, a) {
      const date = a.date || today();
      const [d, act, w] = await Promise.all([
        summary.healthDay(userId, date),
        db.get('SELECT steps, distance_m, active_kcal, active_minutes, resting_hr, source FROM activity_daily WHERE user_id = $1 AND date = $2', [userId, date]),
        db.all('SELECT activity, minutes, kcal FROM workouts WHERE user_id = $1 AND date = $2 ORDER BY id', [userId, date]),
      ]);
      return {
        date,
        steps: d.steps || (act && act.steps) || null,
        step_goal: d.step_goal,
        workouts: w.map((x) => ({ activity: x.activity, minutes: r1(x.minutes), kcal: calc.round(x.kcal) })),
        activity: act ? { distance_m: act.distance_m, active_kcal: act.active_kcal, active_minutes: act.active_minutes, resting_hr: act.resting_hr, source: act.source } : null,
      };
    },
  },
  getFinanceSummary: {
    description: "The user's money for one month: income, spending by category, budgets and bills due. Amounts are in Indian rupees.",
    parameters: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM. Default: this month.' } } },
    rules: { month: { type: 'month' } },
    async run(userId, a) {
      const m = await summary.wealthMonth(userId, a.month || thisMonth());
      return {
        month: m.month,
        income: m.income || null,
        spent: m.spent,
        invested: m.invested,
        left_over: m.income ? calc.round(m.income - m.spent - m.invested) : null,
        by_category: m.by_category.slice(0, 8).map((c) => ({ category: c.category, total: c.total })),
        bills_paid_of_due: `${m.bills_paid_of_due}/${m.bills_due_so_far}`,
      };
    },
  },
  getGoals: {
    description: "The user's savings goals and health goal (lose / maintain / gain weight, step goal).",
    parameters: { type: 'object', properties: {} },
    rules: {},
    async run(userId) {
      const [goals, p] = await Promise.all([
        db.all('SELECT name, target, saved, deadline FROM savings_goals WHERE user_id = $1 ORDER BY id LIMIT 10', [userId]),
        db.get('SELECT goal, pace_kg_week, step_goal FROM profiles WHERE user_id = $1', [userId]),
      ]);
      return {
        health_goal: p ? { goal: p.goal, pace_kg_week: p.pace_kg_week, step_goal: p.step_goal } : null,
        savings_goals: goals.map((g) => ({ name: g.name, target: g.target, saved: g.saved, deadline: g.deadline, progress_pct: calc.round((g.saved / g.target) * 100, 1) })),
      };
    },
  },
  getTrends: {
    description: 'Averages and day-by-day trends over the last 7 or 30 days (steps, sleep, calories, water, spending). Longer windows depend on the plan.',
    parameters: { type: 'object', properties: { days: { type: 'integer', description: '7 or 30', enum: [7, 30] } } },
    rules: { days: { type: 'integer', oneOf: [7, 30] } },
    async run(userId, a) {
      const want = a.days || 7;
      const { limits } = await planAndLimits(userId);
      const days = Math.min(want, limits.trend_days || 7);
      const t = await intelligence.trends(userId, days);
      return { days, summary: t.summary, insights: (t.insights || []).slice(0, 4) };
    },
  },
  getDailyBrief: {
    description: "Today's HeartScore, top priorities and the morning brief built from the user's own data.",
    parameters: { type: 'object', properties: {} },
    rules: {},
    async run(userId) {
      const ins = await intelligence.todayInsights(userId);
      return {
        raphscore: ins.raphscore ? { overall: ins.raphscore.overall, label: ins.raphscore.label, areas: (ins.raphscore.areas || []).map((x) => ({ key: x.key, score: x.score, status: x.status })) } : null,
        priorities: (ins.priorities || []).map((p) => ({ title: p.title, detail: p.detail })),
        insight: ins.insight || null,
      };
    },
  },
  proposeLogEntry: {
    description: 'Suggest saving a log entry the user clearly asked for (water, weight, mood, sleep or an expense). This does NOT save anything: the user must tap confirm in the app.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: Object.keys(PROPOSAL_KINDS) },
        ml: { type: 'number' }, weight_kg: { type: 'number' }, mood: { type: 'integer' }, note: { type: 'string' },
        hours: { type: 'number' }, quality: { type: 'integer' },
        amount: { type: 'number', description: 'Rupees' }, category: { type: 'string', enum: summary.EXPENSE_CATEGORIES }, mode: { type: 'string', enum: ['UPI', 'Card', 'Cash'] },
        date: { type: 'string', description: 'YYYY-MM-DD. Default: today.' },
      },
      required: ['kind'],
    },
    rules: null, // validated per kind below
    proposes: true,
    async run(userId, a) {
      const kind = String((a && a.kind) || '');
      const { kind: _k, ...rest } = a || {};
      const values = validateProposal(kind, rest);
      const { token } = signProposal(userId, kind, values);
      return { requires_confirmation: true, kind, values, summary: PROPOSAL_KINDS[kind].label(values), confirmation_token: token };
    },
  },
};

const TOOL_NAMES = Object.keys(TOOLS);

// Gemini "functionDeclarations"
function declarations() {
  return TOOL_NAMES.map((name) => ({ name, description: TOOLS[name].description, parameters: TOOLS[name].parameters }));
}

// Run one tool call for ONE user. Never throws: errors become { error }.
async function runTool(userId, name, args) {
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) return { error: 'no user' };
  const tool = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return { error: `unknown tool ${String(name).slice(0, 40)}` };
  try {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const clean = tool.rules ? validate(a, tool.rules) : a;
    const out = await tool.run(Number(userId), clean);
    const json = JSON.stringify(out);
    if (json.length > MAX_RESULT_CHARS) return { truncated: true, data: json.slice(0, MAX_RESULT_CHARS) };
    return out;
  } catch (e) {
    if (e instanceof HttpError) return { error: e.message, details: e.details };
    console.error('AI tool failed:', name, e.code || e.message);
    return { error: 'tool failed' };
  }
}

module.exports = { TOOLS, TOOL_NAMES, declarations, runTool, confirmProposal, PROPOSAL_KINDS, validateProposal, MAX_RESULT_CHARS };
