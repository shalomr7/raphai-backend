// routes/coach.js
// ------------------------------------------------------------
// POST /api/coach   { "question": "how many calories left?", "context"?: "home|health|fitness|wealth" }
// A rule-based personal coach (no AI model). It looks for keywords in
// the question and answers from the user's own data, in the same voice as
// the AI coach (ai/guardrails.js): a warm best friend, a motivating fitness
// coach and a practical Indian money expert. Short, personal, actionable,
// real numbers only. It never judges anyone's body, height, weight, age,
// sex, gender, skin colour, religion, caste or income, never suggests crash
// diets, and gives general guidance only (not a doctor or SEBI adviser).
// Understands:
//   - mood support / distress -> kind words + Tele-MANAS 14416 (checked FIRST)
//   - eating-disorder signs    -> care + doctor/counsellor + Tele-MANAS (safety)
//   - "am I fat / ugly", "roast me" -> body-neutral encouragement, no insults
//   - harmful / off-topic asks -> a polite no, back to health and money
//   - "what should I do today" -> today's top priorities
//   - "why are my steps low"   -> steps vs goal and your average, with a plan
//   - "save more this month"   -> where the money goes + concrete cuts
//   - "optimise my day"        -> a simple time plan from your numbers
//   - "today's nutrition"      -> calories, protein, safety of your target
//   - fat loss / belly fat     -> motivation + a plan from your numbers
//   - sleep                    -> your sleep average + tips
//   - "calories left", "food spend", "how much to save", "protein foods"
// If nothing matches, "context" picks a helpful default answer.
// Limits (utils/plans.js LIMITS):
//   Free: 5 rule-based questions a day, then 402 (upgrade_to: plus).
//   Plus / Pro / Elite: unlimited rule-based questions, plus a daily AI
//   allowance (Plus 5 on Flash-Lite, Pro 15, Elite 25 on Flash). After the
//   AI allowance the coach falls back to rule-based answers (never blocks).
//   Gemini is connected only when GEMINI_API_KEY is set AND the user gave
//   the 'gemini' consent (ai/index.js); otherwise every answer is
//   rule-based. The response says engine: 'rule_based' | 'ai'.
// POST /api/coach/confirm  saves an AI-proposed entry after the user taps confirm.
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const calc = require('../utils/calc');
const { validate, asyncHandler } = require('../utils/http');
const { planAndLimits, upgradeError } = require('../middleware/requirePlan');
const { PLANS, nextPlanWithMore } = require('../utils/plans');
const aiCoach = require('../services/aiCoach');
const { confirmProposal } = require('../ai/tools');
const summary = require('../services/summary');
const intelligence = require('../services/intelligence');
const { today, addDays, hourNow } = require('../utils/dates');
const guard = require('../ai/guardrails');

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

const SYMPTOMS = ['chest pain', 'chest tight', 'faint', 'fainted', 'dizzy', 'dizziness', 'breathless', 'short of breath', 'shortness of breath', 'blood in', 'palpitation', 'severe pain', 'numb'];
const BODY_IMAGE = /\b(am i (too )?(fat|ugly|short|skinny|thin|overweight|dark)|i('m| am) (so |too )?(fat|ugly|short|skinny|dark)|i (hate|don't like|dont like) (my|the way i) (body|look|height|weight|face|skin)|i look (fat|ugly|bad)|(i hate|insecure about) my height)\b/;
const INVESTING = /\b(invest\w*|sips?|mutual funds?|stocks?|share market|shares|crypto\w*|emis?|loans?|fixed deposits?|fds?|ppf|nps|elss|gold)\b/;

// Safety rules: answered by these rules only, never by the AI.
const SAFETY_TOPICS = ['mood_support', 'eating_support', 'medical_symptoms', 'off_limits'];

