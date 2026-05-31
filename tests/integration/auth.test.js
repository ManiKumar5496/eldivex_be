/**
 * Integration tests — auth middleware + rate limiter (Phase 1.1, 1.2)
 *
 * Uses Supertest to spin up the actual Express app and hit real endpoints.
 * The DB is not mocked — these tests use the real connection but only
 * read/write non-destructive data (login attempts, GET requests).
 */

require('dotenv').config();
const request = require('supertest');

// Build the Express app without starting the HTTP server
let app;
beforeAll(() => {
  // We need to build the app without calling app.listen()
  // Re-create the app inline so we don't trigger the real server bind
  const express   = require('express');
  const cors      = require('cors');
  const path      = require('path');
  const { authLimiter, generalLimiter } = require('../../middlewares/rateLimiter');
  const validate  = require('../../middlewares/validateRequest');
  const { loginWebSchema } = require('../../validators/userValidator');
  const auth      = require('../../middlewares/auth');
  const userRoutes    = require('../../routes/userRoutes');
  const bookings      = require('../../routes/bookingsRoutes');
  const supportRoutes = require('../../routes/supportRoutes');
  const errorHandler  = require('../../middlewares/errorHandler');

  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
  app.use('/api', generalLimiter);
  app.use('/uploads', express.static(path.join(__dirname, '../../uploads')));
  app.use('/api', userRoutes);
  app.use('/api', auth, bookings);
  app.use('/api', supportRoutes);
  app.use(errorHandler);
});

// ── JWT Auth middleware ───────────────────────────────────────────────────────

describe('JWT auth middleware', () => {
  test('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).get('/api/getUserBookings');
    expect(res.status).toBe(401);
  });

  test('returns 403 when token is malformed (invalid signature)', async () => {
    const res = await request(app)
      .get('/api/getUserBookings')
      .set('Authorization', 'Bearer not.a.valid.token');
    expect(res.status).toBe(403);
  });

  test('returns 401 when Bearer prefix is missing (token treated as absent)', async () => {
    const res = await request(app)
      .get('/api/getUserBookings')
      .set('Authorization', 'just-a-token');
    // "just-a-token" has no space after "Bearer", so split returns no token → 401
    expect([401, 403]).toContain(res.status);
  });
});

// ── Login validation ──────────────────────────────────────────────────────────

describe('POST /api/loginWeb — input validation', () => {
  test('returns 422 when email is missing', async () => {
    const res = await request(app)
      .post('/api/loginWeb')
      .send({ password: 'secret' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Validation failed');
  });

  test('returns 422 when email is not a valid email', async () => {
    const res = await request(app)
      .post('/api/loginWeb')
      .send({ email: 'not-an-email', password: 'secret' });
    expect(res.status).toBe(422);
  });

  test('returns 404 or 401 (not 500) for unknown email', async () => {
    const res = await request(app)
      .post('/api/loginWeb')
      .send({ email: 'no_such_user_xyz@test.com', password: 'wrongpass' });
    expect([401, 404]).toContain(res.status);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe('Rate limiter — auth endpoints', () => {
  // Hit /api/loginWeb 11 times rapidly; the 11th should be 429
  test('returns 429 after 10 login attempts from same IP', async () => {
    const payload = { email: 'ratelimit_test@example.com', password: 'wrong' };
    let lastStatus;

    for (let i = 0; i < 11; i++) {
      const res = await request(app).post('/api/loginWeb').send(payload);
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  }, 30000); // allow up to 30s for 11 sequential requests
});

// ── Booking validation ────────────────────────────────────────────────────────

describe('POST /api/createBooking — Joi validation (Phase 1.3)', () => {
  const jwt = require('jsonwebtoken');
  let token;

  beforeAll(() => {
    // Sign a test token using the same key the middleware will verify
    token = jwt.sign(
      { id: 1, role_id: 1, branch_access: '1,2,3' },
      process.env.JWT_TOKEN_KEY,
      { expiresIn: '1h' }
    );
  });

  test('returns 422 when required booking fields are missing', async () => {
    const res = await request(app)
      .post('/api/createBooking')
      .set('Authorization', `Bearer ${token}`)
      .send({ some_random_field: 'value' });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'user_id' })])
    );
  });
});
