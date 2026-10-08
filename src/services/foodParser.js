// services/foodParser.js
// ------------------------------------------------------------
// Turns a sentence like "I ate 2 eggs, 2 rotis and a glass of milk"
// into foods from our foods table, with nutrition scaled to the amount.
// Rule-based (no AI model). It understands:
//   - splitting on commas, "and", "&", "+", "with", new lines
//   - numbers: 2, 1.5, 1/2, and words: a, an, one ... twelve, half,
//     quarter, "one and a half", Hindi dedh (1.5), dhai (2.5), aadha (0.5)
//   - units: katori, plate, roti/chapati, piece, glass, cup, bowl,
//     slice, spoon/tbsp/tsp, scoop, g/grams, ml
//   - fuzzy names: "rotis" -> Roti / Chapati, "daal" -> Dal, typos
// parseText(text, foods) is pure (no database), so it is easy to test.
// ------------------------------------------------------------

const calc = require('../utils/calc');

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5, quarter: 0.25, couple: 2, few: 3,
  single: 1, double: 2, dedh: 1.5, dhai: 2.5, aadha: 0.5, adha: 0.5, ek: 1, do: 2, teen: 3, char: 4,
};

// Unit words -> our unit name. Plurals are handled by singular().
const UNIT_WORDS = {
  katori: 'katori', katoris: 'katori', vati: 'katori', bowl: 'bowl',
  plate: 'plate', glass: 'glass', cup: 'cup', mug: 'cup',
  piece: 'piece', pc: 'piece', pcs: 'piece', nos: 'piece',
  slice: 'slice', spoon: 'spoon', chammach: 'spoon', tablespoon: 'tbsp', tbsp: 'tbsp', teaspoon: 'tsp', tsp: 'tsp',
  scoop: 'scoop', handful: 'handful', serving: 'serving', portion: 'serving',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', kg: 'kg',
  ml: 'ml', l: 'l', litre: 'l', liter: 'l', ltr: 'l',
};

// Foods that are their own unit ("2 rotis" = 2 pieces of roti)
const PIECE_FOODS = ['roti', 'chapati', 'phulka', 'paratha', 'puri', 'idli', 'dosa', 'vada', 'egg', 'samosa', 'banana', 'apple', 'naan'];

// Typical sizes of each unit in grams (or ml)
const UNIT_GRAMS = { spoon: 10, katori: 150, bowl: 200, plate: 250, glass: 250, cup: 150, tbsp: 15, tsp: 5, slice: 28, scoop: 30, handful: 30, g: 1, kg: 1000, ml: 1, l: 1000 };

// Other names people use -> a word that is in our food names
const ALIASES = {
  chapati: 'roti', chapathi: 'roti', chappati: 'roti', rotti: 'roti', fulka: 'phulka',
  anda: 'egg', ande: 'egg', daal: 'dal', dhal: 'dal', toor: 'dal', moong: 'dal',
  chawal: 'rice', rice: 'rice', biriyani: 'biryani', briyani: 'biryani', biriani: 'biryani',
  doodh: 'milk', dahi: 'curd', yogurt: 'curd', yoghurt: 'curd', chaas: 'buttermilk', mor: 'buttermilk', lassi: 'buttermilk',
  chai: 'chai', tea: 'chai', coffee: 'coffee', kofi: 'coffee', chana: 'chana', channa: 'chole', chhole: 'chole', chickpeas: 'chole',
  vadai: 'vada', wada: 'vada', vadas: 'vada', dosai: 'dosa', iddli: 'idli', murgi: 'chicken', murg: 'chicken',
  fish: 'fish', meen: 'fish', machli: 'fish', soya: 'soya', paneer: 'paneer', groundnut: 'peanuts', peanut: 'peanuts', moongphali: 'peanuts',
  sabzi: 'sabzi', sabji: 'sabzi', curry: 'curry', omelet: 'omelette', omlet: 'omelette', omlette: 'omelette',
  protein: 'whey', whey: 'whey', toast: 'bread', bread: 'bread', shakkar: 'sugar', cheeni: 'sugar',
};