const NEW_RULES = [
  {
    topic: 'eating_support',
    match: (q) => guard.looksLikeEatingDisorder(q),
    async answer() {
      return {
        text: "Thank you for trusting me with this. Food and your body can feel really hard sometimes, and you deserve support, not pressure. "
          + "I won't suggest starving, purging or skipping meals: they hurt your body and mind. Please talk to a doctor or counsellor about how you've been feeling, "
          + "and you can call Tele-MANAS on 14416 (free, 24x7, in your language) any time. Regular meals with foods you enjoy are a great first step, and I'm here with you.",
        data: { helpline: { name: 'Tele-MANAS', phone: '14416' } },
      };
    },
  },
  {
    topic: 'medical_symptoms',
    match: (q) => has(q, SYMPTOMS),
    async answer() {
      return {
        text: "That sounds important, so please don't push through it. I'm not a doctor and can't check symptoms, so please see a doctor soon. "
          + 'If it is sudden or severe (chest pain, trouble breathing, fainting), call 112 or go to the nearest emergency right now. Take it easy today, your health comes first.',
        data: { emergency: '112' },
      };
    },
  },
  {
    topic: 'off_limits',
    match: (q) => guard.looksHarmful(q),
    async answer() {
      return {
        text: "I'll pass on that one: I don't put anyone down, and I stay away from anything that could hurt you or others. "
          + "What I'm great at is your health and your money. Want me to look at your steps, food or this month's budget instead?",
      };
    },
  },
  {
    topic: 'body_image',
    match: (q) => BODY_IMAGE.test(q),
    async answer(userId) {
      const { ctx, D } = await loadDayData(userId);
      const steps = weekAvg(ctx, D, 'steps');
      const sleep = weekAvg(ctx, D, 'sleep_h');
      let text = "Hey, your worth isn't measured by your size, height, shape or skin, and I'm not here to judge any of it. "
        + "Every body deserves respect, including yours. Let's focus on how you feel: energy, strength, sleep and mood. ";
      const wins = [];
      if (steps != null) wins.push(`you're averaging ${Math.round(steps).toLocaleString('en-IN')} steps a day`);
      if (sleep != null) wins.push(`sleeping about ${intelligence.hm(sleep * 60)}`);
      if (wins.length) text += `Right now ${wins.join(' and ')}. `;
      text += "Pick one small habit this week (a daily walk, protein at breakfast or an earlier bedtime) and I'll cheer you on. If these thoughts weigh on you a lot, talking to a counsellor or Tele-MANAS (14416) can really help.";
      return { text, data: { steps_avg_7d: steps == null ? null : Math.round(steps), helpline: { name: 'Tele-MANAS', phone: '14416' } } };
    },
  },
  {
    topic: 'investing',
    match: (q) => INVESTING.test(q),
    async answer(userId) {
      const { ctx } = await loadDayData(userId);
      const m = intelligence.monthMoney(ctx, ctx.D);
      let text = "Love that you're thinking about this! Here's the simple order most people in India follow: first an emergency fund of about 6 months of expenses (savings account, FD or a liquid fund), "
        + 'then health and term insurance, then a monthly SIP in diversified funds for goals 5+ years away. Keep all EMIs under about 30–40% of take-home pay. ';
      if (m.income) text += `On your ${intelligence.inr(m.income)} income, that EMI line is about ${intelligence.inr(m.income * 0.35)} a month, and a 20% savings goal is ${intelligence.inr(m.income * 0.2)}. `;
      text += "I can't pick specific stocks or funds, and no investment has guaranteed returns. For big decisions, a SEBI-registered adviser or a CA is worth it. Try the SIP and EMI calculators in the Wealth tab!";
      return { text, data: { income: m.income || null } };
    },
  },
  {
    topic: 'mood_support',
    match: (q) => has(q, DISTRESS) || has(q, LOW_MOOD),
    async answer(userId, q) {
      const distress = has(q, DISTRESS);
      if (distress) {
        return {
          text: "I'm really sorry you're going through this, and I'm so glad you told me. You don't have to carry it alone. "
            + 'Please talk to someone right now: call Tele-MANAS on 14416 (free, 24x7, in your language), or 112 if you are in immediate danger. '
            + "If you can, reach out to someone you trust and tell them how you feel. You matter, and I'm here for you.",
          data: { helpline: { name: 'Tele-MANAS', phone: '14416' }, emergency: '112' },
        };
      }
      const { ctx, D, day } = await loadDayData(userId);
      const moodAvg = weekAvg(ctx, D, 'mood');
      const sleepAvg = weekAvg(ctx, D, 'sleep_h');
      let text = "Hey, thank you for telling me. Low days happen to everyone, and they don't make you any less strong. ";
      const tips = [];
      if (sleepAvg != null && sleepAvg < 7) tips.push(`you've been sleeping about ${intelligence.hm(sleepAvg * 60)}, so an earlier night could really help`);
      if (day.steps == null || day.steps < 4000) tips.push('a 10-minute walk outside often lifts mood');
      tips.push('a few slow breaths (in for 4, out for 6) can calm your body');
      text += `A few small things that may help today: ${tips.join('; ')}. `;
      if (moodAvg != null) text += `Your mood this week averages ${moodAvg.toFixed(1)} out of 5. `;
      text += "If this feeling stays for days or gets too heavy, please call Tele-MANAS on 14416 (free, 24x7). Talking to someone really helps, and I'm right here too.";
      return { text, data: { mood_avg_7d: moodAvg == null ? null : calc.round(moodAvg, 1), helpline: { name: 'Tele-MANAS', phone: '14416' } } };
    },
  },
  {
    topic: 'fat_loss',
    match: (q) => has(q, ['belly', 'fat loss', 'lose fat', 'lose weight', 'weight loss', 'lose my', 'burn fat', 'reduce weight', 'slim', 'tummy', 'motivat']),
    async answer(userId) {
      const { ctx, D } = await loadDayData(userId);
      const t = ctx.targets;
      let text = "Yes, you can, and I've got your back every step of the way. ";
      text += "No crash diets and no starving: you can't target fat in one spot, but steady habits bring it down everywhere, belly included. ";
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
      text += `Your plan: ${plan.join(', ')}. A safe pace is 0.25–0.75 kg a week. Be kind to yourself on this: small daily wins add up, and you're already starting.`;
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
        return { text: "I don't see any steps yet. Turn on step syncing in the app (Health Connect or your phone's pedometer) and I'll keep an eye on them for you. Meanwhile, a 15-minute walk after a meal is a lovely start. Let's go!" };
      }
      let text = '';
      if (day.steps != null) text += `You're at ${day.steps.toLocaleString('en-IN')} steps today, ${Math.max(0, goal - day.steps).toLocaleString('en-IN')} away from your ${goal.toLocaleString('en-IN')} goal. `;
      if (avg7 != null) text += `Your 7-day average is ${Math.round(avg7).toLocaleString('en-IN')}. `;
      text += "Steps usually dip on long sitting days, so this isn't about willpower. Easy wins: a 10-minute walk after each meal (about 3,000 steps), take calls while walking, and use the stairs. ";
      const behind = day.steps != null ? goal - day.steps : null;
      if (behind != null && behind > 0) text += `A ${Math.min(45, Math.max(10, Math.round(behind / 100 / 5) * 5))}-minute walk today would close most of the gap.`;
      else text += "You've already hit your goal today. Brilliant, keep that streak going!";
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
      if (!m.income) return { text: "Add your monthly income to your profile and log a few expenses, and I'll find exactly where your money can work harder. Deal?" };
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
      text += `Aim to keep ${intelligence.inr(target)} (20%) aside: move it to savings or a SIP on payday so it happens automatically. Just checking this puts you ahead of most people!`;
      return { text, data: { income: m.income, spent: m.spent, unpaid_bills: m.unpaidThisMonth, left: calc.round(left), top_flexible: wants[0] || null } };
    },
  },
  {
    topic: 'what_to_do_today',
    match: (q) => has(q, ['what should i do', 'what to do today', 'what do i do', 'plan for today', 'focus today', 'priorit']),
    async answer(userId) {
      const ins = await intelligence.todayInsights(userId);
      if (!ins.priorities.length) return { text: "You're on track today! Keep it rolling: log your meals, sip water through the day and get some movement in. Love the consistency.", data: { priorities: [] } };
      const list = ins.priorities.map((p, i) => `${i + 1}) ${p.title}: ${p.detail}`).join(' ');
      return { text: `Here's what matters most today. ${list} One step at a time, you've got this!`, data: { priorities: ins.priorities, raphscore: ins.raphscore.overall } };
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
      return { text: `Here's a simple plan for the rest of your day: ${plan.join('; ')}. Small steps, done daily, make a big difference. You've got this!`, data: { hour } };
    },
  },
  {
    topic: 'nutrition_today',
    match: (q) => has(q, ['nutrition', 'what should i eat', 'diet', 'macros', 'meal plan', 'eat today']),
    async answer(userId) {
      const { ctx, day } = await loadDayData(userId);
      const t = ctx.targets;
      if (!t) return { text: "Fill in your profile (age, height, weight and sex for the calorie maths) and I'll set your calorie and protein targets for today." };
      const n = intelligence.nutritionSafety({ tdee: t.tdee, target: t.calories, sex: ctx.profile.sex });
      let text = `Your target today is ${t.calories.toLocaleString('en-IN')} kcal with ${t.protein_g} g protein. `;
      if (day.food_n) {
        const kcal = Math.round(day.kcal); const p = Math.round(day.protein);
        text += `So far you've had ${kcal.toLocaleString('en-IN')} kcal and ${p} g protein`;
        text += t.calories - kcal > 0 ? `, so about ${(t.calories - kcal).toLocaleString('en-IN')} kcal left. ` : '. ';
        if (p < t.protein_g * 0.6) text += 'Add protein to your next meal: dal, eggs, paneer, curd or soya chunks. ';
      } else text += "You haven't logged food yet today: try a quick log like \"2 rotis and dal\" and I'll do the maths. ";
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
      text += avg7 != null && avg7 >= 7 ? "That's healthy rest, nicely done! Keep the same bedtime, even on weekends."
        : "Most adults feel best with 7–9 hours, so let's nudge it up. Try: the same bedtime every night, no screens 30 minutes before bed, no chai or coffee after 4 PM, and a short walk in daylight. Your future self will thank you.";
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
      if (!day.targets) return { text: "Fill in your profile (age, height, weight and sex for the calorie maths) and I'll tell you exactly how many calories you have left." };
      const left = day.calories_left;
      const text = left >= 0
        ? `You have about ${left} kcal left today (target ${day.targets.calories}, eaten ${day.eaten.kcal}, burned ${day.workout_kcal} in workouts). Nice and steady!`
        : `You're ${-left} kcal over today's target of ${day.targets.calories}, and that's totally fine: one day doesn't undo your progress. A 20-minute walk burns roughly 100 kcal, and tomorrow is a fresh start.`;
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
        text: `This month you spent ${inr(total)} on food (${inr(food)} eating out/ordering + ${inr(groceries)} groceries). That's ${share}% of all your spending.${food > groceries && food > 0 ? ' Swapping two orders a week for home-cooked dal-rice or eggs saves money and adds protein.' : ' Nicely balanced!'}`,
        data: { food, groceries, total, share_pct: share },
      };
    },
  },
  {
    topic: 'how_much_to_save',
    match: (q) => q.includes('save') || q.includes('saving'),
    async answer(userId) {
      const m = await summary.wealthMonth(userId);
      if (!m.income) return { text: "Add your monthly income to your profile and I'll suggest a savings amount that actually fits your life." };
      const suggested = m.income * 0.2;
      const savedSoFar = m.income - m.spent;
      const goals = await db.all('SELECT * FROM savings_goals WHERE user_id = $1 AND saved < target ORDER BY id', [userId]);
      let text = `Using the 50/30/20 rule, try to save ${inr(suggested)} a month (20% of ${inr(m.income)}), ideally as an automatic transfer or SIP on payday. `
        + `So far this month, income minus spending is ${inr(savedSoFar)}.`;
      if (goals.length) {
        const g = goals[0];
        text += ` Your goal "${g.name}" needs ${inr(g.target - g.saved)} more. You're getting there!`;
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
        text += need > 0 ? ` You need about ${need} g more protein today. Easy to add at your next meal!` : ' You have hit your protein target today. Great job!';
      }
      return { text, data: { foods } };
    },
  },
];

