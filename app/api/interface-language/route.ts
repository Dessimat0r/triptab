import {
  db,
  ensureProfile,
  failure,
  readBoundedBody,
  RequestError,
  sameOrigin,
} from '@/lib/store';
import { accountAuditStatement } from '@/lib/audit';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await ensureProfile(request),
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedBody(request, 4096)),
      );
    if (!['en', 'es', 'fr', 'de'].includes(body.language))
      throw new RequestError('Choose an available interface language.');
    const previous = await db()
      .prepare('SELECT ui_language FROM profiles WHERE id=?')
      .bind(actor.id)
      .first<{ ui_language: string }>();
    await db().batch([
      db()
        .prepare(
          'UPDATE profiles SET ui_language=? WHERE id=? AND ui_language<>? AND deleted_at=?',
        )
        .bind(body.language, actor.id, body.language, ''),
      accountAuditStatement(db(), {
        userId: actor.id,
        actorName: actor.displayName,
        entityType: 'language',
        entityId: 'interface',
        action: 'update',
        before: { language: previous?.ui_language || 'en' },
        after: { language: body.language },
      }),
    ]);
    return Response.json(
      { language: body.language },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return failure(error);
  }
}
