// ── Load .env first, then validate — order matters ───────────────────────────
require('dotenv').config();
const validateEnv = require('./config/envValidator');
validateEnv();

const express = require('express');
const path    = require('path');
const cors    = require('cors');

const app = express();
const logger      = require('./logger');
const errorHandler = require('./middlewares/errorHandler');
const { authLimiter, generalLimiter } = require('./middlewares/rateLimiter');

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── HTTPS redirect (production only) ─────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ── CORS whitelist ────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

const isDev = process.env.NODE_ENV !== 'production';

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, same-origin)
    if (!origin) return callback(null, true);
    // In development, allow any localhost origin (Flutter uses random high ports)
    if (isDev && (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))) {
      return callback(null, true);
    }
    // In production, require an explicit match in ALLOWED_ORIGINS
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn(`CORS blocked: ${origin}`);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// General limiter on all /api routes
app.use('/api', generalLimiter);

// ── Static uploads ────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Auth middleware ───────────────────────────────────────────────────────────
const auth = require('./middlewares/auth');

// ── Validators ────────────────────────────────────────────────────────────────
const validate = require('./middlewares/validateRequest');
const { loginWebSchema, createUserSchema } = require('./validators/userValidator');
const { createBookingSchema, extendBookingSchema, finalBookingSaveSchema } = require('./validators/bookingValidator');
const { createHPSchema } = require('./validators/hpValidator');
const { createSupportTicketSchema } = require('./validators/supportValidator');

// ── Routes ────────────────────────────────────────────────────────────────────

// User routes — apply auth-specific rate limiter + validators on login/create
const userRoutes = require('./routes/userRoutes');
app.use('/api', userRoutes);

// Master services (branches, languages, categories, etc.)
const masterservicesRoutes = require('./routes/masterservicesRoutes');
app.use('/api', masterservicesRoutes);

// HP routes (auth applied per-route inside hpRoutes.js)
const hpRoutes = require('./routes/hpRoutes');
app.use('/api', hpRoutes);

// ── Phase 5 — Subscription (getPlans is public — must be before auth groups) ──
const orgRoutes          = require('./routes/orgRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
app.use('/api', orgRoutes);
app.use('/api', subscriptionRoutes);

// Master tables — all routes require auth
const masterTables = require('./routes/masterTableRoutes');
app.use('/api', auth, masterTables);

// Bookings — all routes require auth
const bookings = require('./routes/bookingsRoutes');
app.use('/api', auth, bookings);

// Support
const supportRoutes = require('./routes/supportRoutes');
app.use('/api', supportRoutes);

// Accounts — all routes require auth (auth also applied per-route inside)
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

// ── Phase 4.3 — Weekly report cron ───────────────────────────────────────────
const { startWeeklyReportCron } = require('./cron/weeklyReport');
startWeeklyReportCron();

// ── Payment reminder cron (daily at 09:00 AM) ─────────────────────────────────
require('./cron/paymentReminders');

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});