// Words that carry no food meaning
const FILLER = new Set(['i', 'ate', 'had', 'have', 'eaten', 'having', 'drank', 'drink', 'drunk', 'took', 'of', 'some', 'my', 'the', 'for',
  'breakfast', 'lunch', 'dinner', 'snack', 'snacks', 'today', 'morning', 'evening', 'night', 'just', 'also', 'then', 'about', 'around',
  'approx', 'cooked', 'fresh', 'homemade', 'home', 'made', 'big', 'small', 'medium', 'large', 'full', 'bit', 'little', 'x', 'in', 'at']);

const STOP_MATCH = new Set(['with', 'and', 'or', 'no', 'cooked', 'dry', 'g', 'ml', 'medium', 'large', 'small', 'piece', 'plain']);

function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /(ches|shes|sses|oes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function normWord(w) {
  const s = singular(w);
  return ALIASES[w] || ALIASES[s] || s;
}

// Small edit distance (for typos like "biryanu")
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// "1 katori (150 g cooked)" -> { count: 1, unit: 'katori', grams: 150 }
function parseServing(serving) {
  const s = String(serving || '').toLowerCase();
  const out = { count: 1, unit: null, grams: null };
  const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?/);
  if (m) {
    out.count = Number(m[1]);
    const u = m[2] ? (UNIT_WORDS[m[2]] || UNIT_WORDS[singular(m[2])]) : null;
    if (u === 'g' || u === 'ml') { out.grams = out.count; out.unit = u; out.count = 1; }
    else if (u) out.unit = u;
    else if (m[2] && ['medium', 'large', 'small', 'egg', 'eggs'].includes(m[2])) out.unit = 'piece';
  }
  const g = s.match(/\((\d+(?:\.\d+)?)\s*(g|ml)\b/);
  if (g && out.grams == null) out.grams = Number(g[1]) / (out.count || 1) * (out.unit === 'g' || out.unit === 'ml' ? 1 : 1);
  if (out.unit && UNIT_GRAMS[out.unit] && out.grams == null && !['g', 'ml'].includes(out.unit)) out.grams = UNIT_GRAMS[out.unit] * out.count;
  return out;
}

// Turn number words / fractions into digits so they are easy to read.
function normaliseNumbers(text) {
  let t = ` ${text} `;
  t = t.replace(/(\d+)\s*\/\s*(\d+)/g, (m, a, b) => String(Number(a) / Number(b)));
  // "2 and a half" / "one and half" -> 2.5 / 1.5 (before we split on "and")
  t = t.replace(/\b(\d+(?:\.\d+)?|[a-z]+)\s+and\s+(?:a\s+)?half\b/g, (m, n) => {
    const v = /^\d/.test(n) ? Number(n) : NUMBER_WORDS[n];
    return v ? ` ${v + 0.5} ` : m;
  });
  t = t.replace(/\bhalf\s+(?:a|an)\b/g, ' 0.5 ');
  // "200g" -> "200 g", "250ml" -> "250 ml"
  t = t.replace(/(\d)(g|gm|gms|grams?|kg|ml|l|ltr)\b/g, '$1 $2');
  return t.trim();
}

function splitItems(text) {
  return normaliseNumbers(String(text).toLowerCase())
    .replace(/[.!?]/g, (m, i, s) => (/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '') ? m : ','))
    .split(/,|;|\n|\+|&|\band\b|\bwith\b|\balong with\b|\bplus\b/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// "2 rotis" -> { qty: 2, unit: 'piece', words: ['roti'] }
function readAmount(segment) {
  const words = segment.replace(/[^a-z0-9.\s]/g, ' ').split(/\s+/).filter(Boolean);
  let qty = null; let unit = null; const rest = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (qty == null && /^\d+(\.\d+)?$/.test(w)) { qty = Number(w); continue; }
    if (qty == null && NUMBER_WORDS[w] !== undefined && !(w === 'do' && i > 0)) {
      // "a" only counts as a number before a unit or food word
      qty = NUMBER_WORDS[w];
      continue;
    }
    if (qty != null && w === 'x') continue;
    const u = UNIT_WORDS[w] || (w.length > 2 ? UNIT_WORDS[singular(w)] : null);
    if (unit == null && u && (rest.length === 0 || qty != null)) { unit = u; continue; }
    if (FILLER.has(w)) continue;
    rest.push(w);
  }
  const foodWords = rest.map(normWord).filter((w) => w && !FILLER.has(w));
  if (!unit && foodWords.some((w) => PIECE_FOODS.includes(w))) unit = 'piece';
  return { qty: qty == null ? 1 : qty, unit, words: foodWords };
}

function foodTokens(name) {
  return String(name).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map(normWord).filter((w) => !STOP_MATCH.has(w));
}

// Best matching food for some words, or null. score: 0..1
function bestFood(words, foods) {
  if (!words.length) return null;
  let best = null;
  for (const f of foods) {
    const ft = f._tokens || (f._tokens = foodTokens(f.name));
    if (!ft.length) continue;
    let hitQ = 0; const hitF = new Set();
    for (const w of words) {
      let hit = -1;
      for (let i = 0; i < ft.length; i++) {
        const t = ft[i];
        if (t === w || (w.length >= 4 && t.length >= 4 && editDistance(t, w) <= (w.length >= 7 ? 2 : 1))) { hit = i; break; }
      }
      if (hit >= 0) { hitQ++; hitF.add(hit); }
    }
    if (!hitQ) continue;
    const score = 0.65 * (hitQ / words.length) + 0.35 * (hitF.size / ft.length);
    // Prefer verified foods, then the user's own, then the shorter (more basic) name
    const tie = (f.verified ? 0.02 : 0) - ft.length * 0.001;
    if (!best || score + tie > best.score + best.tie) best = { food: f, score, tie };
  }
  return best && best.score >= 0.4 ? best : null;
}

// How many servings of food f is qty × unit?
function toServings(qty, unit, food) {
  const sv = parseServing(food.serving);
  const weighed = ['g', 'kg', 'ml', 'l'];
  if (weighed.includes(unit) && sv.grams) return (qty * UNIT_GRAMS[unit]) / sv.grams;
  if (!unit || unit === 'serving') return qty / (sv.unit === 'piece' || !sv.unit ? sv.count || 1 : 1);
  if (unit === sv.unit) return qty / (sv.count || 1);
  if (unit === 'piece') return qty / (sv.count || 1);
  const userGrams = UNIT_GRAMS[unit] ? qty * UNIT_GRAMS[unit] : null;
  if (userGrams != null && sv.grams) return userGrams / sv.grams;
  return qty; // we cannot convert: treat each unit as one serving
}

function parseText(text, foods) {
  const items = [];
  for (const seg of splitItems(text)) {
    const amt = readAmount(seg);
    if (!amt.words.length) continue;
    const match = bestFood(amt.words, foods);
    const unitOut = amt.unit || 'serving';
    if (!match) {
      items.push({ text: seg, name: amt.words.join(' '), food_id: null, qty: amt.qty, unit: unitOut, servings: null,
        kcal: null, protein: null, carbs: null, fat: null, matched: false });
      continue;
    }
    const f = match.food;
    const sv = parseServing(f.serving);
    const servings = calc.round(toServings(amt.qty, amt.unit, f), 2);
    items.push({
      text: seg,
      name: f.name,
      food_id: f.id,
      qty: amt.qty,
      unit: amt.unit || (sv.unit === 'piece' || (!sv.unit && !sv.grams) ? 'piece' : 'serving'),
      servings,
      serving: f.serving,
      kcal: calc.round(f.kcal * servings),
      protein: calc.round(f.protein_g * servings, 1),
      carbs: calc.round(f.carbs_g * servings, 1),
      fat: calc.round(f.fat_g * servings, 1),
      matched: true,
      confidence: calc.round(match.score, 2),
    });
  }
  const m = items.filter((i) => i.matched);
  // Nothing matched -> totals are null (never a fake 0)
  const sum = (k, d) => (m.length ? calc.round(m.reduce((s, i) => s + i[k], 0), d) : null);
  return { items, totals: { kcal: sum('kcal', 0), protein: sum('protein', 1), carbs: sum('carbs', 1), fat: sum('fat', 1) } };
}

module.exports = { parseText, splitItems, readAmount, parseServing, toServings };
