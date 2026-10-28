// ── Load .env first, then validate — order matters ───────────────────────────
require('dotenv').config();
const validateEnv = require('./config/envValidator');
validateEnv();

const express = require('express');
const path    = require('path');
const cors    = require('cors');

const app = express();
// Only trust X-Forwarded-* when actually behind a reverse proxy; otherwise a
// client could spoof its IP past the rate limiters.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp);
}
const logger      = require('./logger');
const errorHandler = require('./middlewares/errorHandler');
const { generalLimiter } = require('./middlewares/rateLimiter');
const { ALLOWED_EXTENSIONS } = require('./middlewares/upload');

// ── Body parsers ──────────────────────────────────────────────────────────────
// Keep the exact request bytes on req.rawBody for signature checks (Razorpay webhook).
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

// ── CORS whitelist ────────────────────────────────────────────────────────────
// Exact origin matching on the parsed URL (a prefix check would also accept
// e.g. http://localhost.evil.com).
const toOrigin = (value) => {
  try { return new URL(value).origin; } catch { return null; }
};
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => toOrigin(o.trim()))
    .filter(Boolean)
);
const isProd = process.env.NODE_ENV === 'production';

const isAllowedOrigin = (origin) => {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (allowedOrigins.has(url.origin)) return true;
  // Outside production, allow local dev servers on any port (Flutter web uses
  // random high ports).
  if (!isProd && (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return true;
  }
  return false;
};

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, same-origin, mobile apps)
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    logger.warn(`CORS blocked: ${origin}`);
    callback(null, false);
  },
  credentials: true,
}));

// ── HTTPS redirect (opt-in via FORCE_HTTPS=true) ─────────────────────────────
// Must come AFTER cors() so OPTIONS preflights get CORS headers before redirect.
// Relies on X-Forwarded-Proto, so only meaningful behind a TLS-terminating proxy.
if (process.env.FORCE_HTTPS === 'true') {
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// General limiter on all /api routes
app.use('/api', generalLimiter);

// ── Static uploads ────────────────────────────────────────────────────────────
// Public (images are embedded by the apps), but only allow-listed file types
// are served, never content-sniffed.
app.use('/uploads', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) return res.status(404).end();
  next();
}, express.static(path.join(__dirname, 'uploads'), {
  dotfiles: 'deny',
  index: false,
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// ── Organisation kill-switch ──────────────────────────────────────────────────
// Blocks suspended/cancelled orgs on every /api route (403 ORG_SUSPENDED).
// Self-decodes the JWT, so it must be mounted before all route groups.
const orgStatusGate = require('./middlewares/orgStatusGate');
app.use('/api', orgStatusGate);

// ── Routes ────────────────────────────────────────────────────────────────────
// Every router applies auth per route (auth + requireStaff/requireModule for
// tenant routes, auth + requireOwner for owner routes). Never mount a router
// as app.use('/api', auth, router): that runs auth for EVERY later /api
// request and silently blocks public routes (leads, webhook, getPlans…).

// User routes — auth rate limiter + validators applied inside
const userRoutes = require('./routes/userRoutes');
app.use('/api', userRoutes);

// Master services (branches, languages, categories, etc.)
const masterservicesRoutes = require('./routes/masterservicesRoutes');
app.use('/api', masterservicesRoutes);

// HP routes (auth applied per-route inside hpRoutes.js)
const hpRoutes = require('./routes/hpRoutes');
app.use('/api', hpRoutes);

// HP self-service portal — caregiver login (public + rate-limited) and
// hpAuth-guarded self-service endpoints (auth applied per-route inside).
const hpPortalRoutes = require('./routes/hpPortalRoutes');
app.use('/api', hpPortalRoutes);

// Client self-service portal — customer login + clientAuth-guarded endpoints.
const clientPortalRoutes = require('./routes/clientPortalRoutes');
app.use('/api', clientPortalRoutes);

// ── Phase 5 — Organisations (owner) + Subscription (getPlans is public) ───────
const orgRoutes          = require('./routes/orgRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
app.use('/api', orgRoutes);
app.use('/api', subscriptionRoutes);

// Organisation profile & branding (Settings → Organisation Profile)
const orgProfileRoutes = require('./routes/orgProfileRoutes');
app.use('/api', orgProfileRoutes);

// Master tables — auth applied per-route
const masterTables = require('./routes/masterTableRoutes');
app.use('/api', masterTables);

// Bookings — auth applied per-route
const bookings = require('./routes/bookingsRoutes');
app.use('/api', bookings);

// Support
const supportRoutes = require('./routes/supportRoutes');
app.use('/api', supportRoutes);

// Accounts — auth per-route; /razorpay/webhook is public (signature-verified)
const accountsRoutes = require('./routes/accountsRoutes');
app.use('/api', accountsRoutes);

// ── SaaS Accounts Module ──────────────────────────────────────────────────────
const saasAccountsRoutes = require('./routes/saasAccountsRoutes');
app.use('/api', saasAccountsRoutes);

// ── Phase 4 routes ────────────────────────────────────────────────────────────
const dashboardRoutes = require('./routes/dashboardRoutes');
app.use('/api', dashboardRoutes);

const auditRoutes = require('./routes/auditRoutes');
app.use('/api', auditRoutes);

const reportsRoutes = require('./routes/reportsRoutes');
app.use('/api', reportsRoutes);

// ── Terms & Conditions — auth applied per-route ──────────────────────────────
const termsRoutes = require('./routes/termsRoutes');
app.use('/api', termsRoutes);

// ── Lead capture — public, no auth ───────────────────────────────────────────
const leadsRoutes = require('./routes/leadsRoutes');
app.use('/api', leadsRoutes);

// ── Hostel module — auth applied per-route ────────────────────────────────────
const hostelsRoutes = require('./routes/hostelsRoutes');
app.use('/api', hostelsRoutes);

// ── In-app notifications (admin bell feed) ────────────────────────────────────
const notificationsRoutes = require('./routes/notificationsRoutes');
app.use('/api', notificationsRoutes);

// ── Web apps (Flutter web builds) ─────────────────────────────────────────────
// Owner portal at /owner/ (built with --base-href /owner/), tenant dashboard
// at /. Both use hash URLs (/#/login), so every page load hits index.html and
// no SPA fallback route is needed. Mounted after /api so it never shadows it.
const webApp = (dir) => express.static(path.join(__dirname, 'public', dir), { dotfiles: 'deny' });
app.use('/owner', webApp('owner'));
app.use('/', webApp('app'));

// ── Phase 4.3 — Weekly report cron ───────────────────────────────────────────
const { startWeeklyReportCron } = require('./cron/weeklyReport');
startWeeklyReportCron();

// ── Payment reminder cron (daily at 09:00 AM) ─────────────────────────────────
require('./cron/paymentReminders');

// ── SaaS billing cron (daily at 08:00 AM — monthly invoices + auto-overdue) ───
require('./cron/saasBilling');

// ── In-app reminder cron (daily 07:45 — extension due, subscription expiry,
//    follow-ups) ───────────────────────────────────────────────────────────────
require('./cron/notificationReminders');

// ── Subscription expiry cron (expires lapsed subscriptions / suspends orgs;
//    dry-run unless ENABLE_SUBSCRIPTION_EXPIRY=true) ───────────────────────────
const { startSubscriptionExpiryCron } = require('./cron/subscriptionExpiry');
startSubscriptionExpiryCron();

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});
