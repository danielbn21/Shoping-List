// Automatic category for a scanned item (1.2.0). Deterministic and local; nothing is sent anywhere.
// suggestCategory() tries, in this order, and stops at the first that gives a category the household has:
//   1. the category of the household item the name is most like        ('similar')
//   2. the category last used for the same manufacturer                 ('manufacturer')
//   3. the category most used by items that share a distinctive word    ('words')
//   4. the built-in keyword table below, English and Hebrew             ('keyword')
// Categories are only ever chosen from the household's own list; this module never creates one.

const GROUPS = [
  { en: ['Produce', 'Fruit & vegetables', 'Fruits and vegetables'], he: ['פירות וירקות', 'ירקות ופירות'],
    words: 'apple apples banana bananas orange oranges lemon lemons lime tomato tomatoes cucumber cucumbers carrot carrots potato potatoes onion onions garlic lettuce cabbage broccoli cauliflower pepper peppers zucchini eggplant avocado mushroom mushrooms spinach parsley coriander cilantro dill mint basil strawberry strawberries grape grapes melon watermelon peach pear plum mango pineapple kiwi cherry cherries fruit vegetables salad herbs ' +
      'תפוח תפוחים בננה בננות תפוז תפוזים לימון עגבניה עגבניות מלפפון מלפפונים גזר תפוח אדמה תפוחי בצל שום חסה כרוב ברוקולי כרובית פלפל קישוא חציל אבוקדו פטריות תרד פטרוזיליה כוסברה שמיר נענע בזיליקום תות ענבים אבטיח מלון אפרסק אגס שזיף מנגו אננס קיווי דובדבנים פירות ירקות' },
  { en: ['Bakery', 'Bread & bakery'], he: ['מאפים ולחם', 'לחם ומאפים'],
    words: 'bread bagel bagels pita roll rolls baguette challah croissant muffin cake cakes pastry bun buns toast tortilla wraps ' +
      'לחם לחמניה לחמניות פיתה פיתות חלה בגט קרואסון מאפין עוגה עוגות בורקס בורקסים טוסט טורטייה' },
  { en: ['Dairy & eggs', 'Dairy', 'Dairy and eggs'], he: ['מוצרי חלב וביצים', 'חלב וביצים', 'מוצרי חלב'],
    words: 'milk cheese yogurt yoghurt butter cream eggs egg cottage labane labneh mozzarella gouda parmesan feta kefir pudding ' +
      'חלב גבינה גבינות יוגורט חמאה שמנת ביצים ביצה קוטג לבנה מוצרלה גאודה פרמזן פטה קפיר פודינג שמנת' },
  { en: ['Meat & fish', 'Meat and fish', 'Meat'], he: ['בשר ודגים', 'בשר ועוף', 'בשר'],
    words: 'chicken beef lamb turkey steak schnitzel sausage sausages salami ham fish salmon tuna tilapia cod shrimp burger meatballs minced mince ' +
      'עוף בשר בקר כבש הודו סטייק שניצל נקניק נקניקיות סלמי פסטרמה דג דגים סלמון טונה אמנון בקלה שרימפס המבורגר קציצות טחון' },
  { en: ['Frozen'], he: ['קפואים'],
    words: 'frozen icecream gelato popsicle ' +
      'קפוא קפואים קפואה גלידה גלידות שלגון' },
  { en: ['Pantry', 'Dry goods'], he: ['מזווה', 'מוצרי יבשים'],
    words: 'rice pasta spaghetti noodles flour sugar salt oil olive vinegar sauce ketchup mayonnaise mustard tahini honey jam spread cereal oats oatmeal beans lentils chickpeas hummus canned corn tuna soup spice spices cumin paprika turmeric cinnamon baking yeast coffee tea cocoa ' +
      'אורז פסטה ספגטי אטריות קמח סוכר מלח שמן זית חומץ רוטב קטשופ מיונז חרדל טחינה דבש ריבה ממרח דגני קורנפלקס שיבולת שועל שעועית עדשים חומוס גרגירי שימורים תירס מרק תבלין תבלינים כמון פפריקה כורכום קינמון אפיה שמרים קפה תה קקאו' },
  { en: ['Snacks & sweets', 'Snacks', 'Sweets'], he: ['חטיפים וממתקים', 'חטיפים', 'ממתקים'],
    words: 'chips crisps snack snacks chocolate candy candies cookie cookies biscuit biscuits wafer wafers gum nuts peanuts almonds popcorn pretzels bamba bisli ' +
      'חטיף חטיפים שוקולד סוכריה סוכריות עוגיה עוגיות ביסקוויט ופלים מסטיק אגוזים בוטנים שקדים פופקורן בייגלה במבה ביסלי תפוצ\'יפס' },
  { en: ['Drinks', 'Beverages'], he: ['משקאות', 'שתייה'],
    words: 'water juice soda cola lemonade beer wine vodka whiskey drink drinks sparkling energy tonic ' +
      'מים מיץ מיצים סודה קולה לימונדה בירה יין וודקה ויסקי שתייה משקה משקאות מוגז אנרגיה' },
  { en: ['Cleaning', 'Household'], he: ['ניקיון', 'מוצרי ניקיון'],
    words: 'detergent bleach cleaner dishwasher sponge sponges trash garbage bags foil napkins tissues softener laundry soap dish ' +
      'כביסה מרכך מלבין מנקה נוזל כלים ספוג ספוגים שקיות אשפה מפיות טישו כביסה' },
  { en: ['Personal care', 'Toiletries', 'Health & beauty'], he: ['טיפוח והיגיינה', 'טיפוח', 'היגיינה'],
    words: 'shampoo conditioner toothpaste toothbrush deodorant lotion razor tampons pads cotton sunscreen perfume mouthwash floss ' +
      'שמפו מרכך משחת שיניים מברשת דאודורנט קרם גילוח טמפונים תחבושות צמר גפן קרם הגנה בושם שטיפת פה חוט דנטלי סבון' },
  { en: ['Baby', 'Babies'], he: ['תינוקות', 'מוצרי תינוקות'],
    words: 'diaper diapers nappies wipes formula baby ' +
      'חיתול חיתולים מגבונים מטרנה תינוק תינוקות ' },
  { en: ['Pets', 'Pet supplies'], he: ['חיות מחמד', 'חיות'],
    words: 'dog cat pet litter kibble ' +
      'כלב כלבים חתול חתולים לכלבים לחתולים חיות' },
];

