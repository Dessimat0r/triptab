# Bill soft delete: options for an owner decision

Status: **option A chosen by the owner (6 November 2026) and built.** See "As built" at the end. The options below are kept for the record.

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

## As built (option A)

**What changes for people:**
- Deleting a bill with entries keeps it for 30 days. For about 30 seconds afterwards, an **Undo** banner is shown.
- Archived holidays has a **Recently deleted** section, with **Restore bill** and **Delete for good**.
- Scheduled maintenance removes expired bills and queues their photos for deletion.
- Holidays and empty bills are still deleted straight away, as before.

**How it is hidden without changing every reader:**
- A bill can only be deleted when no other account can open it, so its owner is the only person with access.
- Deleting it sets `trips.owner` to `deleted:<owner id>` and stores `$.deletion` (time, owner, the owner's membership row) in the trip data.
- It also removes the owner's membership, archive row, pending invitations and digests.
- Every owner-or-member check then fails for the bill without being changed. That covers the ledger, history, receipt access and upload, invites, reminders, exports, language settings, MCP, the archive list, and the archived Activity data (#72).
- Receipt rows stay, and the trip data still references them, so the photo sweeps keep them.

**Code that does change:**
- `lib/trip-lifecycle.ts`: `deleteTrip` (bills), plus `listDeletedBills`, `restoreDeletedBill`, `purgeDeletedBill` and `purgeExpiredDeletedBills`.
- `app/api/trip`: `mode=deleted`, `restore-deleted` and `purge-deleted`.
- `build/sites-worker.ts`: the scheduled purge.
- `lib/store.ts`: a stale ledger copy of a deleted bill is refused with "… was deleted. Refresh to continue."
- **Account checks:**
  - `lib/account-security.ts`: account deletion asks you to remove recently deleted bills first.
  - `lib/auth.ts`: the "empty account" checks count them.

**Restore:**
- Owner only, within 30 days, and only while the open list has room.
- It re-inserts the owner's membership, removes the tombstone, and records a `create` event marked `restored`.
- The bill's data is exactly what was deleted.

**No schema change.** The F-16 migration is separate.
