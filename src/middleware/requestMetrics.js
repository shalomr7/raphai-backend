// middleware/requestMetrics.js
// ------------------------------------------------------------
// Tiny in-memory request metrics for the admin "App health" section:
// request counts, 4xx/5xx counts and latency per ROUTE PATTERN
// (e.g. "GET /api/wealth/calculators/sip", "PUT /api/health/water/:id").
// Nothing about the user is kept: no user id, no IP, no query, no body,
// no real ids from the URL. Numbers reset when the server restarts
// (Render free sleeps when idle), so the dashboard says "since server start".
// ------------------------------------------------------------

const STARTED_AT = new Date();
const routes = new Map(); // "METHOD /pattern" -> { count, c4xx, c5xx, totalMs, maxMs }
const recent = [];        // last N latencies (ms), all routes
const RECENT_MAX = 2000;
const MAX_ROUTES = 500;
const totals = { count: 0, c4xx: 0, c5xx: 0 };

function patternOf(req) {
  if (req.route && req.route.path) {
    const p = `${req.baseUrl || ''}${req.route.path === '/' ? '' : req.route.path}`;
    return p || '/';
  }
  return '(unmatched)';
}

function requestMetrics() {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const key = `${req.method} ${patternOf(req)}`;
      let r = routes.get(key);
      if (!r) {
        if (routes.size >= MAX_ROUTES) return;
        r = { count: 0, c4xx: 0, c5xx: 0, totalMs: 0, maxMs: 0 };
        routes.set(key, r);
      }
      const s = res.statusCode;
      r.count += 1; totals.count += 1;
      if (s >= 400 && s < 500) { r.c4xx += 1; totals.c4xx += 1; }
      if (s >= 500) { r.c5xx += 1; totals.c5xx += 1; }
      r.totalMs += ms; if (ms > r.maxMs) r.maxMs = ms;
      recent.push(ms); if (recent.length > RECENT_MAX) recent.shift();
    });
    next();
  };
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10;
}

function snapshot() {
  const sorted = [...recent].sort((a, b) => a - b);
  const list = [...routes.entries()].map(([route, r]) => ({
    route, count: r.count, errors_4xx: r.c4xx, errors_5xx: r.c5xx,
    avg_ms: Math.round((r.totalMs / r.count) * 10) / 10, max_ms: Math.round(r.maxMs),
  })).sort((a, b) => b.count - a.count);
  return {
    since: STARTED_AT.toISOString(),
    requests: totals.count,
    errors_4xx: totals.c4xx,
    errors_5xx: totals.c5xx,
    error_rate_5xx_pct: totals.count ? Math.round((totals.c5xx / totals.count) * 1000) / 10 : null,
    latency_ms: { p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99), sample: sorted.length },
    routes: list,
  };
}

// Hits on one route pattern since start (e.g. the SIP calculator)
function hits(method, pattern) {
  const r = routes.get(`${method} ${pattern}`);
  return r ? r.count : 0;
}

function resetMetrics() { routes.clear(); recent.length = 0; totals.count = 0; totals.c4xx = 0; totals.c5xx = 0; }

module.exports = { requestMetrics, snapshot, hits, resetMetrics, STARTED_AT };
