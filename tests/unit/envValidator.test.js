/**
 * Unit tests — config/envValidator.js
 * Tests that the startup validator catches missing and insecure env vars.
 */

const validateEnv = require('../../config/envValidator');

// Helper: run validateEnv with a temporary env override, capture exit
function runWithEnv(overrides, expectedErrors) {
  const original = { ...process.env };
  Object.assign(process.env, overrides);

  const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

  validateEnv();

  const exitCalled = mockExit.mock.calls.length > 0;
  const errorOutput = mockError.mock.calls.map(c => c[0]).join('\n');

  mockExit.mockRestore();
  mockError.mockRestore();

  // Restore original env
  Object.keys(overrides).forEach(k => {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  });

  return { exitCalled, errorOutput };
}

describe('envValidator', () => {
  test('passes with all required vars set to valid values', () => {
    const { exitCalled } = runWithEnv({
      JWT_TOKEN_KEY: 'a'.repeat(64),
      DB_HOST: 'localhost',
      DB_USER: 'root',
      DB_NAME: 'testdb',
      NODE_ENV: 'development',
    });
    expect(exitCalled).toBe(false);
  });

  test('fails when JWT_TOKEN_KEY is missing', () => {
    const saved = process.env.JWT_TOKEN_KEY;
    delete process.env.JWT_TOKEN_KEY;
    const { exitCalled, errorOutput } = runWithEnv({
      DB_HOST: 'localhost', DB_USER: 'root', DB_NAME: 'testdb',
    });
    process.env.JWT_TOKEN_KEY = saved;
    expect(exitCalled).toBe(true);
    expect(errorOutput).toMatch(/JWT_TOKEN_KEY/);
  });

  test('fails when JWT_TOKEN_KEY is the insecure default "THEWEBTOKEN"', () => {
    const { exitCalled, errorOutput } = runWithEnv({
      JWT_TOKEN_KEY: 'THEWEBTOKEN',
      DB_HOST: 'localhost', DB_USER: 'root', DB_NAME: 'testdb',
    });
    expect(exitCalled).toBe(true);
    expect(errorOutput).toMatch(/insecure/i);
  });

  test('fails when JWT_TOKEN_KEY is shorter than 32 characters', () => {
    const { exitCalled, errorOutput } = runWithEnv({
      JWT_TOKEN_KEY: 'tooshort',
      DB_HOST: 'localhost', DB_USER: 'root', DB_NAME: 'testdb',
    });
    expect(exitCalled).toBe(true);
    expect(errorOutput).toMatch(/too short/i);
  });

  test('fails when DB_HOST is missing', () => {
    const saved = process.env.DB_HOST;
    delete process.env.DB_HOST;
    const { exitCalled } = runWithEnv({
      JWT_TOKEN_KEY: 'a'.repeat(64),
      DB_USER: 'root', DB_NAME: 'testdb',
    });
    if (saved !== undefined) process.env.DB_HOST = saved;
    expect(exitCalled).toBe(true);
  });

  test('passes with 32-char JWT key (minimum length)', () => {
    const { exitCalled } = runWithEnv({
      JWT_TOKEN_KEY: 'a'.repeat(32),
      DB_HOST: 'localhost', DB_USER: 'root', DB_NAME: 'testdb',
      NODE_ENV: 'development',
    });
    expect(exitCalled).toBe(false);
  });

  test('fails when EXPOSE_DEV_OTP=true in production', () => {
    const { exitCalled, errorOutput } = runWithEnv({
      JWT_TOKEN_KEY: 'a'.repeat(64),
      DB_HOST: 'localhost', DB_USER: 'root', DB_NAME: 'testdb',
      NODE_ENV: 'production', EXPOSE_DEV_OTP: 'true',
    });
    expect(exitCalled).toBe(true);
    expect(errorOutput).toMatch(/EXPOSE_DEV_OTP/);
  });

  test('fails on a non-boolean feature flag', () => {
    const { exitCalled, errorOutput } = runWithEnv({
      JWT_TOKEN_KEY: 'a'.repeat(64),
      DB_HOST: 'localhost', DB_USER: 'root', DB_NAME: 'testdb',
      NODE_ENV: 'development', FORCE_HTTPS: 'yes',
    });
    expect(exitCalled).toBe(true);
    expect(errorOutput).toMatch(/FORCE_HTTPS/);
  });
});
