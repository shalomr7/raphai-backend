// services/googleIdentity.js
// ------------------------------------------------------------
// Verifies a Google Sign-In ID token on the server (google-auth-library).
// Checks: Google's signature, issuer (accounts.google.com), expiry, and that
// the audience is one of GOOGLE_WEB_CLIENT_ID (comma-separated list allowed;
// the Android app asks for tokens with the WEB client id as audience).
// Not configured (env missing) -> 503 "Google sign-in not configured".
// The token itself is never logged.
// ------------------------------------------------------------
const { OAuth2Client } = require('google-auth-library');
const { HttpError } = require('../utils/http');

const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

function audiences(env = process.env) {
  return String(env.GOOGLE_WEB_CLIENT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
}
const isConfigured = (env = process.env) => audiences(env).length > 0;

let client = null;
let testCerts = null; // tests only: { kid: publicKeyPem } instead of Google's certs
function getClient() {
  if (!client) {
    client = new OAuth2Client();
    if (testCerts) client.getFederatedSignonCertsAsync = async () => ({ certs: testCerts });
  }
  return client;
}
function setTestCerts(certs) {
  if (process.env.NODE_ENV !== 'test') throw new Error('setTestCerts is for tests only');
  testCerts = certs; client = null;
}

function notConfigured() {
  const e = new HttpError(503, 'Google sign-in not configured');
  e.extra = { code: 'google_not_configured' };
  return e;
}
function invalid() {
  const e = new HttpError(401, 'Google sign-in failed. Please try again.');
  e.extra = { code: 'google_token_invalid' };
  return e;
}

// Returns { sub, email, email_verified, name } or throws HttpError.
async function verifyGoogleIdToken(idToken) {
  const aud = audiences();
  if (!aud.length) throw notConfigured();
  let payload;
  try {
    const ticket = await getClient().verifyIdToken({ idToken, audience: aud });
    payload = ticket.getPayload();
  } catch (err) {
    // Short reason only (e.g. "Token used too late", "Wrong recipient"); never the token
    console.warn('Google ID token rejected:', String(err.message || '').split(/[,:]/)[0].slice(0, 60));
    throw invalid();
  }
  if (!payload || !ISSUERS.includes(payload.iss) || !aud.includes(payload.aud) || !payload.sub) throw invalid();
  if (!payload.exp || payload.exp * 1000 < Date.now() - 60 * 1000) throw invalid(); // expired (60 s clock skew)
  return {
    sub: String(payload.sub),
    email: payload.email ? String(payload.email).toLowerCase() : null,
    email_verified: payload.email_verified === true || payload.email_verified === 'true',
    name: payload.name ? String(payload.name) : (payload.given_name ? String(payload.given_name) : null),
  };
}

module.exports = { verifyGoogleIdToken, isConfigured, audiences, notConfigured, setTestCerts, ISSUERS };
