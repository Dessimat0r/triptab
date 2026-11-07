# Phase 7: resilience — implementation notes

Audit baseline: TripTab Functionality, Usability and Financial Accuracy Audit, 6 November 2026 (commit `48de3f9`).

## Implemented in this PR

| Finding | What changed | Evidence |
| --- | --- | --- |
| F-09 duplicates | `lib/duplicates.ts`: a likely duplicate is an expense or draft on the same day, in the same receipt currency, with a total within 1% (at least 1 minor unit) and a matching normalised name (equal, or one containing the other with at least 4 characters) or an equal printed receipt total. New expenses show "Possible duplicate" with **Save anyway** / **Open existing**. It never blocks saving. | `tests/resilience.test.ts` (exact, near, different day/amount/name, self-edit, second scan by printed total); `tests/browser/resilience.spec.ts` |
| F-17 limits | `MAX_OPEN_HOLIDAYS = 50`, `MAX_OPEN_BILLS = 100`, checked separately in `validateLedger` with friendly messages; restoring from the archive is limited per kind. The array cap (200) is only a size guard. Nothing is archived automatically (D07). | `tests/resilience.test.ts` (100 bills + 50 holidays allowed, 101st bill and 51st holiday messages, kind-aware restore on SQLite) |
| F-18 unsaved entry | A new manual expense is kept in this browser (`localStorage`, key per account and trip) until it is saved or the editor is closed; on return a banner offers **Resume** / **Discard**. An entry whose ID is already saved is never offered again. Storage failures never throw. Receipt entries are already protected by their saved draft. | `tests/resilience.test.ts`; browser reload test |
| F-20 invalid entries | `lib/calculation-health.ts` names every expense that cannot be calculated, with an **Open** button. The total of the others is shown as "(incomplete)". Balances and settlement suggestions stay hidden while any entry fails, so no unreliable transfer is ever suggested. | `tests/resilience.test.ts`; browser test with a legacy EUR entry lacking a rate |

## Investigated, not implemented here

### F-16 global revision (high risk, needs a migration)

Confirmed in `lib/store.ts`: every ledger write advances the single `sync_state` row (`UPDATE sync_state SET revision = revision + 1 … WHERE id = 1 AND revision = ?`) and every trip statement is guarded by that marker. Any save by any account therefore invalidates every other in-flight save; the client re-bases once and then asks the person to press Save again.

Phase 2 (#63) makes that re-base safe (no change is lost), but does not remove the contention. The narrow fix needs:

1. A migration adding `revision INTEGER NOT NULL DEFAULT 0` to `trips` (plus a backfill), and per-trip CAS in `writeLedger` (`UPDATE trips … WHERE id = ? AND revision = ?`) instead of the global row, with single-trip writes from the client.
2. Invitation, lifecycle, receipt and MCP writers moved off `sync_state` consistently (all currently use `last_write` markers), or kept on both during a transition.
3. A D1 backup first, per `docs/operations.md`.

This crosses every writer and the release procedure, so it is a separate high-risk PR that needs owner approval of the migration. It is **blocked pending that approval**, not done.

### F-19 several photos of one receipt

The scan record already allows `imageIds` (up to 6), but `/api/receipt/process` reads exactly one image, and capture, replace and purge assume one photo per draft. Adding photos safely needs the model request to carry several images, a combined source-line order, and reference counting in the image lifecycle. That is a self-contained feature PR after the receipt-model changes (#61, #64) settle, so it is **deferred**, not done.

### F-12 several payers (owner decision D08)

**Explicitly deferred** until the core remediation is complete. Today: one payer per expense; the workaround is two expenses, or one expense plus a payment.