// Order matters: mood support first (safety), then specific questions, then the older simple ones.
// The steps/sleep/save rules come before "calories" etc. only where their words are specific.
const RULES = [
  NEW_RULES.find((r) => r.topic === 'mood_support'),
  NEW_RULES.find((r) => r.topic === 'eating_support'),
  NEW_RULES.find((r) => r.topic === 'medical_symptoms'),
  NEW_RULES.find((r) => r.topic === 'off_limits'),
  NEW_RULES.find((r) => r.topic === 'body_image'),
  OLD_RULES.find((r) => r.topic === 'calories_left'),
  OLD_RULES.find((r) => r.topic === 'food_spend'),
  ...NEW_RULES.filter((r) => ['fat_loss', 'steps_low', 'save_more', 'what_to_do_today', 'optimise_day', 'nutrition_today', 'sleep'].includes(r.topic)),
  NEW_RULES.find((r) => r.topic === 'investing'),
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
  const userId = req.user.id;
  const { plan, limits } = await planAndLimits(userId);
  // Rule-based allowance (Free only; null = unlimited)
  let remaining_today = null;
  if (limits.coach_per_day != null) {
    const limit = limits.coach_per_day;
    const row = await db.get(`
      INSERT INTO feature_usage (user_id, date, feature, count) VALUES ($1, $2, 'coach', 1)
      ON CONFLICT (user_id, date, feature) DO UPDATE SET count = feature_usage.count + 1
        WHERE feature_usage.count < $3
      RETURNING count`, [userId, today(), limit]);
    if (!row) {
      const up = nextPlanWithMore(plan, 'coach_per_day');
      throw upgradeError(`You've used your ${limit} free coach questions today. They reset tomorrow, or get ${up ? PLANS[up].name : 'a paid plan'} for unlimited coaching.`,
        { plan, upgradeTo: up, limit });
    }
    remaining_today = Math.max(0, limit - row.count);
  }

  const q = question.toLowerCase();
  let rule = RULES.find((r) => r.match(q));
  let guessed = false;
  if (!rule && context) { rule = BY_TOPIC[CONTEXT_DEFAULT[context]]; guessed = true; }

  // AI first (paid plans, while today's AI allowance lasts), else rules.
  // Safety topics (mood / distress, eating-disorder signs, medical symptoms,
  // harmful asks) always get the rule answer: helplines first, nothing sent to the model.
  const safety = Boolean(rule && SAFETY_TOPICS.includes(rule.topic));
  const { answer: aiAnswer, info: ai } = safety
    ? { answer: null, info: null }
    : await aiCoach.tryAiAnswer({ userId, plan, question, context });
  const meta = { plan, remaining_today, ai };
  if (aiAnswer) {
    // data.proposals: entries the AI suggests saving. Nothing is saved until
    // the app sends a proposal's confirmation_token to POST /api/coach/confirm.
    return res.json({ topic: 'ai', answer: String(aiAnswer.text).trim(), data: aiAnswer.data || null, context: context || null, guessed_from_context: false, engine: 'ai', ...meta });
  }

  if (!rule) {
    return res.json({
      topic: 'unknown',
      answer: "Hmm, I'm not sure I caught that, but I'm all yours for health and money! Try: what to do today, why your steps are low, how to save more this month, "
        + "planning your day, today's nutrition, losing fat, sleep, how you're feeling, calories left, food spend or protein foods.",
      data: null,
      engine: 'rule_based',
      ...meta,
    });
  }
  const result = await rule.answer(userId, q);
  res.json({ topic: rule.topic, answer: result.text.trim(), data: result.data || null, context: context || null, guessed_from_context: guessed, engine: 'rule_based', ...meta });
}));

// POST /api/coach/confirm { confirmation_token }
// Saves an entry the AI proposed (ai/tools.js proposeLogEntry), only for the
// user it was made for, only once, re-validated with the normal rules.
router.post('/confirm', asyncHandler(async (req, res) => {
  const { confirmation_token: token } = validate(req.body, { confirmation_token: { type: 'string', required: true, maxLength: 4000 } });
  const saved = await confirmProposal(req.user.id, token);
  res.status(201).json({ saved: true, ...saved });
}));

module.exports = router;
