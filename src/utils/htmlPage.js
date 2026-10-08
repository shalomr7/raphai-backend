// utils/htmlPage.js
// ------------------------------------------------------------
// The simple, readable, mobile-friendly dark page used by the public web
// pages: /privacy, /terms (routes/legal.js) and /delete-account
// (routes/deleteAccount.js).
// ------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0f1115; color: #e6e8eb; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  h1, h2, h3 { color: #ffffff; line-height: 1.3; }
  h1 { font-size: 1.75rem; margin-top: 0; }
  a { color: #7cc4ff; }
  code { background: #1c2028; padding: 2px 5px; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid #2a2f3a; padding: 6px 10px; text-align: left; }
  hr { border: 0; border-top: 1px solid #2a2f3a; margin: 2rem 0; }
  form { background: #161a21; border: 1px solid #2a2f3a; border-radius: 12px; padding: 20px; margin: 24px 0; }
  label { display: block; font-weight: 600; margin: 12px 0 6px; }
  input[type=email], input[type=password] { box-sizing: border-box; width: 100%; padding: 12px; font-size: 16px; color: #e6e8eb; background: #0f1115; border: 1px solid #3a4150; border-radius: 8px; }
  input[type=checkbox] { width: 20px; height: 20px; vertical-align: middle; margin-right: 8px; }
  button { margin-top: 18px; width: 100%; padding: 14px; font-size: 16px; font-weight: 700; color: #fff; background: #c62f3b; border: 0; border-radius: 8px; cursor: pointer; }
  .notice { border-left: 4px solid #f2b84b; background: #1f1b12; padding: 12px 16px; border-radius: 6px; }
  .error { border-left: 4px solid #e5484d; background: #241417; padding: 12px 16px; border-radius: 6px; }
  .success { border-left: 4px solid #3fb950; background: #12201a; padding: 12px 16px; border-radius: 6px; }
  footer { margin-top: 48px; color: #8a919c; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
${bodyHtml}
<footer>RaphAi &middot; <a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms &amp; Conditions</a> &middot; <a href="/delete-account">Delete account</a></footer>
</main>
</body>
</html>`;
}

module.exports = { page, escapeHtml };
