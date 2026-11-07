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

### F-16 per-trip revisions (implemented in #76; migrations 0014 and 0015)

This section originally recorded an investigation: every ledger write advanced the single `sync_state` row, so any save by any account invalidated every other open editor. It was left unimplemented pending owner approval of a migration. That approval was given and the work is complete in this release.

**Implemented**

- Migration `0014` adds `trips.revision` (starts at 0, no backfill) and triggers that advance it on any change to a trip's data or owner, or to its memberships, so every writer keeps it current. Migration `0015` (R11) replaces its membership trigger with one that ignores updates that change nothing.
- `writeTrips` and `writeLedger` in `lib/store.ts` take the revisions the client read (`tripRevisions`). The commit statement requires each named trip's revision to be unchanged, so a save conflicts only with a change to the same trip. A change to a different trip is merged and retried instead of being reported as a conflict.
- Invitation, lifecycle, receipt and MCP writers keep their existing markers; the global `sync_state` revision still advances on every write and remains the freshness and compare-and-swap marker.
- Older cached clients keep the whole-ledger save, which is unchanged.
- `/healthz` reports unavailable until `0014` and `0015` are applied. Covered by the migration, readiness and concurrency tests, and the browser test `trip-revisions.spec.ts`.

**Still outstanding (release procedure, not code)**

- A D1 backup before applying, and a rehearsal of migrations `0014` to `0018` on a production-sized copy (`docs/operations.md`).
- Review of the combined release candidate.

### F-19 several photos of one receipt

The scan record already allows `imageIds` (up to 6), but `/api/receipt/process` reads exactly one image, and capture, replace and purge assume one photo per draft. Adding photos safely needs the model request to carry several images, a combined source-line order, and reference counting in the image lifecycle. That is a self-contained feature PR after the receipt-model changes (#61, #64) settle, so it is **deferred**, not done.

### F-12 several payers (owner decision D08)

**Explicitly deferred** until the core remediation is complete. Today: one payer per expense; the workaround is two expenses, or one expense plus a payment.
