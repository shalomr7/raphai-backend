// seed/sql.js — the SQL that puts the built-in foods in and keeps them current.
// Used by db.init() (and by test/accuracy_api.js on an in-memory Postgres).
//  1) INSERT foods not there yet (by name).
//  2) UPDATE seeded rows (created_by IS NULL) whose values differ from the seed
//     files, so a corrected value reaches databases that already have the food.
const baseFoods = require('./foods');
const regionalFoods = require('./foods_regional');

function foodSeedQueries(list = baseFoods.concat(regionalFoods)) {
  const values = [];
  const rows = list.map((f, i) => {
    values.push(f.name, f.serving, f.kcal, f.protein_g, f.carbs_g, f.fat_g);
    const b = i * 6;
    return `($${b + 1}::text, $${b + 2}::text, $${b + 3}::float8, $${b + 4}::float8, $${b + 5}::float8, $${b + 6}::float8, ${i})`;
  });
  const v = `(VALUES ${rows.join(', ')}) AS v(name, serving, kcal, protein_g, carbs_g, fat_g, pos)`;
  return [
    { text: `INSERT INTO foods (name, serving, kcal, protein_g, carbs_g, fat_g)
       SELECT v.name, v.serving, v.kcal, v.protein_g, v.carbs_g, v.fat_g
       FROM ${v}
       WHERE NOT EXISTS (SELECT 1 FROM foods f WHERE f.name = v.name)
       ORDER BY v.pos
       ON CONFLICT (name) DO NOTHING`, values },
    { text: `UPDATE foods f SET serving = v.serving, kcal = v.kcal, protein_g = v.protein_g, carbs_g = v.carbs_g, fat_g = v.fat_g
       FROM ${v}
       WHERE f.name = v.name AND f.created_by IS NULL
         AND (f.serving, f.kcal, f.protein_g, f.carbs_g, f.fat_g) IS DISTINCT FROM (v.serving, v.kcal, v.protein_g, v.carbs_g, v.fat_g)`, values },
  ];
}

module.exports = { foodSeedQueries, baseFoods, regionalFoods };
