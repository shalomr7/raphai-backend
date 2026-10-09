// utils/money.js
// ------------------------------------------------------------
// Money is summed in INTEGER paise (1 ₹ = 100 paise) so totals never drift
// (0.1 + 0.2 problems). The *_paise columns are the authoritative values;
// rupee fields stay in API responses for compatibility.
// ------------------------------------------------------------
const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
// Integer paise -> rupees (exact to 2 decimals)
const rupees = (paise) => Math.round(Number(paise || 0)) / 100;
// Read a row's paise value, falling back to its rupee column
const paiseOf = (row, field = 'amount') => {
  const p = row[`${field}_paise`];
  return p === null || p === undefined ? toPaise(row[field]) : Number(p);
};
const sumPaise = (rows, field = 'amount') => rows.reduce((s, r) => s + paiseOf(r, field), 0);
const inr = (paise) => '₹' + rupees(paise).toLocaleString('en-IN', { maximumFractionDigits: 2 });

module.exports = { toPaise, rupees, paiseOf, sumPaise, inr };
