// utils/dateTime.js

function getCurrentDateTime() {
    const now = new Date();
  
    return now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0');
  }
  
// Converts any date string (including ISO 8601) to 'YYYY-MM-DD' for MySQL DATE columns
function toMysqlDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Returns a 'YYYY-MM-DD' string for (today + days), using the LOCAL calendar
// date. Avoids the off-by-one that `new Date().toISOString().split('T')[0]`
// causes in timezones ahead of UTC (e.g. IST), where the UTC date can be a day
// behind the local date in the evening.
function mysqlDateAddDays(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

  module.exports = { getCurrentDateTime, toMysqlDate, mysqlDateAddDays };
