// ai/gemini.js
// ------------------------------------------------------------
// Minimal Gemini API client (REST, no SDK):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   header x-goog-api-key: GEMINI_API_KEY
// Request: systemInstruction, contents, tools[].functionDeclarations,
// generationConfig.maxOutputTokens. Reference:
//   https://ai.google.dev/api/generate-content  (checked 2026-10-09)
//   https://ai.google.dev/gemini-api/docs/function-calling
//   https://ai.google.dev/gemini-api/docs/thinking (thinkingLevel, Gemini 3)
//   https://ai.google.dev/gemini-api/docs/models (checked 2026-10-10: Gemini 2.5
//   is limited to existing users; new projects use 3.5 Flash-Lite / 3.8 Flash)
// The key is read from the environment on the server only. It is never
// logged, never sent to the app and never put in git.
// ------------------------------------------------------------

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,62}$/;

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
];

class GeminiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * generate({ apiKey, model, systemInstruction, contents, functionDeclarations,
 *            maxOutputTokens, timeoutMs, fetchImpl })
 *   -> { content, functionCalls: [{ name, args }], text, finishReason, usage }
 */
async function generate({
  apiKey, model, systemInstruction, contents, functionDeclarations = [],
  maxOutputTokens = 1024, temperature = 0.6, timeoutMs = 15000, fetchImpl = fetch, thinkingLevel,
}) {
  if (!apiKey) throw new GeminiError('GEMINI_API_KEY is not set', 0);
  if (!MODEL_RE.test(String(model || ''))) throw new GeminiError('Invalid model name', 0);

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { maxOutputTokens, temperature, candidateCount: 1 },
    // Gemini's own filters, stricter than default for harassment and hate:
    // a blocked reply comes back empty and the rule-based coach answers.
    safetySettings: SAFETY_SETTINGS,
  };
  // Gemini 3 models think by default; keep it low so replies stay fast and
  // the output budget is not spent on thinking.
  if (/^gemini-3/.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: thinkingLevel || 'low' };
  if (functionDeclarations.length) {
    body.tools = [{ functionDeclarations }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new GeminiError(e.name === 'AbortError' ? 'Gemini timed out' : 'Could not reach Gemini', 0);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = data && data.error && data.error.status ? data.error.status : `HTTP ${res.status}`;
    // Request-validation errors (400) explain what was wrong with the request
    // shape, not the user's text: keep a short, key-redacted hint for the logs.
    let hint = '';
    if (res.status === 400 && data && data.error && typeof data.error.message === 'string') {
      hint = ` (${data.error.message.replace(/AIza[0-9A-Za-z_\-]{20,}|AQ\.[0-9A-Za-z_\-.]{20,}/g, '[key]').slice(0, 160)})`;
    }
    throw new GeminiError(`Gemini error: ${msg}${hint}`, res.status); // never the response body: it can echo the prompt
  }

  const cand = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const content = cand && cand.content ? cand.content : { role: 'model', parts: [] };
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const functionCalls = parts.filter((p) => p && p.functionCall && p.functionCall.name)
    .map((p) => ({ name: String(p.functionCall.name), args: p.functionCall.args || {} }));
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
  return {
    content: { role: 'model', parts }, // sent back as-is (keeps any thoughtSignature)
    functionCalls,
    text,
    finishReason: cand ? cand.finishReason : null,
    usage: data ? data.usageMetadata || null : null,
  };
}

module.exports = { generate, GeminiError, MODEL_RE, SAFETY_SETTINGS };
