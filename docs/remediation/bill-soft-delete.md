# Bill soft delete: options for an owner decision

Status: **investigated, not built.** This note is from the leftover F-14 item "server soft-delete for bills".

## Today

Deleting a bill (owner only, and only when no other account can open it) is a hard delete, done in one compare-and-swap batch. The batch:
- records a `trip` delete event with a summary (name, counts), not the entries
- queues every receipt image for purging
- deletes the trip row, its memberships, invites, archives and language preferences

Undo is not offered, because nothing is left to restore from.

## Option A: mark deleted, keep the row, purge after 30 days

How it works:
- `deleteTrip` (bills only) sets `deletedAt` in the trip data and archives the bill for its owner.
- A new `restore-deleted` action clears both.
- Scheduled maintenance runs today's hard delete once 30 days have passed.

Benefits:
- Photos survive the window.
- No schema change, because existing tables are reused.

Costs and risk: every reader of `trips` would have to skip pending-deleted rows. These include:
- invites (`app/api/invite`), which must refuse to invite to a deleted bill
- settlement reminders (`app/api/remind`), which must not email about one
- exports (`app/api/export`)
- receipt access and upload (`lib/receipt-lifecycle.ts`)
- trip-language preferences
- MCP tools
- the archived list and the archived Activity data (#72)
- account checks that count owned trips (`lib/auth.ts`, `lib/account-security.ts`)

Missing one of these would let a "deleted" bill keep acting. This is the same "every reader and writer changes" shape as F-16.

## Option B: restore from a full snapshot in the owner's private account history

How it works:
- The delete batch also writes the complete bill (members, expenses, payments, drafts) to the owner's account audit.
- `restore-deleted` re-inserts it, owner only, within 30 days, if the ID is unused and the open-bill limit allows.
- Receipt photos are still purged, so a restored bill comes back without photos. This matches how restoring a deleted expense already handles a lost photo.

Benefits:
- Readers are unchanged, because nothing lingers in `trips`.

Costs and risk:
- **Data retention:** account history is append-only, so the full entries, including other people's names and amounts, would be kept indefinitely, not for 30 days.
- The audit row size would need a cap. A bill can hold up to 1,000 expenses.

## Recommendation

Option A, if photos must survive. It needs a review of the reader list above and tests per reader.

Option B is smaller to build, but only if indefinite retention of deleted bills' contents is acceptable under the privacy policy.

Either way, the decision is the owner's: it sets what "deleted" means for other people's data.
