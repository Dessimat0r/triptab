import { z } from 'zod';

// Stable, curated IDs keep saved receipts independent of icon-library internals.
export const ICON_CATALOG = [
  ['Utensils', 'Meals', 'Food', 'restaurant dinner lunch breakfast food dining pasta risotto meal entree omelette'],
  ['UtensilsCrossed', 'Dining out', 'Food', 'bistro tavern table'],
  ['CookingPot', 'Cooking', 'Food', 'kitchen cooking pot'],
  ['ChefHat', 'Chef', 'Food', 'chef catering'],
  ['Sandwich', 'Sandwich', 'Food', 'sandwich baguette toast panini'],
  ['Pizza', 'Pizza', 'Food', 'pizza pizzeria'],
  ['Beef', 'Meat', 'Food', 'beef steak meat barbecue bbq'],
  ['Fish', 'Seafood', 'Food', 'fish seafood sushi'],
  ['Salad', 'Salad', 'Food', 'salad vegetarian vegan'],
  ['Soup', 'Soup', 'Food', 'soup ramen noodles'],
  ['Croissant', 'Bakery', 'Food', 'bakery croissant pastry bread'],
  ['CakeSlice', 'Cake', 'Food', 'cake dessert patisserie'],
  ['IceCreamBowl', 'Ice cream', 'Food', 'ice cream gelato sorbet'],
  ['Candy', 'Sweets', 'Food', 'candy sweets chocolate'],
  ['Apple', 'Fruit', 'Food', 'fruit apple bananas'],
  ['Carrot', 'Vegetables', 'Food', 'vegetables carrot produce'],
  ['Coffee', 'Coffee', 'Drinks', 'coffee cafe espresso cappuccino latte tea'],
  ['CupSoda', 'Soft drinks', 'Drinks', 'soda cola lemonade soft drink'],
  ['Beer', 'Beer', 'Drinks', 'beer pub lager ale brewery'],
  ['Wine', 'Wine', 'Drinks', 'wine vineyard tasting'],
  ['Martini', 'Cocktails', 'Drinks', 'cocktail martini bar gin spirits'],
  ['GlassWater', 'Water', 'Drinks', 'water juice'],
  ['Milk', 'Milk', 'Drinks', 'milk dairy'],
  ['BottleWine', 'Wine bottle', 'Drinks', 'bottle wine cellar'],
  ['Plane', 'Flights', 'Transport', 'flight plane airline aviation airport'],
  ['Car', 'Taxi & car', 'Transport', 'taxi car uber bolt rental cab'],
  ['Bus', 'Bus', 'Transport', 'bus coach shuttle'],
  ['TrainFront', 'Train', 'Transport', 'train rail railway'],
  ['TramFront', 'Tram & metro', 'Transport', 'tram metro subway underground tube'],
  ['Ship', 'Ferry', 'Transport', 'ferry cruise ship boat'],
  ['Sailboat', 'Sailing', 'Transport', 'sailing yacht sailboat'],
  ['Bike', 'Bicycle', 'Transport', 'bike bicycle cycling cycle'],
  ['Footprints', 'Walking', 'Transport', 'walking walk hike footsteps'],
  ['Fuel', 'Fuel', 'Transport', 'fuel petrol diesel gas station'],
  ['ParkingCircle', 'Parking', 'Transport', 'parking car park'],
  ['CableCar', 'Cable car', 'Transport', 'cable car ski lift gondola'],
  ['Ticket', 'Tickets', 'Transport', 'ticket admission pass'],
  ['MapPin', 'Location', 'Transport', 'location map destination'],
  ['Hotel', 'Hotel', 'Stays', 'hotel hostel accommodation lodging'],
  ['BedDouble', 'Room', 'Stays', 'bed room sleep overnight'],
  ['House', 'Holiday home', 'Stays', 'house apartment home airbnb villa'],
  ['Building2', 'Building', 'Stays', 'building city apartment'],
  ['Tent', 'Camping', 'Stays', 'tent camping campsite'],
  ['Caravan', 'Caravan', 'Stays', 'caravan camper motorhome'],
  ['KeyRound', 'Keys', 'Stays', 'key deposit check in'],
  ['Bath', 'Bath & spa', 'Stays', 'bath spa sauna'],
  ['ShowerHead', 'Shower', 'Stays', 'shower bathroom'],
  ['WashingMachine', 'Laundry', 'Stays', 'laundry washing laundrette'],
  ['Camera', 'Photography', 'Activities', 'camera photo photography'],
  ['Mountain', 'Mountains', 'Activities', 'mountain climbing hiking'],
  ['Palmtree', 'Beach', 'Activities', 'beach palm tropical'],
  ['Waves', 'Swimming', 'Activities', 'swimming surf pool waves'],
  ['Volleyball', 'Sport', 'Activities', 'sport volleyball football tennis'],
  ['Dumbbell', 'Gym', 'Activities', 'gym fitness exercise'],
  ['Music', 'Music', 'Activities', 'music concert festival gig'],
  ['Theater', 'Cinema & theatre', 'Activities', 'cinema theatre theater film movie'],
  ['Landmark', 'Museums & sights', 'Activities', 'museum landmark monument gallery sightseeing'],
  ['FerrisWheel', 'Theme park', 'Activities', 'theme park amusement funfair rides'],
  ['Drama', 'Performance', 'Activities', 'performance opera drama show'],
  ['PartyPopper', 'Celebration', 'Activities', 'party celebration birthday'],
  ['Gamepad2', 'Games', 'Activities', 'game arcade bowling gaming'],
  ['BookOpen', 'Books', 'Activities', 'book reading library'],
  ['Compass', 'Exploring', 'Activities', 'tour exploring compass guide'],
  ['Sun', 'Sunshine', 'Activities', 'sun sunshine summer'],
  ['Umbrella', 'Umbrella', 'Activities', 'umbrella rain parasol'],
  ['Backpack', 'Backpack', 'Activities', 'backpack trek trekking'],
  ['Binoculars', 'Wildlife', 'Activities', 'wildlife safari binoculars'],
  ['ShoppingBag', 'Shopping', 'Shopping', 'shopping shop purchases retail'],
  ['ShoppingCart', 'Groceries', 'Shopping', 'groceries grocery supermarket market'],
  ['Shirt', 'Clothes', 'Shopping', 'clothes clothing shirt fashion shoes'],
  ['Watch', 'Watch', 'Shopping', 'watch clock accessories'],
  ['Gift', 'Gifts', 'Shopping', 'gift souvenir present'],
  ['Gem', 'Jewellery', 'Shopping', 'jewellery jewelry gem ring'],
  ['Store', 'Shop', 'Shopping', 'store convenience shop'],
  ['Smartphone', 'Phone', 'Shopping', 'phone sim mobile smartphone'],
  ['Headphones', 'Headphones', 'Shopping', 'headphones audio electronics'],
  ['HeartPulse', 'Health', 'Health & family', 'health medical insurance'],
  ['Pill', 'Pharmacy', 'Health & family', 'pharmacy medicine pill medication'],
  ['Cross', 'First aid', 'Health & family', 'first aid emergency bandage'],
  ['Hospital', 'Hospital', 'Health & family', 'hospital clinic'],
  ['Stethoscope', 'Doctor', 'Health & family', 'doctor dentist medical appointment'],
  ['Baby', 'Baby', 'Health & family', 'baby nappies diapers childcare'],
  ['Accessibility', 'Accessibility', 'Health & family', 'accessibility wheelchair assistance'],
  ['Receipt', 'Receipt', 'Other', 'receipt expense general other tab'],
  ['Wallet', 'Wallet', 'Other', 'wallet payment budget'],
  ['CreditCard', 'Card', 'Other', 'credit card debit card bank'],
  ['Banknote', 'Cash', 'Other', 'cash banknote money'],
  ['Coins', 'Coins', 'Other', 'coins change currency'],
  ['BadgePoundSterling', 'Pounds', 'Other', 'pounds sterling gbp'],
  ['BadgeEuro', 'Euros', 'Other', 'euros euro eur'],
  ['HandCoins', 'Tips', 'Other', 'tip gratuity donation'],
  ['Luggage', 'Luggage', 'Other', 'luggage baggage suitcase'],
  ['Dog', 'Pets', 'Other', 'pet dog cat animal'],
  ['Sparkles', 'Special', 'Other', 'special sparkle treat'],
  ['Scissors', 'Haircut', 'Other', 'haircut barber salon hairdresser'],
  ['Wifi', 'Internet', 'Other', 'wifi internet data roaming'],
  ['Plug', 'Charging', 'Other', 'charging electric electricity plug'],
  ['Wrench', 'Repairs', 'Other', 'repair mechanic maintenance'],
  ['Package', 'Delivery', 'Other', 'delivery parcel package postage'],
  ['CircleHelp', 'Something else', 'Other', 'unknown help question something else'],
] as const;