const WORD_TO_GROUP = new Map();
GROUPS.forEach((g, i) => { for (const w of g.words.split(/\s+/).filter(Boolean)) if (!WORD_TO_GROUP.has(w)) WORD_TO_GROUP.set(w, i); });

// Letters only, lower case; digits, units and punctuation never count as words.
export const wordsOf = (s) => String(s ?? '').toLowerCase().replace(/[\u0591-\u05C7]/g, '').split(/[^\p{L}]+/u).filter((w) => w.length >= 2);
const HE_PREFIX = /^[הוכלבמש]/;
const STOP = new Set(['the', 'and', 'with', 'for', 'new', 'big', 'small', 'free', 'light', 'fresh', 'pack', 'kg', 'ml', 'gr', 'של', 'עם', 'ללא', 'חדש', 'יח', 'יחידות', 'גרם', 'מל', 'ק"ג']);

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function keywordGroup(name) {
  for (const w of wordsOf(name)) {
    const cands = [w, w.length > 3 ? w.replace(/(ies)$/, 'y') : w, w.length > 3 ? w.replace(/s$/, '') : w];
    if (HE_PREFIX.test(w) && w.length > 3) cands.push(w.slice(1));
    for (const c of cands) if (WORD_TO_GROUP.has(c)) return WORD_TO_GROUP.get(c);
  }
  return null;
}

// The household's category that a group names, or null (the household may have renamed or removed it).
function categoryOfGroup(group, categories) {
  const g = GROUPS[group];
  const want = new Set([...g.en, ...g.he].map(norm));
  return categories.find((c) => want.has(norm(c.nameEn)) || want.has(norm(c.nameHe))) ?? null;
}

// ctx: { name, manufacturer, similar: { categoryId } | null, categories: [{ id, nameEn, nameHe }], items: [{ id, name, categoryId, createdAt }],
//        byManufacturer: [{ itemId }] (newest first, the items whose barcode has this manufacturer) }
// -> { categoryId, how } | null
export function suggestCategory({ name, similar = null, categories = [], items = [], byManufacturer = [] }) {
  const has = (id) => id && categories.some((c) => c.id === id);
  if (has(similar?.categoryId)) return { categoryId: similar.categoryId, how: 'similar' };

  const catOf = new Map(items.map((i) => [i.id, i.categoryId]));
  for (const m of byManufacturer) { const c = catOf.get(m.itemId); if (has(c)) return { categoryId: c, how: 'manufacturer' }; }

  const mine = new Set(wordsOf(name).filter((w) => w.length >= 3 && !STOP.has(w)));
  if (mine.size) {
    const tally = new Map();
    for (const it of items) {
      if (!has(it.categoryId)) continue;
      if (!wordsOf(it.name).some((w) => mine.has(w))) continue;
      const t = tally.get(it.categoryId) ?? { n: 0, newest: 0 };
      t.n += 1; t.newest = Math.max(t.newest, it.createdAt ?? 0); tally.set(it.categoryId, t);
    }
    const best = [...tally.entries()].sort((a, b) => b[1].n - a[1].n || b[1].newest - a[1].newest)[0];
    if (best) return { categoryId: best[0], how: 'words' };
  }

  const g = keywordGroup(name);
  if (g !== null) { const c = categoryOfGroup(g, categories); if (c) return { categoryId: c.id, how: 'keyword' }; }
  return null;
}
