// services/aiCoach.js
// ------------------------------------------------------------
// The AI (Gemini) part of the HeartPurse coach: daily AI allowance per plan,
// and the fallback to the rule-based coach.
//
// Without GEMINI_API_KEY no model is connected and the coach answers with
// its rules for everyone. This file is the structure the AI plugs into:
//
//   1. setAiProvider(fn) connects a model. fn({ userId, question, context,
//      model, plan }) must return { text, data? } or null / { text: null, reason }.
//      server.js connects Gemini (ai/index.js) when GEMINI_API_KEY is set.
//      (Tests use a fake.)
//   2. On each paid question we try to use ONE unit of today's AI allowance
//      (LIMITS[plan].ai_coach_per_day, feature 'coach_ai' in feature_usage).
//   3. If there is no provider, no allowance left, or the model fails,
//      the caller answers with the rule-based coach instead. Nobody is
//      blocked: the answer just says engine: 'rule_based'.
//
// An allowance unit is only counted when the model really answered.
// ------------------------------------------------------------

const db = require('../db');
const { today } = require('../utils/dates');
const { LIMITS, PLANS, nextPlanWithMore, aiModelFor } = require('../utils/plans');

const FEATURE = 'coach_ai';
let provider = null; // no AI connected yet

function setAiProvider(fn) { provider = typeof fn === 'function' ? fn : null; }
function aiConnected() { return Boolean(provider); }

async function usedToday(userId) {
  const row = await db.get('SELECT count FROM feature_usage WHERE user_id = $1 AND date = $2 AND feature = $3', [userId, today(), FEATURE]);
  return row ? Number(row.count) : 0;
}

// Take one unit if any are left today. Returns the new count, or null.
async function takeOne(userId, limit) {
  const row = await db.get(`
    INSERT INTO feature_usage (user_id, date, feature, count) VALUES ($1, $2, $3, 1)
    ON CONFLICT (user_id, date, feature) DO UPDATE SET count = feature_usage.count + 1
      WHERE feature_usage.count < $4
    RETURNING count`, [userId, today(), FEATURE, limit]);
  return row ? Number(row.count) : null;
}

async function giveBack(userId) {
  await db.run(`UPDATE feature_usage SET count = GREATEST(0, count - 1)
    WHERE user_id = $1 AND date = $2 AND feature = $3`, [userId, today(), FEATURE]);
}

/**
 * tryAiAnswer({ userId, plan, question, context })
 *  -> { answer: { text } | null, info: { connected, model, limit, used, remaining, limit_reached, fell_back, upgrade_to } }
 * answer is null when the caller must use the rule-based coach.
 */
async function tryAiAnswer({ userId, plan, question, context }) {
  const lim = LIMITS[plan] || LIMITS.free;
  const limit = lim.ai_coach_per_day || 0;
  const info = {
    connected: aiConnected(),
    model: aiModelFor(plan),
    limit,
    used: 0,
    remaining: limit,
    limit_reached: false,
    fell_back: true,
    upgrade_to: null,
  };
  if (!limit) return { answer: null, info: { ...info, upgrade_to: nextPlanWithMore(plan, 'ai_coach_per_day') } };

  if (!provider) {
    info.used = await usedToday(userId);
    info.remaining = Math.max(0, limit - info.used);
    return { answer: null, info };
  }

  const count = await takeOne(userId, limit);
  if (count == null) {
    const up = nextPlanWithMore(plan, 'ai_coach_per_day');
    return {
      answer: null,
      info: {
        ...info, used: limit, remaining: 0, limit_reached: true, upgrade_to: up,
        message: up
          ? `You've used your ${limit} AI answers for today on ${PLANS[plan].name}, so this answer comes from the built-in coach. ${PLANS[up].name} gives you ${LIMITS[up].ai_coach_per_day} AI answers a day.`
          : `You've used your ${limit} AI answers for today, so this answer comes from the built-in coach. AI answers reset tomorrow.`,
      },
    };
  }

  let answer = null;
  let failed = false;
  try {
    answer = await provider({ userId, question, context, model: aiModelFor(plan), plan });
  } catch (e) {
    console.warn('AI coach failed, using rule-based answer:', String(e.message || e).slice(0, 240));
    answer = null;
    failed = true;
  }
  if (!answer || !answer.text) {
    await giveBack(userId);
    // reason (from ai/index.js): consent_required | guardrail | guardrail_output | timeout | empty_answer | too_many_tool_rounds
    const reason = answer && answer.reason ? String(answer.reason) : (failed ? 'provider_error' : 'no_answer');
    return { answer: null, info: { ...info, used: count - 1, remaining: Math.max(0, limit - count + 1), reason } };
  }
  return { answer, info: { ...info, used: count, remaining: Math.max(0, limit - count), fell_back: false } };
}

module.exports = { tryAiAnswer, setAiProvider, aiConnected };
