import {
  db,
  ensureProfile,
  failure,
  readBoundedBody,
  RequestError,
  sameOrigin,
} from '@/lib/store';
import { parseStoredTrip, settlements } from '@/lib/model';
import { notifyAccountPush } from '@/lib/notifications';
import { formatMoney } from '@/lib/money-format';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await ensureProfile(request),
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedBody(request, 4096)),
      );
    if (
      typeof body.tripId !== 'string' ||
      typeof body.from !== 'string' ||
      typeof body.to !== 'string'
    )
      throw new RequestError('Choose a suggested transfer.');
    const row = await db()
      .prepare(
        'SELECT t.owner,t.data,t.receipt_link_version FROM trips t WHERE t.id=? AND (t.owner=? OR EXISTS(SELECT 1 FROM memberships m WHERE m.trip_id=t.id AND m.user_id=?))',
      )
      .bind(body.tripId, actor.id, actor.id)
      .first<{ owner: string; data: string; receipt_link_version: number }>();
    if (!row)
      throw new RequestError('This holiday is no longer available.', 404);
    const trip = parseStoredTrip(JSON.parse(row.data)),
      transfer = settlements(trip).find(
        (transfer) => transfer.from === body.from && transfer.to === body.to,
      );
    if (!transfer || transfer.amount !== body.amount)
      throw new RequestError(
        'The suggested transfer changed. Refresh the balances first.',
        409,
      );
    const recipient = await db()
      .prepare(
        'SELECT user_id FROM memberships WHERE trip_id=? AND member_id=?',
      )
      .bind(trip.id, transfer.from)
      .first<{ user_id: string }>();
    const creditor = await db()
      .prepare(
        'SELECT user_id FROM memberships WHERE trip_id=? AND member_id=?',
      )
      .bind(trip.id, transfer.to)
      .first<{ user_id: string }>();
    if (row.owner !== actor.id && creditor?.user_id !== actor.id)
      throw new RequestError(
        'Only the recipient or holiday owner can remind this traveller.',
        403,
      );
    if (!recipient || recipient.user_id === actor.id)
      throw new RequestError(
        'This reminder needs another traveller’s connected account.',
      );
    const preference = await db()
      .prepare('SELECT reminders FROM notification_preferences WHERE user_id=?')
      .bind(recipient.user_id)
      .first<{ reminders: number }>();
    if (preference?.reminders === 0)
      throw new RequestError(
        'This traveller has turned off settlement reminders.',
      );
    const marker = crypto.randomUUID(),
      now = new Date().toISOString(),
      cutoff = new Date(Date.now() - 86400000).toISOString();
    const message =
      `${actor.displayName} reminded you about ${formatMoney(transfer.amount, trip.currency)} owed to ${trip.members.find((member) => member.id === transfer.to)?.name} for ${trip.name}.`.slice(
        0,
        160,
      );
    const result = await db().batch([
      db()
        .prepare(
          `INSERT INTO settlement_reminders(trip_id,from_member,to_member,sent_at,marker) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM trips t WHERE t.id=? AND t.receipt_link_version=? AND (t.owner=? OR EXISTS(SELECT 1 FROM memberships m WHERE m.trip_id=t.id AND m.user_id=?))) AND EXISTS(SELECT 1 FROM memberships WHERE trip_id=? AND member_id=? AND user_id=?) AND NOT EXISTS(SELECT 1 FROM notification_preferences WHERE user_id=? AND reminders=0) AND NOT EXISTS(SELECT 1 FROM auth_links WHERE oai_user_id=? AND user_id<>?) AND EXISTS(SELECT 1 FROM profiles WHERE id=? AND deleted_at='')
        ON CONFLICT(trip_id,from_member,to_member) DO UPDATE SET sent_at=excluded.sent_at,marker=excluded.marker WHERE settlement_reminders.sent_at<=?`,
        )
        .bind(
          trip.id,
          transfer.from,
          transfer.to,
          now,
          marker,
          trip.id,
          row.receipt_link_version,
          actor.id,
          actor.id,
          trip.id,
          transfer.from,
          recipient.user_id,
          recipient.user_id,
          actor.id,
          actor.id,
          recipient.user_id,
          cutoff,
        ),
      db()
        .prepare(
          `INSERT INTO notifications(id,user_id,title,body,url,created_at) SELECT ?,?,'Settlement reminder',?,'/balances',? WHERE EXISTS(SELECT 1 FROM settlement_reminders WHERE trip_id=? AND from_member=? AND to_member=? AND marker=?)`,
        )
        .bind(
          crypto.randomUUID(),
          recipient.user_id,
          message,
          now,
          trip.id,
          transfer.from,
          transfer.to,
          marker,
        ),
    ]);
    if (!result[0].meta.changes)
      throw new RequestError(
        'A reminder was already sent today, or the transfer changed. Refresh and try later.',
        429,
      );
    await notifyAccountPush(recipient.user_id).catch(() => {});
    return Response.json(
      { message: 'Reminder sent.' },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return failure(error);
  }
}
