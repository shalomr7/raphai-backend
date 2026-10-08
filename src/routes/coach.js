// routes/coach.js
// ------------------------------------------------------------
// POST /api/coach   { "question": "how many calories left?", "context"?: "home|health|fitness|wealth" }
// A rule-based personal coach (no AI model). It looks for keywords in
// the question and answers from the user's own data, in a warm,
// encouraging tone and simple English. It never judges anyone's body,
// age, sex, skin colour, religion, caste or income.
// Understands:
//   - mood support / distress -> kind words + Tele-MANAS 14416 (checked FIRST)
//   - "what should I do today" -> today's top priorities
//   - "why are my steps low"   -> steps vs goal and your average, with a plan
//   - "save more this month"   -> where the money goes + concrete cuts
//   - "optimise my day"        -> a simple time plan from your numbers
//   - "today's nutrition"      -> calories, protein, safety of your target
//   - fat loss / belly fat     -> motivation + a plan from your numbers
//   - sleep                    -> your sleep average + tips
//   - "calories left", "food spend", "how much to save", "protein foods"
// If nothing matches, "context" picks a helpful default answer.
// Free: 5 questions a day. Pro: unlimited.
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const calc = require('../utils/calc');
const { validate, asyncHandler, HttpError } = require('../utils/http');
const { hasPlan } = require('../middleware/requirePlan');
const { FREE_LIMITS } = require('../utils/plans');
const summary = require('../services/summary');
const intelligence = require('../services/intelligence');
const { today, addDays, hourNow } = require('../utils/dates');

const router = express.Router();

// Format a number as Indian rupees, e.g. 125000 -> ₹1,25,000
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');


// Words that mean someone may be struggling. Checked before anything else.
const DISTRESS = ['suicid', 'kill myself', 'end my life', 'want to die', 'self harm', 'self-harm', 'hurt myself', 'no reason to live', 'hopeless', 'can\'t go on', 'cant go on'];
const LOW_MOOD = ['sad', 'stressed', 'stress', 'anxious', 'anxiety', 'depressed', 'depression', 'lonely', 'feeling low', 'feel low', 'upset', 'overwhelmed', 'tired of everything', 'not okay', 'crying', 'my mood', 'mood'];

// true if the question contains any of the words (matched at the start of a word,
// so "rest" does not match "interest")
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (q, words) => words.some((w) => new RegExp(`(^|[^a-z])${esc(w)}`).test(q));

async function loadDayData(userId) {
  const D = today();
  const ctx = await intelligence.loadContext(userId, D);
  return { D, ctx, day: ctx.days[D], yday: ctx.days[addDays(D, -1)] };
}

