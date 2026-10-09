// routes/export.js
// ------------------------------------------------------------
// GET /api/export  -> ALL of your data as one JSON file.
// Your data is yours: you can take it with you any time.
// (We never include the password hash.)
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../utils/http');
const { logSecurity } = require('../services/securityLog');

const router = express.Router();

// Tables that have a user_id column, and the name used in the export
const USER_TABLES = {
  profile: 'profiles',
  food_logs: 'food_logs',
  food_favourites: 'food_favourites',
  steps: 'step_logs',
  workouts: 'workouts',
  water: 'water_logs',
  sleep: 'sleep_logs',
  mood: 'mood_logs',
  weight: 'weight_logs',
  reminder_settings: 'reminder_settings',
  expenses: 'expenses',
  budgets: 'budgets',
  savings_goals: 'savings_goals',
  bills: 'bills',
  subscription: 'subscriptions',
  activity_daily: 'activity_daily',
  raphscore_daily: 'raphscore_daily',
};

// Row order per table (default: ORDER BY id, oldest first)
const EXPORT_ORDER = {
  profiles: '',
  reminder_settings: '',
  subscriptions: '',
  food_favourites: ' ORDER BY food_id',
  step_logs: ' ORDER BY date',
  activity_daily: ' ORDER BY date',
  raphscore_daily: ' ORDER BY date',
  budgets: ' ORDER BY month, category',
};

router.get('/', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const data = {
    exported_at: new Date().toISOString(),
    app: 'HeartPurse',
    user: await db.get('SELECT id, name, email, created_at FROM users WHERE id = $1', [userId]),
  };
  for (const [key, table] of Object.entries(USER_TABLES)) {
    // Same row order as the old SQLite version gave
    const order = EXPORT_ORDER[table] === undefined ? ' ORDER BY id' : EXPORT_ORDER[table];
    data[key] = await db.all(`SELECT * FROM ${table} WHERE user_id = $1${order}`, [userId]);
  }
  // Bill payments are linked to bills, not directly to the user
  data.bill_payments = await db.all('SELECT p.* FROM bill_payments p JOIN bills b ON b.id = p.bill_id WHERE b.user_id = $1 ORDER BY p.bill_id, p.month', [userId]);
  // Foods the user added themselves
  data.custom_foods = await db.all('SELECT * FROM foods WHERE created_by = $1 ORDER BY id', [userId]);
  // Consent records (what you agreed to, which version, when)
  data.consents = await db.all(`SELECT type, version, granted, created_at FROM consents
    WHERE user_id = $1 AND account_deleted_at IS NULL ORDER BY created_at, id`, [userId]);
  // Google Play subscriptions (without Google's raw answer)
  data.google_play_purchases = await db.all(`SELECT product_id, base_plan_id, offer_id, plan, period, subscription_state,
    expires_at, auto_renew, in_trial, latest_order_id, created_at, updated_at
    FROM google_play_purchases WHERE user_id = $1 ORDER BY created_at`, [userId]);

  await logSecurity('export', { req, userId });
  res.setHeader('Content-Disposition', `attachment; filename="heartpurse-export-${userId}.json"`);
  res.json(data);
}));

module.exports = router;