export const ICON_BACKGROUNDS = [
  ['indigo', 'Indigo', '#4355db'], ['blue', 'Blue', '#2563eb'],
  ['cyan', 'Cyan', '#0e7490'], ['teal', 'Teal', '#0f766e'],
  ['green', 'Green', '#15803d'], ['lime', 'Lime', '#4d7c0f'],
  ['gold', 'Gold', '#a16207'], ['orange', 'Orange', '#c2410c'],
  ['red', 'Red', '#b91c1c'], ['rose', 'Rose', '#be123c'],
  ['pink', 'Pink', '#be185d'], ['purple', 'Purple', '#7e22ce'],
  ['violet', 'Violet', '#6d28d9'], ['slate', 'Slate', '#475569'],
] as const;
export type ExpenseSymbol = typeof ICON_CATALOG[number][0];
export type IconBackground = typeof ICON_BACKGROUNDS[number][0];
export const expenseIconSchema = z.object({
  symbol: z.enum(ICON_CATALOG.map(icon => icon[0]) as [ExpenseSymbol, ...ExpenseSymbol[]]),
  background: z.enum(ICON_BACKGROUNDS.map(color => color[0]) as [IconBackground, ...IconBackground[]]),
}).strict();
export type ExpenseIconChoice = z.infer<typeof expenseIconSchema>;
export type IconReceipt = {
  title?: string;
  titleSource?: 'user' | 'receipt' | 'ai' | 'default';
  fieldSources?: { title?: IconReceipt['titleSource'] };
  items?: readonly { name: string; translations?: Readonly<Record<string, { text: string } | undefined>> }[];
  icon?: ExpenseIconChoice;
  suggestedIcon?: ExpenseIconChoice;
};

