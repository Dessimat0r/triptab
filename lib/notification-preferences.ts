import { z } from 'zod';
import { accountAuditStatement } from './audit';
export const notificationPreferenceSchema = z
  .object({
    scope: z.enum(['all', 'involved', 'none']),
    delivery: z.enum(['immediate', 'daily', 'none']),
    reminders: z.boolean(),
    // Optional on input so an older cached client, which does not send it,
    // keeps the stored choice instead of being rejected or switching it off.
    receiptReady: z.boolean().optional(),
  })
  .strict();
export type NotificationPreferences = Required<
  z.infer<typeof notificationPreferenceSchema>
>;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  scope: 'all',
  delivery: 'immediate',
  reminders: true,
  receiptReady: false,
};
export async function readNotificationPreferences(
  database: D1Database,
  userId: string,
): Promise<NotificationPreferences> {
  const row = await database
    .prepare(
      'SELECT scope,delivery,reminders,receipt_ready FROM notification_preferences WHERE user_id=?',
    )
    .bind(userId)
    .first<{
      scope: NotificationPreferences['scope'];
      delivery: NotificationPreferences['delivery'];
      reminders: number;
      receipt_ready: number;
    }>();
  return row
    ? {
        scope: row.scope,
        delivery: row.delivery,
        reminders: !!row.reminders,
        receiptReady: !!row.receipt_ready,
      }
    : DEFAULT_NOTIFICATION_PREFERENCES;
}
export async function saveNotificationPreferences(
  database: D1Database,
  actor: { id: string; displayName: string },
  value: unknown,
) {
  const parsed = notificationPreferenceSchema.parse(value),
    before = await readNotificationPreferences(database, actor.id),
    next: NotificationPreferences = {
      ...parsed,
      receiptReady: parsed.receiptReady ?? before.receiptReady,
    };
  await database.batch([
    database
      .prepare(
        'INSERT INTO notification_preferences(user_id,scope,delivery,reminders,receipt_ready) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET scope=excluded.scope,delivery=excluded.delivery,reminders=excluded.reminders,receipt_ready=excluded.receipt_ready',
      )
      .bind(
        actor.id,
        next.scope,
        next.delivery,
        Number(next.reminders),
        Number(next.receiptReady),
      ),
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
