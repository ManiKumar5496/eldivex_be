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
  if (!process.env.APP_BASE_URL) {
    console.warn('⚠️  APP_BASE_URL not set — password reset links will use placeholder URL.');
  }
}

module.exports = validateEnv;
