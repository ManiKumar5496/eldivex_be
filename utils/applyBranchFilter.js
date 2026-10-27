/**
 * Restricts a query to the branches the user may see.
 *
 * Unrestricted ONLY for role id 1 or branch_access === 'all' (what
 * createOrganisation gives each org's admin). Anything else is treated as an
 * explicit CSV of branch ids; null, empty, 'NA' or non-numeric values grant NO
 * branches (previously null/empty meant "every branch", which let tokens
 * without branch scope read the whole org).
 */
function applyBranchFilter(query, user, column) {
  if (!user) return query.whereRaw('1 = 0');

  // Super Admin bypass
  if (Number(user.role_id) === 1) {
    return query;
  }

  // Full-access bypass: any user granted 'all' branches (e.g. a per-org
  // Super Admin) sees every branch, without depending on the literal role id 1.
  if (String(user.branch_access ?? '').trim().toLowerCase() === 'all') {
    return query;
  }

  const branches = String(user.branch_access ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));

  if (branches.length === 0) return query.whereRaw('1 = 0');

  return query.whereIn(column, branches);
}

module.exports = applyBranchFilter;
