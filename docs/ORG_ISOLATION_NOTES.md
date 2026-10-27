# SaaS Org Data Isolation — Notes & Checklist

This is a multi-tenant SaaS. **No org may ever see or mutate another org's data.**
This doc records the isolation rule, the leaks that were fixed, the legitimate
exceptions, and a checklist for every new endpoint.

## The rule

1. **`org_id` comes from the JWT, never the client.** Use `getOrgId(req)` from
   [`utils/orgScope.js`](../utils/orgScope.js). Never trust an `org_id` in
   `req.query` / `req.body` for scoping a tenant query — a forged value would
   pull another tenant's rows.
2. **Every read/write on a tenant table is org-scoped.**
   - Lists: `orgQuery(req, table)` or `.where('<alias>.org_id', getOrgId(req))`.
   - Inserts: `withOrg(req, {...})`.
   - Single-record update/delete/toggle: include `org_id` in the WHERE clause —
     not just the primary key. A bare `.where({ id })` lets one tenant mutate
     another's row by guessing ids.
   - Read-after-insert: re-fetch with `{ id, org_id: getOrgId(req) }`.
3. **An update/toggle that matches 0 rows should 404**, not silently succeed.

## Leaks fixed (June 2026)

All in `controllers/web_app/` unless noted:

- `masterTableController.createService` — duplicate-name check was global
  (`db('edx_master_services').where({name})`); now `orgQuery`-scoped, so two
  tenants can use the same service name.
- `masterTableController.updateService` / `toggleServiceStatus` — read + update
  by `id` only; now `{ id, org_id }`, returns 404 on cross-org id.
- `masterTableController.updateBranch` / `toggleBranchStatus` — by `br_id` only;
  now `{ br_id, org_id }`, returns 404 on cross-org id.
- `masterTableController.getAddress` + `models/web_app/masterTablesModel.js`
  `getAddressModel` — returned **all** addresses system-wide; now filtered by
  `org_id` derived from the token.
- `accountsController` read-after-insert for receipt / write-off / credit note /
  insurance claim — re-fetched by `id` only; now `{ id, org_id }`.
- `userController.getUserDetails` / `getWebEmpDetails` — passed `req.query`
  straight to the model, trusting a client `?org_id=`; now overridden with
  `getOrgId(req)`. (`userModel` still accepts `org_id` as a filter; the
  controller is the trust boundary.)

## Legitimate cross-org exceptions (owner/super-admin only)

These intentionally span all orgs and must stay behind the `requireOwner` gate:

- `orgController.getOrganisations` (`/api/getOrganisations`) — the owner's
  org-management screen. Frontend `OrganisationsController` is documented as
  spanning all orgs.
- `/api/saas/*` (`saasAccountsController`, owner audit trail) — platform billing
  and account administration.

## Frontend note

Module list filtering (search boxes, dropdowns) is **client-side** over the list
the API returns. This is safe *only because* the API is org-scoped — filtering
never adds isolation, it only narrows an already-scoped list. If a list endpoint
ever leaks cross-org rows, the UI filter will faithfully display the leak. Keep
the backend rule above as the single source of isolation.

## Checklist for every new endpoint

- [ ] Does it touch a tenant table? If yes, is `org_id` from `getOrgId(req)`?
- [ ] Lists scoped with `orgQuery` / `.where(org_id)`?
- [ ] Inserts use `withOrg`?
- [ ] Update/delete/toggle WHERE includes `org_id`, not just the id?
- [ ] Read-after-insert re-fetches with `org_id`?
- [ ] 0-row update returns 404 instead of silent success?
- [ ] No scoping decision trusts a client-supplied `org_id`?
- [ ] If it intentionally spans orgs, is it behind `requireOwner`?
