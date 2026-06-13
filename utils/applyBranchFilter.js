function applyBranchFilter(query, user, column) {
    // Super Admin bypass
    if (user.role_id === 1) {
      return query;
    }

    // Full-access bypass: any user granted 'all' branches (e.g. a per-org
    // Super Admin) sees every branch, without depending on the literal role id 1.
    if (user.branch_access === 'all') {
      return query;
    }

    if (!user.branch_access) {
      return query;
    }
  
    const branches = user.branch_access
      .split(',')
      .map(Number);
  
    return query.whereIn(column, branches);
  }
  
  module.exports = applyBranchFilter;