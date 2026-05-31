function applyBranchFilter(query, user, column) {
    // Super Admin bypass
    if (user.role_id === 1) {
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