export function iconSearchText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function mentions(text: string, normalizedTerm: string) { return text.includes(` ${normalizedTerm} `); }
const TITLE_RULES: readonly [ExpenseSymbol, IconBackground, string][] = [
  ['ShoppingCart', 'green', 'supermarket|supermercado|supermarche|supermarkt|supermercato|groceries|grocery|tesco|lidl|aldi|carrefour|auchan|mercadona|continente|sainsbury|sainsburys|waitrose|rewe|edeka|coop|co op|tabac|food shop'],
  ['Car', 'blue', 'taxi|uber|bolt|cab|car rental|rental car|car hire|autovermietung|location voiture'],
  ['ParkingCircle', 'slate', 'parking|car park|aparcamiento|parkhaus|parcheggio|estacionamento'],
  ['Fuel', 'orange', 'fuel|petrol|diesel|gas station|gasolina|carburant|tankstelle|benzina|posto combustivel'],
  ['TrainFront', 'blue', 'train|rail|railway|sncf|renfe|trenitalia|deutsche bahn|eurostar|trem|zug'],
  ['TramFront', 'blue', 'metro|tram|subway|underground'],
  ['Bus', 'blue', 'bus|coach|shuttle|autobus|autocarro'],
  ['Bike', 'teal', 'bike|bicycle|cycling|velo|bicicleta|fahrrad'],
  ['Ship', 'cyan', 'ferry|cruise|bateau|traghetto|boat|boat tour'],
  ['Compass', 'purple', 'tour|guided tour'],
  ['Plane', 'blue', 'flight|airline|ryanair|easyjet|aeroplane|flug|vuelo|voo'],
  ['Tent', 'green', 'camping|campsite|campground|campismo'],
  ['House', 'violet', 'airbnb|holiday home|holiday apartment|villa rental'],
  ['Hotel', 'violet', 'hotel|hostel|lodging|accommodation|albergo|pension|auberge'],
  ['Pill', 'rose', 'pharmacy|farmacia|pharmacie|apotheke|medicine'],
  ['Landmark', 'purple', 'museum|museo|musee|museu|gallery|monument'],
  ['Theater', 'purple', 'cinema|theatre|theater|teatro|kino'],
  ['Music', 'purple', 'concert|festival|gig|concerto'],
  ['Croissant', 'gold', 'bakery|boulangerie|panaderia|backerei|padaria|pasticceria'],
  ['Coffee', 'gold', 'coffee|cafe|cafeteria|caffe|espresso|starbucks|costa coffee'],
  ['IceCreamBowl', 'pink', 'ice cream|gelato|gelateria|heladeria|sorvete'],
  ['Pizza', 'orange', 'pizza|pizzeria'],
  ['Beer', 'gold', 'pub|brewery|beer|bier|cerveja|cerveza'],
  ['Martini', 'pink', 'cocktail|bar|martini'],
  ['Utensils', 'orange', 'restaurant|restaurante|ristorante|dinner|lunch|breakfast|dining|meal|meals|bistro|taverna|trattoria|tapas|osteria|brasserie|izakaya'],
];
const groupColors: Record<string, IconBackground> = { Food: 'orange', Drinks: 'gold', Transport: 'blue', Stays: 'violet', Activities: 'purple', Shopping: 'green', 'Health & family': 'rose', Other: 'indigo' };
export function defaultBackground(symbol: ExpenseSymbol): IconBackground {
  return TITLE_RULES.find(rule => rule[0] === symbol)?.[1]
    ?? groupColors[ICON_CATALOG.find(icon => icon[0] === symbol)![2]];
}
const normalizedTitleRules = TITLE_RULES.map(([symbol, background, terms]) => ({symbol,background,terms:terms.split('|').map(iconSearchText)}));
const normalizedLabels = ICON_CATALOG.map(([symbol,label,group]) => ({symbol,background:groupColors[group],term:iconSearchText(label)}));
const titleCandidates = [
  ...normalizedTitleRules.flatMap(({symbol,background,terms}) => terms.map(term => ({symbol,background,term}))),
  ...normalizedLabels.filter(rule => rule.symbol !== 'Receipt'),
];
const groceries = new Set(['milk', 'bread', 'cheese', 'butter', 'eggs', 'rice', 'pasta', 'bananas', 'apples', 'potatoes', 'tomatoes', 'leche', 'pan', 'queso', 'lait', 'pain', 'fromage', 'leite', 'pao', 'queijo', 'milch', 'brot', 'kase']);
const generic = new Set(['receipt', 'expense', 'general', 'other', 'tab', 'payment', 'budget', 'change', 'currency', 'unknown', 'help', 'question', 'something', 'else', 'card', 'bank', 'station', 'cream', 'park', 'holiday', 'check', 'first', 'aid', 'pass', 'cable', 'data', 'soft']);
// Index once, then look up each observed word instead of rescanning the full
// catalogue for every receipt line on every React render.
const wordIcons = new Map<string, Set<number>>(), phraseIcons = new Map<string, Set<number>>();
function indexTerm(term: string, index: number) {
  if (generic.has(term) || term.length < 3) return;
  const map = term.includes(' ') ? phraseIcons : wordIcons;
  const ids = map.get(term) || new Set<number>(); ids.add(index); map.set(term,ids);
}
ICON_CATALOG.forEach(([, , , keywords],index) => keywords.split(' ').forEach(term => indexTerm(iconSearchText(term),index)));
normalizedTitleRules.forEach(rule => {
  const index=ICON_CATALOG.findIndex(icon=>icon[0]===rule.symbol);
  rule.terms.forEach(term=>indexTerm(term,index));
});

