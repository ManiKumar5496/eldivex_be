/**
 * envValidator.js
 * Validates required environment variables on startup.
 * The server will crash with a clear message if any critical var is missing or insecure.
 */

const INSECURE_JWT_KEYS = ['THEWEBTOKEN', 'secret', 'mysecret', 'jwt_secret', ''];

function validateEnv() {
  const errors = [];

  // ── JWT ───────────────────────────────────────────────────────────────────
  if (!process.env.JWT_TOKEN_KEY) {
    errors.push('JWT_TOKEN_KEY is not set.');
  } else if (INSECURE_JWT_KEYS.includes(process.env.JWT_TOKEN_KEY)) {
    errors.push(`JWT_TOKEN_KEY is set to an insecure default value ("${process.env.JWT_TOKEN_KEY}"). Generate a random 64-char key.`);
  } else if (process.env.JWT_TOKEN_KEY.length < 32) {
    errors.push(`JWT_TOKEN_KEY is too short (${process.env.JWT_TOKEN_KEY.length} chars). Minimum 32 characters required.`);
  }

  // ── Database ──────────────────────────────────────────────────────────────
  if (!process.env.DB_HOST) errors.push('DB_HOST is not set.');
  if (!process.env.DB_USER) errors.push('DB_USER is not set.');
  if (!process.env.DB_NAME) errors.push('DB_NAME is not set.');

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.DB_PASS) {
      errors.push('DB_PASS must be set in production.');
    }
    if (!process.env.ALLOWED_ORIGINS) {
      errors.push('ALLOWED_ORIGINS must be set in production.');
    }
    if (!process.env.DOC_FOLDER_URL?.startsWith('https://')) {
      errors.push('DOC_FOLDER_URL must use HTTPS in production.');
    }
    // Platform-owner credentials must be provided explicitly — no baked-in default.
    if (!process.env.OWNER_EMAIL) {
      errors.push('OWNER_EMAIL must be set in production.');
    }
    if (!process.env.OWNER_PASSWORD_HASH) {
      errors.push('OWNER_PASSWORD_HASH (bcrypt hash) must be set in production.');
    }
    // Static-OTP test backdoors must never be enabled in production.
    if (process.env.HP_STATIC_OTP || process.env.CLIENT_STATIC_OTP) {
      errors.push('HP_STATIC_OTP / CLIENT_STATIC_OTP must not be set in production.');
    }
  }

  // ── Optional feature flags (all default off) ──────────────────────────────
  //   EXPOSE_DEV_OTP=true            return dev_otp / honour *_STATIC_OTP —
  //                                  only when NODE_ENV=development
  //   FORCE_HTTPS=true               301 HTTP→HTTPS (behind a TLS proxy)
  //   TRUST_PROXY=1                  trust X-Forwarded-* (behind a proxy only)
  //   ENFORCE_PLAN_LIMITS=true       enforce booking_limit / hp_limit
  //   ENABLE_SUBSCRIPTION_EXPIRY=true  expiry cron acts (else logs only)
  if (process.env.EXPOSE_DEV_OTP === 'true' && process.env.NODE_ENV === 'production') {
    errors.push('EXPOSE_DEV_OTP must not be true in production.');
  }
  const BOOL_FLAGS = ['EXPOSE_DEV_OTP', 'FORCE_HTTPS', 'ENFORCE_PLAN_LIMITS', 'ENABLE_SUBSCRIPTION_EXPIRY'];
  for (const flag of BOOL_FLAGS) {
    const v = process.env[flag];
    if (v !== undefined && v !== '' && v !== 'true' && v !== 'false') {
      errors.push(`${flag} must be "true" or "false" (got "${v}").`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (errors.length > 0) {
    console.error('\n❌ Environment validation failed:\n');
    errors.forEach(e => console.error(`  • ${e}`));
    console.error('\nFix the above issues in your .env file and restart.\n');
    process.exit(1);
  }

  console.log('✅ Environment variables validated successfully.');

  // ── Optional — warn on missing (non-fatal) ────────────────────────────────
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('⚠️  EMAIL_USER / EMAIL_PASS not set — outbound emails are disabled.');
  }
  if (!process.env.SMS_API_KEY) {
    console.warn('⚠️  SMS_API_KEY not set — SMS notifications are disabled.');
  }
  if (process.env.EXPOSE_DEV_OTP === 'true' && process.env.NODE_ENV !== 'development') {
    console.warn('⚠️  EXPOSE_DEV_OTP is ignored unless NODE_ENV=development.');
  }
  if (!process.env.APP_BASE_URL) {
    console.warn('⚠️  APP_BASE_URL not set — password reset links will use placeholder URL.');
  }
}

module.exports = validateEnv;
