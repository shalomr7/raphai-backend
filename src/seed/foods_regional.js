// seed/foods_regional.js — regional Indian dishes (added 2026-11-01).
// Typical HOME-STYLE recipe values per serving, worked out from common
// ingredient amounts (IFCT-style raw-ingredient values). Real values change a
// lot with oil, ghee and portion size; restaurant versions are usually richer.
// These rows are marked data_quality = 'typical_recipe' so the app labels
// them "Typical recipe" instead of "Verified". Weights are COOKED weights.
module.exports = [
  // Andhra / Telangana / South Indian breakfast & snacks
  { name: 'Egg Dosa', serving: '1 dosa with 1 egg', kcal: 240, protein_g: 10, carbs_g: 28, fat_g: 10 },
  { name: 'Rava Dosa', serving: '1 medium', kcal: 200, protein_g: 4, carbs_g: 30, fat_g: 7 },
  { name: 'Onion Uttapam', serving: '1 medium', kcal: 210, protein_g: 6, carbs_g: 34, fat_g: 6 },
  { name: 'Garelu (Andhra vada)', serving: '1 piece (40 g)', kcal: 140, protein_g: 4.5, carbs_g: 13, fat_g: 8 },
  { name: 'Mysore Bonda', serving: '1 piece (35 g)', kcal: 120, protein_g: 2.5, carbs_g: 15, fat_g: 5.5 },
  { name: 'Punugulu', serving: '6 pieces (70 g)', kcal: 200, protein_g: 5, carbs_g: 24, fat_g: 9.5 },
  { name: 'Mirchi Bajji', serving: '1 piece', kcal: 140, protein_g: 2.5, carbs_g: 14, fat_g: 8.5 },
  { name: 'Onion Pakoda', serving: '1 small plate (60 g)', kcal: 220, protein_g: 5, carbs_g: 20, fat_g: 13.5 },
  // Andhra meals
  { name: 'Pappu (Andhra dal)', serving: '1 katori (150 g)', kcal: 170, protein_g: 9, carbs_g: 22, fat_g: 5 },
  { name: 'Tomato Pappu', serving: '1 katori (150 g)', kcal: 160, protein_g: 8, carbs_g: 20, fat_g: 5.5 },
  { name: 'Rasam', serving: '1 katori (150 ml)', kcal: 60, protein_g: 2, carbs_g: 9, fat_g: 2 },
  { name: 'Vegetable Pulusu', serving: '1 katori (150 g)', kcal: 110, protein_g: 2, carbs_g: 14, fat_g: 5.5 },
  { name: 'Chepala Pulusu (fish curry)', serving: '1 katori with 1 piece (150 g)', kcal: 220, protein_g: 20, carbs_g: 8, fat_g: 12 },
  { name: 'Gongura Pachadi', serving: '1 tbsp (15 g)', kcal: 40, protein_g: 0.5, carbs_g: 2, fat_g: 3.5 },
  { name: 'Avakaya (mango pickle)', serving: '1 tbsp (15 g)', kcal: 60, protein_g: 0.5, carbs_g: 2, fat_g: 6 },
  { name: 'Lemon Rice', serving: '1 katori (150 g)', kcal: 250, protein_g: 4, carbs_g: 40, fat_g: 8 },
  { name: 'Pulihora (tamarind rice)', serving: '1 katori (150 g)', kcal: 270, protein_g: 4, carbs_g: 42, fat_g: 9.5 },
  { name: 'Bisi Bele Bath', serving: '1 katori (200 g)', kcal: 280, protein_g: 8, carbs_g: 42, fat_g: 9 },
  { name: 'Andhra Meals (veg thali)', serving: '1 plate: 2 katori rice, pappu, curry, sambar, rasam, curd', kcal: 850, protein_g: 24, carbs_g: 130, fat_g: 24 },
  // Biryani
  { name: 'Hyderabadi Chicken Dum Biryani', serving: '1 plate (350 g)', kcal: 620, protein_g: 30, carbs_g: 70, fat_g: 24 },
  { name: 'Mutton Biryani', serving: '1 plate (350 g)', kcal: 700, protein_g: 32, carbs_g: 68, fat_g: 32 },
  { name: 'Egg Biryani', serving: '1 plate (300 g, 2 eggs)', kcal: 520, protein_g: 18, carbs_g: 66, fat_g: 20 },
  // Non-veg
  { name: 'Chicken Fry (Andhra)', serving: '1 katori (150 g)', kcal: 330, protein_g: 28, carbs_g: 6, fat_g: 22 },
  { name: 'Chicken 65', serving: '100 g', kcal: 290, protein_g: 20, carbs_g: 12, fat_g: 18 },
  { name: 'Mutton Curry', serving: '1 katori (150 g)', kcal: 300, protein_g: 22, carbs_g: 6, fat_g: 21 },
  { name: 'Prawn Curry', serving: '1 katori (150 g)', kcal: 200, protein_g: 20, carbs_g: 6, fat_g: 11 },
  { name: 'Fish Fry', serving: '1 piece (100 g)', kcal: 220, protein_g: 20, carbs_g: 6, fat_g: 13 },
  { name: 'Egg Curry', serving: '2 eggs with gravy', kcal: 250, protein_g: 14, carbs_g: 8, fat_g: 18 },
  { name: 'Butter Chicken', serving: '1 katori (150 g)', kcal: 340, protein_g: 24, carbs_g: 10, fat_g: 23 },
  { name: 'Tandoori Chicken', serving: '2 pieces (200 g)', kcal: 300, protein_g: 40, carbs_g: 4, fat_g: 14 },
  // North Indian
  { name: 'Paneer Butter Masala', serving: '1 katori (150 g)', kcal: 380, protein_g: 14, carbs_g: 14, fat_g: 30 },
  { name: 'Kadai Paneer', serving: '1 katori (150 g)', kcal: 300, protein_g: 14, carbs_g: 10, fat_g: 22 },
  { name: 'Aloo Gobi', serving: '1 katori (150 g)', kcal: 150, protein_g: 3.5, carbs_g: 17, fat_g: 8 },
  { name: 'Bhindi Fry', serving: '1 katori (100 g)', kcal: 140, protein_g: 3, carbs_g: 12, fat_g: 9 },
  { name: 'Dal Makhani', serving: '1 katori (150 g)', kcal: 280, protein_g: 11, carbs_g: 26, fat_g: 15 },
  { name: 'Kadhi', serving: '1 katori (150 g)', kcal: 160, protein_g: 6, carbs_g: 14, fat_g: 9 },
  { name: 'Butter Naan', serving: '1 piece', kcal: 320, protein_g: 8, carbs_g: 45, fat_g: 12 },
  { name: 'Tandoori Roti', serving: '1 piece', kcal: 120, protein_g: 4, carbs_g: 24, fat_g: 1 },
  // Street food
  { name: 'Pav Bhaji', serving: '1 plate (bhaji + 2 pav)', kcal: 420, protein_g: 10, carbs_g: 58, fat_g: 16 },
  { name: 'Vada Pav', serving: '1 piece', kcal: 290, protein_g: 6, carbs_g: 40, fat_g: 12 },
  { name: 'Pani Puri', serving: '6 pieces', kcal: 220, protein_g: 4, carbs_g: 34, fat_g: 8 },
  { name: 'Bhel Puri', serving: '1 plate (100 g)', kcal: 250, protein_g: 6, carbs_g: 40, fat_g: 8 },
  { name: 'Dhokla', serving: '2 pieces (100 g)', kcal: 160, protein_g: 6, carbs_g: 24, fat_g: 4.5 },
  { name: 'Kachori', serving: '1 piece', kcal: 190, protein_g: 4, carbs_g: 20, fat_g: 10.5 },
  // Sweets
  { name: 'Gulab Jamun', serving: '1 piece with syrup', kcal: 150, protein_g: 2, carbs_g: 22, fat_g: 6 },
  { name: 'Jalebi', serving: '50 g', kcal: 200, protein_g: 1, carbs_g: 30, fat_g: 8.5 },
  { name: 'Rasgulla', serving: '1 piece with syrup', kcal: 120, protein_g: 2, carbs_g: 26, fat_g: 1 },
  { name: 'Payasam / Kheer', serving: '1 katori (150 g)', kcal: 220, protein_g: 6, carbs_g: 32, fat_g: 7.5 },
  { name: 'Besan Laddu', serving: '1 piece (40 g)', kcal: 180, protein_g: 4, carbs_g: 20, fat_g: 9.5 },
  { name: 'Mysore Pak', serving: '1 piece (35 g)', kcal: 190, protein_g: 2, carbs_g: 16, fat_g: 13 },
  // Drinks & packaged
  { name: 'Sweet Lassi', serving: '1 glass (250 ml)', kcal: 220, protein_g: 8, carbs_g: 34, fat_g: 6 },
  { name: 'Tender Coconut Water', serving: '1 glass (250 ml)', kcal: 45, protein_g: 0.5, carbs_g: 10, fat_g: 0.2 },
  { name: 'Sugarcane Juice', serving: '1 glass (250 ml)', kcal: 180, protein_g: 0, carbs_g: 45, fat_g: 0 },
  { name: 'Badam Milk', serving: '1 glass (250 ml)', kcal: 220, protein_g: 8, carbs_g: 28, fat_g: 8 },
  { name: 'Glucose Biscuits', serving: '4 biscuits (28 g)', kcal: 125, protein_g: 2, carbs_g: 21, fat_g: 3.5 },
  { name: 'Instant Noodles', serving: '1 pack (70 g dry)', kcal: 310, protein_g: 7, carbs_g: 44, fat_g: 12 },
  { name: 'Potato Chips', serving: '1 small pack (30 g)', kcal: 160, protein_g: 2, carbs_g: 15, fat_g: 10 },
];
