// middleware/security.js
// ------------------------------------------------------------
// Security headers (helmet) and the CORS policy.
//
// CORS: the API is used by the Android app (native code, which does not
// use CORS at all) and by our own server-rendered pages (same origin).
// So no other website needs to call it from a browser:
//   CORS_ORIGIN unset/empty           -> no cross-origin browser access
//   CORS_ORIGIN="*" in production     -> treated as unset (warned at start)
//   CORS_ORIGIN="*" in dev/test       -> any origin (for Expo web on localhost)
//   CORS_ORIGIN="https://a.com,https://b.com" -> exactly those origins
// Auth is a Bearer header (no cookies), so credentials are never allowed.
// ------------------------------------------------------------

const helmet = require('helmet');

function corsOptions(env = process.env) {
  const raw = String(env.CORS_ORIGIN || '').trim();
  const prod = env.NODE_ENV === 'production';
  const base = {
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 600,
  };
  if (!raw || (raw === '*' && prod)) return { ...base, origin: false, mode: 'none' };
  if (raw === '*') return { ...base, origin: '*', mode: 'any' };
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return { ...base, origin: list, mode: 'allowlist' };
}

// Headers for every response. The HTML pages (/privacy, /terms,
// /delete-account) use one inline <style> block and no scripts.
function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
  });
}

module.exports = { corsOptions, securityHeaders };
