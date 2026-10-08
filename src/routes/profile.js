// routes/profile.js
// ------------------------------------------------------------
// GET /api/profile  -> your profile
// PUT /api/profile  -> change any profile fields (send only what changes)
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { validate, asyncHandler } = require('../utils/http');
const { today } = require('../utils/dates');

const router = express.Router();

// The rules for each profile field
const PROFILE_RULES = {
  sex: { type: 'string', oneOf: ['male', 'female'] },
  age: { type: 'integer', min: 18, max: 100 }, // RaphAi is for adults (18+) only
  height_cm: { type: 'number', min: 100, max: 250 },
  weight_kg: { type: 'number', min: 25, max: 300 },
  activity_factor: { type: 'number', min: 1.2, max: 1.9 },
  goal: { type: 'string', oneOf: ['lose', 'maintain', 'gain'] },
  pace_kg_week: { type: 'number', min: 0, max: 1 },
  income: { type: 'number', min: 0 }, // monthly, in ₹
  neck_cm: { type: 'number', min: 20, max: 80 },
  waist_cm: { type: 'number', min: 40, max: 200 },
  hip_cm: { type: 'number', min: 50, max: 200 },
  step_goal: { type: 'integer', min: 1000, max: 50000 },
};

function getProfile(userId) {
  return db.get('SELECT * FROM profiles WHERE user_id = $1', [userId]);
}

router.get('/', asyncHandler(async (req, res) => {
  res.json({
    profile: await getProfile(req.user.id),
    activity_factor_guide: {
      1.2: 'Sitting most of the day',
      1.375: 'Light exercise 1–3 days/week',
      1.55: 'Moderate exercise 3–5 days/week',
      1.725: 'Hard exercise 6–7 days/week',
      1.9: 'Very hard exercise or physical job',
    },
  });
}));

router.put('/', asyncHandler(async (req, res) => {
  // partial: true -> you can send just one field
  const changes = validate(req.body, PROFILE_RULES, { partial: true });
  const fields = Object.keys(changes);

  if (fields.length) {
    // Builds: UPDATE profiles SET age = @age, weight_kg = @weight_kg WHERE user_id = @user_id
    // (db.js turns the @names into $1, $2 ...). Field names come from PROFILE_RULES only.
    const setPart = fields.map((f) => `${f} = @${f}`).join(', ');
    await db.run(`UPDATE profiles SET ${setPart} WHERE user_id = @user_id`, { ...changes, user_id: req.user.id });

    // If weight changed, also save it in the weight history
    if (changes.weight_kg) {
      await db.run('INSERT INTO weight_logs (user_id, date, weight_kg) VALUES ($1, $2, $3)', [req.user.id, today(), changes.weight_kg]);
    }
  }
  res.json({ profile: await getProfile(req.user.id) });
}));

module.exports = { router, getProfile };
