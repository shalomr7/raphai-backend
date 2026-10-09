// services/email.js
// ------------------------------------------------------------
// Tiny email provider interface: provider.send({ to, subject, text }).
// Default provider = Resend HTTP API (RESEND_API_KEY + EMAIL_FROM).
// Not configured -> isConfigured() is false; callers decide what to do.
// Tests swap in a fake with setEmailProvider().
// ------------------------------------------------------------

function resendProvider({ apiKey, from, fetchImpl = fetch, timeoutMs = 10000 }) {
  return {
    name: 'resend',
    async send({ to, subject, text }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
      return true;
    },
  };
}

let override = null;
function setEmailProvider(p) { override = p; }

function getEmailProvider() {
  if (override) return override;
  const apiKey = process.env.RESEND_API_KEY; const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return null;
  return resendProvider({ apiKey, from });
}

const isConfigured = () => Boolean(getEmailProvider());

module.exports = { getEmailProvider, setEmailProvider, isConfigured, resendProvider };
