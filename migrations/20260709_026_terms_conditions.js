/**
 * 026 — Terms & Conditions (versioned) + per-user acceptance.
 *
 * Two tables:
 *   edx_terms                     — one row per published T&C version. `is_active`
 *                                   marks the single version currently in force
 *                                   for a given `audience`. Content is immutable
 *                                   once published; a change means a NEW row with
 *                                   a higher `version`, which forces re-acceptance.
 *   edx_web_user_terms_acceptance — records that a specific web user accepted a
 *                                   specific terms version, with an audit trail
 *                                   (timestamp, IP, user-agent). Unique per
 *                                   (user, terms) so acceptance is idempotent.
 *
 * The web admin app checks acceptance of the active `web` version at login and
 * blocks entry to the dashboard until the user has read and approved it.
 *
 * NOTE: audience is global (not org-scoped) — the platform T&C is authored by the
 * SaaS operator and applies to every tenant's web users equally. Acceptance rows
 * ARE org-tagged so each tenant can audit its own users' consent.
 */

const TERMS_V1_TITLE = 'Eldivex Platform — Terms & Conditions of Use';

// Full mandatory content for the first published version. Markdown-ish plain
// text; the client renders it in a scrollable reader. Keep in sync conceptually
// with the Privacy Policy. Placeholders in [square brackets] must be replaced
// with the operating entity's real legal details before commercial launch.
const TERMS_V1_CONTENT = `ELDIVEX PLATFORM — TERMS & CONDITIONS OF USE
Version 1.0  |  Effective date: 09 July 2026

IMPORTANT — PLEASE READ CAREFULLY. These Terms & Conditions ("Terms") are a
legally binding agreement between you and the operator of the Eldivex platform
("Eldivex", "we", "us", "our"). By accessing or using the Eldivex web
administration application (the "Platform"), or by clicking "I Agree", you
confirm that you have read, understood and agree to be bound by these Terms on
behalf of yourself and the organisation you represent. If you do not agree, you
must not access or use the Platform.

1. DEFINITIONS
1.1 "Organisation" or "Tenant" means the healthcare provider, agency or business
    entity that has subscribed to the Platform and within whose account you
    operate.
1.2 "Authorised User" means an individual (administrator, staff member, manager
    or operator) granted access to the Platform under an Organisation's account.
1.3 "Caregiver" / "Health Professional (HP)" means a care worker managed within
    the Platform.
1.4 "Client" / "Patient" means an end customer or care recipient whose records
    are managed within the Platform.
1.5 "Content" means all data, records, text, files and information submitted to
    or generated within the Platform.
1.6 "Personal Data" and "Sensitive Personal Data" have the meanings given under
    applicable data-protection law, including the Digital Personal Data
    Protection Act, 2023 (India) and, where applicable, the Information
    Technology (Reasonable Security Practices) Rules, 2011.

2. ACCEPTANCE AND ELIGIBILITY
2.1 You must be at least 18 years of age and legally capable of entering into a
    binding contract.
2.2 If you accept these Terms on behalf of an Organisation, you represent that
    you are duly authorised to bind that Organisation.
2.3 First-time access requires that you read these Terms in full (by scrolling to
    the end) and provide affirmative acceptance. Continued use after any updated
    version is published requires renewed acceptance.

3. DESCRIPTION OF THE SERVICE
3.1 The Platform is a multi-tenant, software-as-a-service application for
    managing home-healthcare and related operations, including but not limited to
    caregiver/health-professional records, client and patient records, service
    bookings and scheduling, attendance, payouts, billing, invoicing, accounts,
    hostels, reporting and organisational settings.
3.2 The Platform is an operational and administrative tool ONLY. It is not a
    medical device, does not provide medical advice, diagnosis or treatment, and
    must not be relied upon for clinical decision-making. All clinical
    responsibility rests with the Organisation and its qualified personnel.
3.3 We may add, modify or discontinue features at our discretion, provided that
    material reductions to core functionality of a paid subscription will be
    communicated in advance where reasonably practicable.

4. ACCOUNTS, ROLES AND ACCESS CONTROL
4.1 Access to the Platform is role-based. The Organisation's administrator is
    responsible for provisioning Authorised Users and assigning appropriate
    roles and module permissions.
4.2 You are responsible for maintaining the confidentiality of your login
    credentials and for all activity conducted under your account. You must not
    share credentials, and you must notify us immediately of any unauthorised
    access or suspected security breach.
4.3 You must not attempt to elevate your own privileges, access data outside your
    Organisation, circumvent access controls, or assign a role granting access
    beyond that held by the granting user.
4.4 Each Organisation's data is logically isolated. You must not attempt to
    access, enumerate, or interfere with any data belonging to another
    Organisation.

5. TENANT DATA OWNERSHIP AND DATA-PROTECTION ROLES
5.1 As between the parties, the Organisation owns all Content it submits.
5.2 For Personal Data of Caregivers, Clients and Patients, the Organisation acts
    as the data fiduciary/controller and Eldivex acts as the data
    processor, processing such data only to provide the Platform and per the
    Organisation's lawful instructions.
5.3 The Organisation warrants that it has obtained all necessary consents and has
    a lawful basis to collect, upload and process Personal Data (including
    Sensitive Personal Data such as health information) within the Platform, and
    to permit our processing of it as described in these Terms and the Privacy
    Policy.
5.4 We will process, retain and delete Personal Data in accordance with the
    Privacy Policy and applicable law, and will assist the Organisation, so far
    as reasonably possible, in responding to data-principal rights requests.

6. ACCEPTABLE USE
6.1 You agree not to: (a) use the Platform for any unlawful, fraudulent or
    harmful purpose; (b) upload malware or malicious code; (c) probe, scan or
    test the vulnerability of the Platform without prior written authorisation;
    (d) reverse engineer, decompile or attempt to derive source code except as
    permitted by law; (e) resell, sublicense or provide the Platform to third
    parties outside your Organisation; (f) use automated means to extract data
    beyond the features provided; or (g) upload content that infringes the rights
    of others.
6.2 You must comply with all applicable laws and professional/regulatory
    obligations governing the provision of healthcare and the handling of
    patient information.

7. CONFIDENTIALITY
7.1 Each party may access confidential information of the other. Confidential
    information must be protected with reasonable care and used only to perform
    obligations under these Terms. This clause survives termination.

8. SUBSCRIPTION, FEES, TAXES AND BILLING
8.1 Access to the Platform is provided on a subscription basis according to the
    plan selected by the Organisation. Applicable fees, billing cycles and plan
    limits are as set out in the Organisation's subscription.
8.2 Fees are exclusive of taxes; applicable taxes (including GST) will be added
    where required. Fees are non-refundable except as expressly stated or
    required by law.
8.3 Late or non-payment may result in downgrade, suspension or termination of the
    account as described in Clause 11.
8.4 Payment processing may be handled by third-party payment providers. Your use
    of those services is subject to their terms; we are not responsible for the
    acts or omissions of payment providers.

9. INTELLECTUAL PROPERTY
9.1 The Platform, including its software, design, and documentation, and all
    associated intellectual-property rights, are and remain the exclusive
    property of Eldivex and its licensors. These Terms grant only a limited,
    non-exclusive, non-transferable, revocable right to use the Platform during
    the subscription term.
9.2 You retain all rights in your Content. You grant us a limited licence to host
    and process your Content solely to provide the Platform.

10. SERVICE AVAILABILITY AND SUPPORT
10.1 We aim to provide reliable access but do not warrant uninterrupted or
     error-free operation. Planned maintenance will be communicated where
     practicable.
10.2 Support is provided through the channels associated with the Organisation's
     plan.

11. SUSPENSION AND TERMINATION
11.1 We may suspend or restrict access immediately where: (a) required by law;
     (b) necessary to protect the security or integrity of the Platform or other
     tenants; (c) fees are overdue; or (d) these Terms are materially breached.
11.2 A suspended Organisation's Authorised Users will be denied access until the
     account is reinstated. We will use reasonable efforts to notify the
     Organisation's administrator of a suspension.
11.3 Either party may terminate a subscription in accordance with the
     subscription agreement. On termination, access ceases and Content will be
     handled (returned/deleted) per the Privacy Policy and applicable law.

12. SECURITY
12.1 We implement reasonable technical and organisational measures to protect the
     Platform. However, no system is perfectly secure, and you share
     responsibility by safeguarding credentials and configuring access
     appropriately.
12.2 You must promptly report any actual or suspected security incident to us.

13. THIRD-PARTY SERVICES
13.1 The Platform may integrate with third-party services (e.g. SMS, email,
     payment gateways, cloud hosting). We are not responsible for third-party
     services and disclaim liability for their performance.

14. COMMUNICATIONS AND NOTIFICATIONS
14.1 By using the Platform you consent to receive operational communications
     (including one-time passwords, transactional email and SMS) necessary to
     provide the service. These are not marketing communications.

15. DISCLAIMER OF WARRANTIES
15.1 THE PLATFORM IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY
     KIND, WHETHER EXPRESS, IMPLIED OR STATUTORY, INCLUDING IMPLIED WARRANTIES OF
     MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT, TO
     THE MAXIMUM EXTENT PERMITTED BY LAW.

16. LIMITATION OF LIABILITY
16.1 TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE FOR ANY
     INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR LOSS
     OF PROFITS, REVENUE, DATA OR GOODWILL.
16.2 OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THESE TERMS WILL
     NOT EXCEED THE TOTAL SUBSCRIPTION FEES PAID BY THE ORGANISATION TO US IN THE
     TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.

17. INDEMNIFICATION
17.1 The Organisation will indemnify and hold us harmless from claims arising out
     of (a) its Content, (b) its use of the Platform in breach of these Terms or
     law, or (c) its failure to obtain required consents for Personal Data.

18. CHANGES TO THESE TERMS
18.1 We may update these Terms from time to time. When we publish a new version,
     you will be required to review and accept it before continuing to use the
     Platform. The "Effective date" above indicates the current version.

19. GOVERNING LAW AND DISPUTE RESOLUTION
19.1 These Terms are governed by the laws of India. Subject to applicable law,
     the courts at [City, State], India shall have exclusive jurisdiction.
19.2 The parties will attempt in good faith to resolve disputes amicably before
     initiating formal proceedings.

20. GRIEVANCE AND CONTACT
20.1 For questions, data-protection requests or grievances, contact the Grievance
     Officer at [grievance@eldivex.example] / [postal address]. We will respond
     within the timelines required by applicable law.

21. MISCELLANEOUS
21.1 If any provision is held unenforceable, the remaining provisions continue in
     effect. Our failure to enforce a right is not a waiver. You may not assign
     these Terms without our consent; we may assign to an affiliate or successor.
     Neither party is liable for delays caused by events beyond its reasonable
     control (force majeure). These Terms, together with the subscription
     agreement and Privacy Policy, constitute the entire agreement between the
     parties regarding the Platform.

BY CLICKING "I AGREE", YOU ACKNOWLEDGE THAT YOU HAVE READ AND UNDERSTOOD THESE
TERMS AND AGREE TO BE BOUND BY THEM.`;

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('edx_terms'))) {
    await knex.schema.createTable('edx_terms', (t) => {
      t.increments('id').primary();
      t.integer('version').notNullable();            // monotonically increasing
      t.string('audience', 20).notNullable().defaultTo('web'); // web | client | hp | all
      t.string('title', 200).notNullable();
      t.text('content', 'longtext').notNullable();
      t.boolean('is_active').notNullable().defaultTo(false);
      t.string('effective_from', 30).nullable();
      t.string('created_on', 30).nullable();
      t.index(['audience', 'is_active'], 'idx_terms_audience_active');
      t.unique(['audience', 'version'], 'uq_terms_audience_version');
    });
  }

  if (!(await knex.schema.hasTable('edx_web_user_terms_acceptance'))) {
    await knex.schema.createTable('edx_web_user_terms_acceptance', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().notNullable();
      t.integer('org_id').unsigned().notNullable().defaultTo(1);
      t.integer('terms_id').unsigned().notNullable();
      t.integer('terms_version').notNullable();
      t.string('accepted_at', 30).notNullable();
      t.string('ip_address', 64).nullable();
      t.string('user_agent', 512).nullable();
      t.index(['user_id'], 'idx_uta_user');
      t.index(['org_id'], 'idx_uta_org');
      t.unique(['user_id', 'terms_id'], 'uq_uta_user_terms');
    });
  }

  // Seed the first active web version if none exists yet.
  const existing = await knex('edx_terms')
    .where({ audience: 'web', version: 1 })
    .first('id');
  if (!existing) {
    const now = new Date().toISOString();
    await knex('edx_terms').insert({
      version:        1,
      audience:       'web',
      title:          TERMS_V1_TITLE,
      content:        TERMS_V1_CONTENT,
      is_active:      true,
      effective_from: now,
      created_on:     now,
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('edx_web_user_terms_acceptance');
  await knex.schema.dropTableIfExists('edx_terms');
};