// A venue's specific service outranks its broader setting: restaurant > cafe/bar
// > hotel. Within a service, prefer the longest matching phrase or label.
function titleSpecificity(symbol: ExpenseSymbol): number {
  if (['Hotel', 'House', 'BedDouble', 'Building2'].includes(symbol)) return 0;
  if (ICON_CATALOG.find(icon => icon[0] === symbol)?.[2] === 'Drinks') return 1;
  if (symbol === 'Utensils') return 2;
  return 3;
}
function matchTitle(value?: string): ExpenseIconChoice | undefined {
  const title = ` ${iconSearchText(value || '')} `;
  const candidates = titleCandidates.filter(rule => mentions(title, rule.term));
  candidates.sort((a, b) => titleSpecificity(b.symbol) - titleSpecificity(a.symbol)
    || b.term.split(' ').length - a.term.split(' ').length || b.term.length - a.term.length);
  const best = candidates[0];
  return best && { symbol: best.symbol, background: best.background };
}

/** Uses already transcribed facts. Never calls a model or rewrites saved records. */
export function inferExpenseIcon(entry: IconReceipt): ExpenseIconChoice {
  const titleMatch = matchTitle(entry.title);
  if (titleMatch) return titleMatch;
  const scores = new Uint16Array(ICON_CATALOG.length);
  const phraseScores = new Uint16Array(ICON_CATALOG.length);
  const groupScores = new Map<string, number>();
  let groceryLines = 0;
  for (const item of entry.items || []) {
    // Count each physical line once, even if several translations match it.
    const hits = new Set<number>();
    const phraseHits = new Set<number>();
    let groceryLine = false;
    for (const name of [item.name, ...Object.values(item.translations ?? {}).map(value => value?.text ?? '')]) {
      const text=iconSearchText(name),words=new Set(text.split(' '));
      groceryLine ||= [...words].some(word=>groceries.has(word));
      for (const word of words) for (const index of wordIcons.get(word) || []) hits.add(index);
      for (const [term,indexes] of phraseIcons) if (mentions(` ${text} `,term)) for (const index of indexes) { hits.add(index); phraseHits.add(index); }
    }
    if (groceryLine) groceryLines++;
    for (const index of hits) scores[index]++;
    for (const index of phraseHits) phraseScores[index]++;
    for (const group of new Set([...hits].map(index => ICON_CATALOG[index][2]))) groupScores.set(group, (groupScores.get(group) ?? 0) + 1);
  }
  if (groceryLines >= 2 && groceryLines >= Math.max(0, ...groupScores.values())) return {symbol:'ShoppingCart',background:'green'};
  let best: ExpenseIconChoice = { symbol: 'Receipt', background: 'indigo' }, bestScore = 0;
  let bestGroupScore = 0;
  let bestPhraseScore = 0;
  ICON_CATALOG.forEach(([symbol, , group],index) => {
    const groupScore = groupScores.get(group) ?? 0;
    if (scores[index] && (groupScore > bestGroupScore || groupScore === bestGroupScore
      && (scores[index] > bestScore || scores[index] === bestScore && phraseScores[index] > bestPhraseScore))) {
      best={symbol,background:groupColors[group]};bestScore=scores[index];bestGroupScore=groupScore;bestPhraseScore=phraseScores[index];
    }
  });
  // Keep very weak or unknown evidence neutral rather than inventing a category.
  return best;
}

export function resolveExpenseIcon(entry: IconReceipt): ExpenseIconChoice {
  return entry.icon
    || ((entry.titleSource ?? entry.fieldSources?.title) === 'user' ? matchTitle(entry.title) : undefined)
    || entry.suggestedIcon
    || inferExpenseIcon(entry);
}
export function iconLabel(choice: ExpenseIconChoice): string {
  const symbol = ICON_CATALOG.find(icon => icon[0] === choice.symbol)?.[1] || 'Receipt';
  const color = ICON_BACKGROUNDS.find(color => color[0] === choice.background)?.[1] || 'Indigo';
  return `${symbol} · ${color}`;
}
