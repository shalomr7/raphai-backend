// ai/gemini.js
// ------------------------------------------------------------
// Minimal Gemini API client (REST, no SDK):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   header x-goog-api-key: GEMINI_API_KEY
// Request: systemInstruction, contents, tools[].functionDeclarations,
// generationConfig.maxOutputTokens. Reference:
//   https://ai.google.dev/api/generate-content  (checked 2026-10-09)
//   https://ai.google.dev/gemini-api/docs/function-calling
// The key is read from the environment on the server only. It is never
// logged, never sent to the app and never put in git.
// ------------------------------------------------------------

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,62}$/;

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
  maxOutputTokens = 1024, temperature = 0.4, timeoutMs = 15000, fetchImpl = fetch,
}) {
  if (!apiKey) throw new GeminiError('GEMINI_API_KEY is not set', 0);
  if (!MODEL_RE.test(String(model || ''))) throw new GeminiError('Invalid model name', 0);

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { maxOutputTokens, temperature, candidateCount: 1 },
  };
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
    throw new GeminiError(`Gemini error: ${msg}`, res.status); // no body text: it can echo the prompt
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

module.exports = { generate, GeminiError, MODEL_RE };
