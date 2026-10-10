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
    if (body.accountId !== undefined && body.accountId !== actor.id)
      throw new RequestError('Your account changed. Reopen settings before changing language.', 409);
    const previous = await db()
      .prepare("SELECT ui_language FROM profiles WHERE id=? AND deleted_at=''")
      .bind(actor.id)
      .first<{ ui_language: string }>();
    if (!previous) throw new RequestError('Sign in again to change your language.', 401);
    if (previous.ui_language === body.language) return Response.json(
      { language: body.language }, { headers: { 'Cache-Control': 'private, no-store' } },
    );
    const results = await db().batch([
      db()
        .prepare(
          'UPDATE profiles SET ui_language=? WHERE id=? AND ui_language=? AND deleted_at=?',
        )
        .bind(body.language, actor.id, previous.ui_language, ''),
      accountAuditStatement(db(), {
        userId: actor.id,
        actorName: actor.displayName,
        entityType: 'language',
        entityId: 'interface',
        action: 'update',
        before: { language: previous.ui_language },
        after: { language: body.language },
      }, { sql: 'changes() > 0', bindings: [] }),
    ]);
    if (!results[0].meta.changes) {
      const current = await db().prepare("SELECT ui_language FROM profiles WHERE id=? AND deleted_at=''")
        .bind(actor.id).first<{ ui_language: string }>();
      if (!current) throw new RequestError('Sign in again to change your language.', 401);
      if (current.ui_language !== body.language)
        throw new RequestError('Your language settings changed. Reopen settings and try again.', 409);
    }
    return Response.json(
      { language: body.language },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return failure(error);
  }
}
