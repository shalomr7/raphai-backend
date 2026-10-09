// ai/index.js
// ------------------------------------------------------------
// AI orchestration: connects a model to the coach (services/aiCoach.js
// setAiProvider) with server-side tools and guardrails.
//
//   configureFromEnv()  -> GEMINI_API_KEY set?  Gemini provider : none
//                          (none = rule-based coach for everyone, as before)
//   createGeminiProvider({ apiKey, fetchImpl, models }) -> provider function
//
// Provider flow for one question (userId comes from the login token):
//   1. Consent: the user's latest 'gemini' consent must be granted (DPDP:
//      their data goes to Google only if they agreed). Else -> rule-based.
//   2. Guardrails: obvious prompt-injection -> rule-based.
//   3. Up to MAX_ROUNDS model calls. Each round the model may call up to
//      MAX_CALLS_PER_ROUND tools (ai/tools.js); results go back as data.
//   4. Whole thing must finish within TOTAL_BUDGET_MS; each HTTP call has
//      its own timeout. Output tokens are capped per call.
//   5. The answer is cleaned (ai/guardrails.js). Proposals the model made are
//      returned to the app, which shows a Confirm button.
// Any failure returns null, and the coach answers with its rules instead.
// ------------------------------------------------------------

const db = require('../db');
const aiCoach = require('../services/aiCoach');
const tools = require('./tools');
const guard = require('./guardrails');
const gemini = require('./gemini');

const MAX_ROUNDS = 4;
const MAX_CALLS_PER_ROUND = 4;
const PER_CALL_TIMEOUT_MS = 12000;
const TOTAL_BUDGET_MS = 25000;
const MAX_OUTPUT_TOKENS = 1024;

async function hasGeminiConsent(userId) {
  const row = await db.get(`SELECT granted FROM consents WHERE user_id = $1 AND type = 'gemini' AND account_deleted_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT 1`, [userId]);
  return Boolean(row && row.granted);
}

// Plan model names can be overridden per plan: GEMINI_MODEL_PLUS, _PRO, _ELITE
function resolveModel(plan, planModel, env = process.env) {
  const override = env[`GEMINI_MODEL_${String(plan || '').toUpperCase()}`];
  return (override && override.trim()) || planModel;
}

function createGeminiProvider({ apiKey, fetchImpl = fetch, env = process.env, perCallTimeoutMs = PER_CALL_TIMEOUT_MS, totalBudgetMs = TOTAL_BUDGET_MS } = {}) {
  return async function geminiProvider({ userId, question, context, model, plan }) {
    if (!(await hasGeminiConsent(userId))) return { text: null, reason: 'consent_required' };
    if (guard.looksLikeInjection(question)) return { text: null, reason: 'guardrail' };

    const started = Date.now();
    const useModel = resolveModel(plan, model, env);
    const contents = [{ role: 'user', parts: [{ text: guard.wrapQuestion(question, context) }] }];
    const used = [];
    const proposals = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const left = totalBudgetMs - (Date.now() - started);
      if (left < Math.min(1500, totalBudgetMs / 4)) return { text: null, reason: 'timeout' };
      const r = await gemini.generate({
        apiKey, model: useModel, systemInstruction: guard.SYSTEM_INSTRUCTION, contents,
        functionDeclarations: tools.declarations(), maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: Math.min(perCallTimeoutMs, left), fetchImpl,
      });
      if (!r.functionCalls.length) {
        const text = guard.cleanAnswer(r.text);
        if (!text) return { text: null, reason: 'empty_answer' };
        return { text, data: { tools_used: used, proposals }, model: useModel };
      }
      contents.push(r.content);
      const responses = [];
      for (const call of r.functionCalls.slice(0, MAX_CALLS_PER_ROUND)) {
        // userId is OURS (from the token). Whatever the model put in args is ignored for scoping.
        const result = await tools.runTool(userId, call.name, call.args);
        used.push(call.name);
        if (tools.TOOLS[call.name] && tools.TOOLS[call.name].proposes && result && result.requires_confirmation) {
          proposals.push({ kind: result.kind, values: result.values, summary: result.summary, confirmation_token: result.confirmation_token });
          // The model does not need the token; keep it out of the conversation
          const { confirmation_token: _t, ...forModel } = result;
          responses.push({ functionResponse: { name: call.name, response: guard.wrapToolResult(forModel) } });
        } else {
          responses.push({ functionResponse: { name: call.name, response: guard.wrapToolResult(result) } });
        }
      }
      contents.push({ role: 'user', parts: responses });
    }
    return { text: null, reason: 'too_many_tool_rounds' };
  };
}

// Wire the provider into the coach based on the environment.
function configureFromEnv(env = process.env) {
  const key = (env.GEMINI_API_KEY || '').trim();
  if (!key) {
    aiCoach.setAiProvider(null);
    return { connected: false, message: 'AI coach: GEMINI_API_KEY not set, using the rule-based coach only' };
  }
  aiCoach.setAiProvider(createGeminiProvider({ apiKey: key, env }));
  return { connected: true, message: 'AI coach: Gemini connected (server-side tools, consent required per user)' };
}

module.exports = { configureFromEnv, createGeminiProvider, hasGeminiConsent, resolveModel, MAX_ROUNDS, TOTAL_BUDGET_MS };
