// seed/foods.js
// ------------------------------------------------------------
// A starter list of common Indian foods.
// Numbers are for ONE serving (see "serving") and are typical
// home-style values. Real values change with recipe and oil used,
// so treat them as good estimates, not lab results.
// kcal = calories, protein/carbs/fat are in grams.
// ------------------------------------------------------------

module.exports = [
  // Breads and rice
  { name: 'Roti / Chapati', serving: '1 medium (40 g)', kcal: 120, protein_g: 3, carbs_g: 18, fat_g: 3.7 },
  { name: 'Phulka (no ghee)', serving: '1 small (30 g)', kcal: 85, protein_g: 2.6, carbs_g: 17, fat_g: 0.5 },
  { name: 'Paratha (plain)', serving: '1 medium', kcal: 260, protein_g: 5, carbs_g: 36, fat_g: 10 },
  { name: 'Aloo Paratha', serving: '1 medium', kcal: 300, protein_g: 6, carbs_g: 42, fat_g: 12 },
  { name: 'Naan', serving: '1 piece', kcal: 260, protein_g: 8, carbs_g: 45, fat_g: 5 },
  { name: 'Puri', serving: '1 piece', kcal: 100, protein_g: 1.5, carbs_g: 11, fat_g: 5.5 },
  { name: 'Steamed Rice', serving: '1 katori (150 g cooked)', kcal: 195, protein_g: 4, carbs_g: 43, fat_g: 0.4 },
  { name: 'Brown Rice', serving: '1 katori (150 g cooked)', kcal: 170, protein_g: 4, carbs_g: 36, fat_g: 1.4 },
  { name: 'Jeera Rice', serving: '1 katori', kcal: 240, protein_g: 4, carbs_g: 42, fat_g: 6 },
  { name: 'Veg Biryani', serving: '1 plate (250 g)', kcal: 420, protein_g: 9, carbs_g: 62, fat_g: 15 },
  { name: 'Chicken Biryani', serving: '1 plate (300 g)', kcal: 500, protein_g: 25, carbs_g: 60, fat_g: 18 },

  // South Indian
  { name: 'Idli', serving: '1 piece', kcal: 58, protein_g: 2, carbs_g: 12, fat_g: 0.2 },
  { name: 'Plain Dosa', serving: '1 medium', kcal: 170, protein_g: 4, carbs_g: 28, fat_g: 4.5 },
  { name: 'Masala Dosa', serving: '1 piece', kcal: 290, protein_g: 6, carbs_g: 42, fat_g: 11 },
  { name: 'Upma', serving: '1 katori', kcal: 200, protein_g: 5, carbs_g: 30, fat_g: 7 },
  { name: 'Pongal', serving: '1 katori', kcal: 220, protein_g: 6, carbs_g: 30, fat_g: 8 },
  { name: 'Medu Vada', serving: '1 piece', kcal: 135, protein_g: 4, carbs_g: 13, fat_g: 7.5 },
  { name: 'Sambar', serving: '1 katori', kcal: 130, protein_g: 6, carbs_g: 18, fat_g: 4 },
  { name: 'Coconut Chutney', serving: '2 tbsp', kcal: 70, protein_g: 1, carbs_g: 3, fat_g: 6 },
  { name: 'Pesarattu', serving: '1 piece', kcal: 150, protein_g: 7, carbs_g: 20, fat_g: 4.5 },

  // Dal, curries, protein
  { name: 'Dal (toor/moong)', serving: '1 katori', kcal: 150, protein_g: 9, carbs_g: 20, fat_g: 4 },
  { name: 'Rajma', serving: '1 katori', kcal: 210, protein_g: 10, carbs_g: 28, fat_g: 6 },
  { name: 'Chole', serving: '1 katori', kcal: 240, protein_g: 11, carbs_g: 30, fat_g: 8 },
  { name: 'Paneer', serving: '100 g', kcal: 265, protein_g: 18, carbs_g: 1.2, fat_g: 21 },
  { name: 'Palak Paneer', serving: '1 katori', kcal: 260, protein_g: 12, carbs_g: 9, fat_g: 20 },
  { name: 'Egg (boiled)', serving: '1 large', kcal: 78, protein_g: 6, carbs_g: 0.6, fat_g: 5.3 },
  { name: 'Egg Omelette', serving: '2 eggs', kcal: 190, protein_g: 13, carbs_g: 2, fat_g: 14 },
  { name: 'Chicken Curry', serving: '1 katori (150 g)', kcal: 240, protein_g: 22, carbs_g: 6, fat_g: 14 },
  { name: 'Grilled Chicken Breast', serving: '100 g', kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 },
  { name: 'Fish Curry', serving: '1 katori (150 g)', kcal: 210, protein_g: 20, carbs_g: 5, fat_g: 12 },
  { name: 'Soya Chunks (cooked)', serving: '1 katori (50 g dry)', kcal: 170, protein_g: 26, carbs_g: 16, fat_g: 0.3 },
  { name: 'Mixed Veg Sabzi', serving: '1 katori', kcal: 120, protein_g: 3, carbs_g: 12, fat_g: 7 },
  { name: 'Curd / Dahi', serving: '1 katori (150 g)', kcal: 90, protein_g: 5, carbs_g: 7, fat_g: 4.5 },

  // Snacks and drinks
  { name: 'Poha', serving: '1 plate', kcal: 250, protein_g: 5, carbs_g: 40, fat_g: 8 },
  { name: 'Samosa', serving: '1 piece', kcal: 260, protein_g: 4, carbs_g: 28, fat_g: 15 },
  { name: 'Roasted Chana', serving: '30 g', kcal: 110, protein_g: 6, carbs_g: 17, fat_g: 1.8 },
  { name: 'Masala Chai (with sugar)', serving: '1 cup', kcal: 90, protein_g: 2.5, carbs_g: 13, fat_g: 3 },
  { name: 'Milk (toned)', serving: '1 glass (250 ml)', kcal: 145, protein_g: 8, carbs_g: 12, fat_g: 7.5 },
  { name: 'Buttermilk / Chaas', serving: '1 glass', kcal: 40, protein_g: 2, carbs_g: 4, fat_g: 1.5 },
  { name: 'Banana', serving: '1 medium', kcal: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4 },
  { name: 'Apple', serving: '1 medium', kcal: 95, protein_g: 0.5, carbs_g: 25, fat_g: 0.3 },
  { name: 'Peanuts', serving: '30 g', kcal: 170, protein_g: 7.5, carbs_g: 5, fat_g: 14 },
  { name: 'Whey Protein', serving: '1 scoop (30 g)', kcal: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 },
];
