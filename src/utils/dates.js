// utils/dates.js
// ------------------------------------------------------------
// "What is today?" depends on the timezone. The server might run in
// another country, so we always use APP_TZ (default Asia/Kolkata).
// ------------------------------------------------------------

const TZ = () => process.env.APP_TZ || 'Asia/Kolkata';

// Today's date as 'YYYY-MM-DD' in India
function today() {
  // 'en-CA' formats dates as YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ() });
}

// This month as 'YYYY-MM'
function thisMonth() {
  return today().slice(0, 7);
}

// Day of the month (1-31) today in India
function dayOfMonth() {
  return Number(today().slice(8, 10));
}

// Number of days in a month 'YYYY-MM'
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// Add n days to a 'YYYY-MM-DD' date (n can be negative)
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Hour of the day (0-23) right now in India (APP_TZ)
function hourNow() {
  const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ() }).format(new Date());
  return Number(h) % 24;
}

// Day of the week for a 'YYYY-MM-DD' date: 0 = Sunday ... 6 = Saturday
function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

module.exports = { today, thisMonth, dayOfMonth, daysInMonth, addDays, hourNow, weekday };
