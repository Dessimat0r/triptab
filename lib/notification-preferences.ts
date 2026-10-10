import { z } from 'zod';
import { accountAuditStatement } from './audit';
export const notificationPreferenceSchema = z
  .object({
    scope: z.enum(['all', 'involved', 'none']),
    delivery: z.enum(['immediate', 'daily', 'none']),
    reminders: z.boolean(),
  })
  .strict();
export type NotificationPreferences = z.infer<
  typeof notificationPreferenceSchema
>;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  scope: 'all',
  delivery: 'immediate',
  reminders: true,
};
export async function readNotificationPreferences(
  database: D1Database,
  userId: string,
): Promise<NotificationPreferences> {
  const row = await database
    .prepare(
      'SELECT scope,delivery,reminders FROM notification_preferences WHERE user_id=?',
    )
    .bind(userId)
    .first<{
      scope: NotificationPreferences['scope'];
      delivery: NotificationPreferences['delivery'];
      reminders: number;
    }>();
  return row
    ? { ...row, reminders: !!row.reminders }
    : DEFAULT_NOTIFICATION_PREFERENCES;
}
export async function saveNotificationPreferences(
  database: D1Database,
  actor: { id: string; displayName: string },
  value: unknown,
) {
  const next = notificationPreferenceSchema.parse(value),
    before = await readNotificationPreferences(database, actor.id);
  await database.batch([
    database
      .prepare(
        'INSERT INTO notification_preferences(user_id,scope,delivery,reminders) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET scope=excluded.scope,delivery=excluded.delivery,reminders=excluded.reminders',
      )
      .bind(actor.id, next.scope, next.delivery, Number(next.reminders)),
    accountAuditStatement(database, {
      userId: actor.id,
      actorName: actor.displayName,
      entityType: 'notifications',
      entityId: 'preferences',
      action: 'update',
      before,
      after: next,
    }),
    database
      .prepare('DELETE FROM notification_digests WHERE user_id=?')
      .bind(actor.id),
  ]);
  return next;
}
