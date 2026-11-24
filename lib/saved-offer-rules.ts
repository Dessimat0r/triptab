import { savedOfferSchema, type SavedOffer } from './offer-rules';

export const savedOfferKey = (name: string) => name.trim().normalize('NFKC').toLowerCase();

export async function readSavedOffers(database: D1Database, userId: string): Promise<SavedOffer[]> {
  const result = await database.prepare('SELECT data FROM receipt_offer_rules WHERE user_id=? ORDER BY rule_key LIMIT 50').bind(userId).all<{ data: string }>();
  return result.results.map(row => savedOfferSchema.parse(JSON.parse(row.data)));
}
