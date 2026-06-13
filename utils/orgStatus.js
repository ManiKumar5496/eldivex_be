/**
 * orgStatus.js — single source of truth for the organisation kill-switch.
 *
 * Every login/enforcement path (web-admin login, mobile login, caregiver and
 * client OTP, and the orgStatusGate middleware) MUST decide "can this org
 * operate?" the same way. Previously some used a blocklist (only suspended/
 * cancelled blocked) and others an allowlist (only active/trial allowed); they
 * diverged on edge statuses (expired, NULL), which let a reactivated org's
 * super-admin back in while caregivers/clients stayed locked out.
 *
 * Rule: a login is allowed iff edx_organizations.status is active or trial.
 * Everything else — suspended, cancelled, expired, NULL, unknown — is blocked.
 */

const LOGIN_ALLOWED_STATUSES = ['active', 'trial'];

/** True when an org with this status must NOT be allowed to log in / operate. */
const isOrgLoginBlocked = (status) => !LOGIN_ALLOWED_STATUSES.includes(status);

const ORG_SUSPENDED_RESPONSE = {
  code: 'ORG_SUSPENDED',
  message: 'Your organisation account has been suspended. Please contact support.',
};

/**
 * Map a subscription status to the edx_organizations.status it should produce.
 * The org enum has no 'expired', so an expired subscription blocks the org by
 * mapping to 'suspended'. Keeps the org row in lock-step with the subscription
 * so the kill-switch every login reads is never stale.
 */
const SUB_TO_ORG_STATUS = {
  active:    'active',
  trial:     'trial',
  suspended: 'suspended',
  expired:   'suspended',
  cancelled: 'cancelled',
};
const orgStatusForSubscription = (subStatus) =>
  SUB_TO_ORG_STATUS[subStatus] ?? 'suspended';

module.exports = {
  LOGIN_ALLOWED_STATUSES,
  isOrgLoginBlocked,
  ORG_SUSPENDED_RESPONSE,
  orgStatusForSubscription,
};
