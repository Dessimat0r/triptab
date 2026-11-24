import { db, ensureProfile, failure, profileWriteAuthorization, readBoundedBody, RequestError, sameOrigin } from '@/lib/store';
import { savedOfferSchema } from '@/lib/offer-rules';
import { readSavedOffers, savedOfferKey } from '@/lib/saved-offer-rules';
import { requestWriteAuthorizationSql } from '@/lib/auth';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    return Response.json(await readSavedOffers(db(), profile.id), { headers });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    sameOrigin(request);
    const profile = await ensureProfile(request);
    const parsed = savedOfferSchema.safeParse(JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))));
    if (!parsed.success) throw new RequestError('Enter a valid offer name and rule.');
    const rule = parsed.data;
    const key = savedOfferKey(rule.name);
    const auth = requestWriteAuthorizationSql(profileWriteAuthorization(profile), profile.id);
    const update = new URL(request.url).searchParams.get('replace') === 'true';
    const upsert = update ? `ON CONFLICT(user_id,rule_key) DO UPDATE SET data=excluded.data WHERE (${auth.condition})` : 'ON CONFLICT DO NOTHING';
    const result = await db().prepare(`INSERT INTO receipt_offer_rules(user_id,rule_key,data)
      SELECT ?,?,? WHERE (${auth.condition}) AND (EXISTS (SELECT 1 FROM receipt_offer_rules WHERE user_id=? AND rule_key=?)
        OR (SELECT COUNT(*) FROM receipt_offer_rules WHERE user_id=?) < 50) ${upsert}`)
      .bind(profile.id, key, JSON.stringify(rule), ...auth.bindings, profile.id, key, profile.id, ...(update ? auth.bindings : [])).run();
    if (!result.meta.changes) throw new RequestError('That name is already in use, the saved rules list is full, or your sign-in changed.', 409);
    return Response.json(rule, { headers });
  } catch (error) { return failure(error instanceof SyntaxError ? new RequestError('Enter a valid offer rule.') : error); }
}

export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    const profile = await ensureProfile(request);
    const name = new URL(request.url).searchParams.get('name');
    if (!name || name.length > 80) throw new RequestError('Choose an offer to remove.');
    const auth = requestWriteAuthorizationSql(profileWriteAuthorization(profile), profile.id);
    await db().prepare(`DELETE FROM receipt_offer_rules WHERE user_id=? AND rule_key=? AND (${auth.condition})`)
      .bind(profile.id, savedOfferKey(name), ...auth.bindings).run();
    return new Response(null, { status: 204, headers });
  } catch (error) { return failure(error); }
}
