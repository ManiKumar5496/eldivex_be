/**
 * smsService.js — Fast2SMS wrapper for OTP and SMS delivery
 *
 * Usage:
 *   const { sendOTP, sendSMS } = require('./smsService');
 *   await sendOTP('9876543210', '482910');
 *
 * If SMS_API_KEY is not set the call is a no-op (logs a warning).
 * All callers MUST wrap in try/catch — a failed SMS must never fail an API request.
 *
 * Fast2SMS docs: https://docs.fast2sms.com/
 */

const axios = require('axios');

const FAST2SMS_URL = 'https://www.fast2sms.com/dev/bulkV2';

/**
 * Send a 6-digit OTP via Fast2SMS OTP route.
 * Uses the default OTP template: "Your OTP is {#var#}"
 *
 * @param {string} phone  10-digit Indian mobile number (no country code)
 * @param {string} otp    6-digit OTP string
 */
async function sendOTP(phone, otp) {
  if (!process.env.SMS_API_KEY) {
    console.warn(`[smsService] SMS_API_KEY not set — skipping OTP SMS to ${phone}`);
    return;
  }

  // Normalise phone: strip +91 prefix if present
  const normalised = String(phone).replace(/^\+?91/, '').replace(/\D/g, '');

  if (normalised.length !== 10) {
    console.warn(`[smsService] Invalid phone number "${phone}" — skipping OTP SMS`);
    return;
  }

  const response = await axios.post(FAST2SMS_URL, null, {
    params: {
      authorization:    process.env.SMS_API_KEY,
      variables_values: otp,
      route:            'otp',
      numbers:          normalised,
    },
    headers: { 'cache-control': 'no-cache' },
    timeout: 10000, // 10s
  });

  if (response.data?.return === false) {
    throw new Error(`Fast2SMS error: ${JSON.stringify(response.data)}`);
  }
}

/**
 * Send a plain-text SMS via Fast2SMS quick/promotional route.
 *
 * @param {string} phone    10-digit Indian mobile number
 * @param {string} message  Message text (max 160 chars recommended)
 */
async function sendSMS(phone, message) {
  if (!process.env.SMS_API_KEY) {
    console.warn(`[smsService] SMS_API_KEY not set — skipping SMS to ${phone}`);
    return;
  }

  const normalised = String(phone).replace(/^\+?91/, '').replace(/\D/g, '');

  if (normalised.length !== 10) {
    console.warn(`[smsService] Invalid phone number "${phone}" — skipping SMS`);
    return;
  }

  const response = await axios.post(FAST2SMS_URL, null, {
    params: {
      authorization: process.env.SMS_API_KEY,
      message:       message,
      route:         'q',   // quick/transactional route
      numbers:       normalised,
      flash:         0,
    },
    headers: { 'cache-control': 'no-cache' },
    timeout: 10000,
  });

  if (response.data?.return === false) {
    throw new Error(`Fast2SMS error: ${JSON.stringify(response.data)}`);
  }
}

module.exports = { sendOTP, sendSMS };
