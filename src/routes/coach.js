// routes/coach.js
// ------------------------------------------------------------
// POST /api/coach   { "question": "how many calories left?" }
// A SIMPLE rule-based coach (no AI model). It looks for keywords in
// the question and answers from the user's own data.
// Understands:
//   - "calories left"      -> calories left today
//   - "food spend"         -> money spent on Food + Groceries this month
//   - "how much to save"   -> 20% rule + savings goals
//   - "protein foods"      -> best protein foods from the food table
// Needs the Pro plan (see requirePlan in app.js).
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const calc = require('../utils/calc');
const { validate, asyncHandler } = require('../utils/http');
const summary = require('../services/summary');

const router = express.Router();

// Format a number as Indian rupees, e.g. 125000 -> ₹1,25,000
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

// Each rule: words to look for + a function that writes the answer
const RULES = [
  {
    topic: 'calories_left',
    match: (q) => q.includes('calorie') || q.includes('kcal'),
    async answer(userId) {
      const day = await summary.healthDay(userId);
      if (!day.targets) return { text: 'Fill in your profile (sex, age, height, weight) first, then I can tell you your calories.' };
      const left = day.calories_left;
      const text = left >= 0
        ? `You have about ${left} kcal left today (target ${day.targets.calories}, eaten ${day.eaten.kcal}, burned ${day.workout_kcal} in workouts).`
        : `You are ${-left} kcal over today's target of ${day.targets.calories}. A 20-minute walk burns roughly 100 kcal.`;
      return { text, data: { calories_left: left, target: day.targets.calories, eaten: day.eaten.kcal } };
    },
  },
  {
    topic: 'food_spend',
    match: (q) => (q.includes('spend') || q.includes('spent') || q.includes('expense')) && (q.includes('food') || q.includes('eat') || q.includes('grocer')),
    async answer(userId) {
      const m = await summary.wealthMonth(userId);
      const get = (cat) => (m.by_category.find((c) => c.category === cat) || { total: 0 }).total;
      const food = get('Food'); const groceries = get('Groceries');
      const total = food + groceries;
      const share = m.spent > 0 ? calc.round((total / m.spent) * 100) : 0;
      return {
        text: `This month you spent ${inr(total)} on food (${inr(food)} eating out/ordering + ${inr(groceries)} groceries). That is ${share}% of all your spending.`,
        data: { food, groceries, total, share_pct: share },
      };
    },
  },
  {
    topic: 'how_much_to_save',
    match: (q) => q.includes('save') || q.includes('saving'),
    async answer(userId) {
      const m = await summary.wealthMonth(userId);
      if (!m.income) return { text: 'Add your monthly income to your profile and I can suggest how much to save.' };
      const suggested = m.income * 0.2;
      const savedSoFar = m.income - m.spent;
      const goals = await db.all('SELECT * FROM savings_goals WHERE user_id = $1 AND saved < target ORDER BY id', [userId]);
      let text = `Using the 50/30/20 rule, try to save ${inr(suggested)} a month (20% of ${inr(m.income)}). `
        + `So far this month, income minus spending is ${inr(savedSoFar)}.`;
      if (goals.length) {
        const g = goals[0];
        text += ` Your goal "${g.name}" needs ${inr(g.target - g.saved)} more.`;
      }
      return { text, data: { suggested_monthly: calc.round(suggested), income: m.income, spent: m.spent } };
    },
  },
  {
    topic: 'protein_foods',
    match: (q) => q.includes('protein'),
    async answer(userId) {
      // Best protein per calorie (more protein, fewer calories)
      const foods = await db.all('SELECT name, serving, kcal, protein_g FROM foods WHERE kcal > 0 AND verified = 1 ORDER BY protein_g / kcal DESC, id LIMIT 6');
      const day = await summary.healthDay(userId);
      let text = 'High-protein picks: ' + foods.map((f) => `${f.name} (${f.protein_g} g per ${f.serving})`).join(', ') + '.';
      if (day.targets) {
        const need = calc.round(Math.max(0, day.targets.protein_g - day.eaten.protein_g));
        text += ` You need about ${need} g more protein today.`;
      }
      return { text, data: { foods } };
    },
  },
];

router.post('/', asyncHandler(async (req, res) => {
  const { question } = validate(req.body, { question: { type: 'string', required: true, maxLength: 300 } });
  const q = question.toLowerCase();
  const rule = RULES.find((r) => r.match(q));

  if (!rule) {
    return res.json({
      topic: 'unknown',
      answer: 'I can help with: "calories left", "food spend", "how much to save", and "protein foods". Try one of those!',
    });
  }
  const result = await rule.answer(req.user.id);
  res.json({ topic: rule.topic, answer: result.text, data: result.data || null });
}));

module.exports = router;