function weekAvg(ctx, D, key) {
  const vals = [];
  for (let i = 0; i < 7; i++) { const d = ctx.days[addDays(D, -i)]; if (d && d[key] != null) vals.push(d[key]); }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

const NEW_RULES = [
  {
    topic: 'mood_support',
    match: (q) => has(q, DISTRESS) || has(q, LOW_MOOD),
    async answer(userId, q) {
      const distress = has(q, DISTRESS);
      if (distress) {
        return {
          text: "I'm really sorry you're feeling this way, and I'm glad you told me. You don't have to go through this alone. "
            + 'Please talk to someone right now: call Tele-MANAS on 14416 (free, 24x7, in your language), or 112 if you are in immediate danger. '
            + 'If you can, reach out to a person you trust and tell them how you feel. You matter.',
          data: { helpline: { name: 'Tele-MANAS', phone: '14416' }, emergency: '112' },
        };
      }
      const { ctx, D, day } = await loadDayData(userId);
      const moodAvg = weekAvg(ctx, D, 'mood');
      const sleepAvg = weekAvg(ctx, D, 'sleep_h');
      let text = "Thank you for sharing that. It's okay to have low days, and it doesn't make you any less strong. ";
      const tips = [];
      if (sleepAvg != null && sleepAvg < 7) tips.push(`you've been sleeping about ${intelligence.hm(sleepAvg * 60)}, so an earlier night could really help`);
      if (day.steps == null || day.steps < 4000) tips.push('a 10-minute walk outside often lifts mood');
      tips.push('a few slow breaths (in for 4, out for 6) can calm your body');
      text += `A few small things that may help today: ${tips.join('; ')}. `;
      if (moodAvg != null) text += `Your mood this week averages ${moodAvg.toFixed(1)} out of 5. `;
      text += 'If these feelings stay for days or feel too heavy, please call Tele-MANAS on 14416 (free, 24x7). Talking to someone helps.';
      return { text, data: { mood_avg_7d: moodAvg == null ? null : calc.round(moodAvg, 1), helpline: { name: 'Tele-MANAS', phone: '14416' } } };
    },
  },
  {
    topic: 'fat_loss',
    match: (q) => has(q, ['belly', 'fat loss', 'lose fat', 'lose weight', 'weight loss', 'lose my', 'burn fat', 'reduce weight', 'slim', 'tummy', 'motivat']),
    async answer(userId) {
      const { ctx, D } = await loadDayData(userId);
      const t = ctx.targets;
      let text = "Yes, you can — and I'll help you every step of the way. ";
      text += "You can't target fat in one spot, but steady habits shrink belly fat along with the rest of your body. ";
      const plan = [];
      if (t) {
        const n = intelligence.nutritionSafety({ tdee: t.tdee, target: t.calories, sex: ctx.profile.sex });
        const kcal = n.safety === 'ok' ? t.calories : n.suggested_target;
        plan.push(`eat about ${kcal.toLocaleString('en-IN')} kcal a day (your body burns about ${t.tdee.toLocaleString('en-IN')})`);
        plan.push(`get ${t.protein_g} g of protein daily from dal, eggs, paneer, curd, chicken or soya`);
      } else plan.push('fill in your profile so I can set your calorie and protein targets');
      const steps = weekAvg(ctx, D, 'steps');
      const goal = ctx.profile.step_goal || 8000;
      plan.push(steps != null ? `walk ${Math.max(goal, Math.round(steps / 1000) * 1000 + 1000).toLocaleString('en-IN')} steps a day (you average ${Math.round(steps).toLocaleString('en-IN')} now)` : `walk ${goal.toLocaleString('en-IN')} steps a day`);
      plan.push('do strength training 2–3 times a week', 'sleep 7–8 hours');
      text += `Your plan: ${plan.join(', ')}. A safe pace is 0.25–0.75 kg a week. Be patient with yourself: small daily wins add up.`;
      return { text, data: { calories: t ? t.calories : null, protein_g: t ? t.protein_g : null, steps_avg_7d: steps == null ? null : Math.round(steps) } };
    },
  },
  {
    topic: 'steps_low',
    match: (q) => (q.includes('step') || q.includes('walk')) && has(q, ['low', 'less', 'why', 'more', 'increase', 'improve', 'behind']),
    async answer(userId) {
      const { ctx, D, day } = await loadDayData(userId);
      const goal = ctx.profile.step_goal || 8000;
      const avg7 = weekAvg(ctx, D, 'steps');
      if (day.steps == null && avg7 == null) {
        return { text: "I don't see any steps yet. Turn on step syncing in the app (Health Connect or the phone's pedometer) and I'll track them for you. Meanwhile, a 15-minute walk after a meal is a lovely start." };
      }
      let text = '';
      if (day.steps != null) text += `You're at ${day.steps.toLocaleString('en-IN')} steps today, ${Math.max(0, goal - day.steps).toLocaleString('en-IN')} away from your ${goal.toLocaleString('en-IN')} goal. `;
      if (avg7 != null) text += `Your 7-day average is ${Math.round(avg7).toLocaleString('en-IN')}. `;
      text += 'Steps usually dip on long sitting days, so it is not about willpower. Easy fixes: a 10-minute walk after each meal (about 3,000 steps), take calls while walking, and use the stairs. ';
      const behind = day.steps != null ? goal - day.steps : null;
      if (behind != null && behind > 0) text += `A ${Math.min(45, Math.max(10, Math.round(behind / 100 / 5) * 5))}-minute walk today would close most of the gap.`;
      else text += "You've already hit your goal today. Brilliant!";
      return { text, data: { steps_today: day.steps, step_goal: goal, steps_avg_7d: avg7 == null ? null : Math.round(avg7) } };
    },
  },
  {
    topic: 'save_more',
    match: (q) => (q.includes('save') || q.includes('saving')) && has(q, ['more', 'how can', 'tips', 'cut', 'reduce', 'help me']) || has(q, ['spend less', 'reduce spend', 'cut spend', 'cut my spend']),
    async answer(userId) {
      const { ctx } = await loadDayData(userId);
      const m = intelligence.monthMoney(ctx, ctx.D);
      const month = await summary.wealthMonth(userId);
      if (!m.income) return { text: 'Add your monthly income to your profile and log a few expenses, and I\'ll find where you can save.' };
      const left = m.income - m.spent - m.unpaidThisMonth;
      const wants = month.by_category.filter((c) => !summary.NEEDS.includes(c.category) && !summary.SAVINGS.includes(c.category) && c.category !== 'Rent');
      let text = `This month you've spent ${intelligence.inr(m.spent)} of your ${intelligence.inr(m.income)} income`;
      text += m.unpaidThisMonth > 0 ? `, and bills of ${intelligence.inr(m.unpaidThisMonth)} are still due. ` : '. ';
      text += left >= 0 ? `That leaves ${intelligence.inr(left)}. ` : `That's ${intelligence.inr(-left)} more than your income, so let's slow down a little. `;
      if (wants.length) {
        const top = wants[0];
        text += `Your biggest flexible spend is ${top.category} at ${intelligence.inr(top.total)}. Cutting it by a quarter saves about ${intelligence.inr(top.total * 0.25)}. `;
      }
      const target = m.income * 0.2;
      text += `Aim to keep ${intelligence.inr(target)} (20%) aside: move it to savings or a SIP on payday so you don't have to think about it. You're doing well by checking.`;
      return { text, data: { income: m.income, spent: m.spent, unpaid_bills: m.unpaidThisMonth, left: calc.round(left), top_flexible: wants[0] || null } };
    },
  },
  {
    topic: 'what_to_do_today',
    match: (q) => has(q, ['what should i do', 'what to do today', 'what do i do', 'plan for today', 'focus today', 'priorit']),
    async answer(userId) {
      const ins = await intelligence.todayInsights(userId);
      if (!ins.priorities.length) return { text: "You're on track today. Keep it up: log your meals, drink water through the day and get some movement in. I'm proud of your consistency.", data: { priorities: [] } };
      const list = ins.priorities.map((p, i) => `${i + 1}) ${p.title}: ${p.detail}`).join(' ');
      return { text: `Here's what matters most today. ${list} One step at a time, you've got this.`, data: { priorities: ins.priorities, raphscore: ins.raphscore.overall } };
    },
  },
  {
    topic: 'optimise_day',
    match: (q) => has(q, ['optimi', 'my day', 'routine', 'schedule', 'productive']),
    async answer(userId) {
      const { ctx, day } = await loadDayData(userId);
      const hour = hourNow();
      const goal = ctx.profile.step_goal || 8000;
      const t = ctx.targets;
      const waterGoal = (t && t.water_ml) || 2500;
      const plan = [];
      if (hour < 11) plan.push('morning: a glass of water and a protein breakfast (eggs, pesarattu or curd)');
      if (hour < 15) plan.push('after lunch: a 10-minute walk');
      plan.push(`through the day: ${Math.round(waterGoal / 250)} glasses of water (${day.water != null ? `${Math.round(day.water)} ml so far` : 'none logged yet'})`);
      plan.push(`steps: ${day.steps != null ? `${Math.max(0, goal - day.steps).toLocaleString('en-IN')} more to reach ${goal.toLocaleString('en-IN')}` : `aim for ${goal.toLocaleString('en-IN')}`}`);
      if (t) plan.push(`food: about ${t.calories.toLocaleString('en-IN')} kcal and ${t.protein_g} g protein`);
      plan.push('evening: log your expenses and mood, screens off by 10 PM, in bed by 10:30 PM');
      return { text: `Here's a simple plan for the rest of your day: ${plan.join('; ')}. Small steps, done daily, make a big difference.`, data: { hour } };
    },
  },
  {
    topic: 'nutrition_today',
    match: (q) => has(q, ['nutrition', 'what should i eat', 'diet', 'macros', 'meal plan', 'eat today']),
    async answer(userId) {
      const { ctx, day } = await loadDayData(userId);
      const t = ctx.targets;
      if (!t) return { text: 'Fill in your profile (sex, age, height and weight) and I can give you calorie and protein targets for today.' };
      const n = intelligence.nutritionSafety({ tdee: t.tdee, target: t.calories, sex: ctx.profile.sex });
      let text = `Your target today is ${t.calories.toLocaleString('en-IN')} kcal with ${t.protein_g} g protein. `;
      if (day.food_n) {
        const kcal = Math.round(day.kcal); const p = Math.round(day.protein);
        text += `So far you've had ${kcal.toLocaleString('en-IN')} kcal and ${p} g protein`;
        text += t.calories - kcal > 0 ? `, so about ${(t.calories - kcal).toLocaleString('en-IN')} kcal left. ` : '. ';
        if (p < t.protein_g * 0.6) text += 'Add protein to your next meal: dal, eggs, paneer, curd or soya chunks. ';
      } else text += "You haven't logged food yet today: try a quick log like \"2 rotis and dal\". ";
      if (n.safety !== 'ok') text += n.message;
      return { text, data: { target: t.calories, protein_g: t.protein_g, eaten_kcal: day.food_n ? Math.round(day.kcal) : null, safety: n.safety } };
    },
  },
  {
    topic: 'sleep',
    match: (q) => has(q, ['sleep', 'insomnia', 'tired', 'rest', 'bedtime']),
    async answer(userId) {
      const { ctx, D, day } = await loadDayData(userId);
      const avg7 = weekAvg(ctx, D, 'sleep_h');
      if (day.sleep_h == null && avg7 == null) return { text: 'Start tracking your sleep (or sync it from Health Connect) and I\'ll spot what helps you rest. For now: a fixed bedtime, no screens 30 minutes before bed and no tea or coffee after 4 PM work for most people.' };
      let text = '';
      if (day.sleep_h != null) text += `You slept ${intelligence.hm(day.sleep_h * 60)} last night. `;
      if (avg7 != null) text += `Your 7-day average is ${intelligence.hm(avg7 * 60)}. `;
      text += avg7 != null && avg7 >= 7 ? 'That is healthy rest. Keep the same bedtime, even on weekends.'
        : 'Most adults feel best with 7–9 hours. Try: the same bedtime every night, no screens 30 minutes before bed, no chai or coffee after 4 PM, and a short walk in daylight.';
      return { text, data: { sleep_last_night_h: day.sleep_h, sleep_avg_7d_h: avg7 == null ? null : calc.round(avg7, 1) } };
    },
  },
];

// Each rule: words to look for + a function that writes the answer
const OLD_RULES = [
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

// Order matters: mood support first (safety), then specific questions, then the older simple ones.
// The steps/sleep/save rules come before "calories" etc. only where their words are specific.
const RULES = [
  NEW_RULES.find((r) => r.topic === 'mood_support'),
  OLD_RULES.find((r) => r.topic === 'calories_left'),
  OLD_RULES.find((r) => r.topic === 'food_spend'),
  ...NEW_RULES.filter((r) => ['fat_loss', 'steps_low', 'save_more', 'what_to_do_today', 'optimise_day', 'nutrition_today', 'sleep'].includes(r.topic)),
  OLD_RULES.find((r) => r.topic === 'how_much_to_save'),
  OLD_RULES.find((r) => r.topic === 'protein_foods'),
];
const BY_TOPIC = Object.fromEntries([...NEW_RULES, ...OLD_RULES].map((r) => [r.topic, r]));

// When the question is not understood, the screen it came from picks a helpful answer
const CONTEXT_DEFAULT = { home: 'what_to_do_today', health: 'nutrition_today', fitness: 'steps_low', wealth: 'save_more' };

router.post('/', asyncHandler(async (req, res) => {
  const { question, context } = validate(req.body, {
    question: { type: 'string', required: true, maxLength: 300 },
    context: { type: 'string', oneOf: ['home', 'health', 'fitness', 'wealth'] },
  });
  // Free plan: COACH_FREE_PER_DAY questions a day; Pro and above: unlimited
  const pro = await hasPlan(req.user.id, 'pro');
  let remaining_today = null;
  if (!pro) {
    const limit = FREE_LIMITS.coach_per_day || 5;
    const row = await db.get(`
      INSERT INTO feature_usage (user_id, date, feature, count) VALUES ($1, $2, 'coach', 1)
      ON CONFLICT (user_id, date, feature) DO UPDATE SET count = feature_usage.count + 1
        WHERE feature_usage.count < $3
      RETURNING count`, [req.user.id, today(), limit]);
    if (!row) throw new HttpError(402, `You've used your ${limit} free Raph AI questions today. They reset tomorrow, or go Pro for unlimited coaching.`);
    remaining_today = Math.max(0, limit - row.count);
  }
  const q = question.toLowerCase();
  let rule = RULES.find((r) => r.match(q));
  let guessed = false;
  if (!rule && context) { rule = BY_TOPIC[CONTEXT_DEFAULT[context]]; guessed = true; }

  if (!rule) {
    return res.json({
      topic: 'unknown',
      answer: "I'm still learning that one. I can help with: what to do today, why your steps are low, how to save more this month, "
        + "planning your day, today's nutrition, losing fat, sleep, how you're feeling, calories left, food spend and protein foods. Ask me any of these!",
      data: null,
      remaining_today,
    });
  }
  const result = await rule.answer(req.user.id, q);
  res.json({ topic: rule.topic, answer: result.text.trim(), data: result.data || null, context: context || null, guessed_from_context: guessed, remaining_today });
}));

module.exports = router;
