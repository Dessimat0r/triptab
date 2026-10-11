# Brief: split a one-off bill without creating a holiday

10 October 2026 · Base: `b5e9046` · Feature brief, not yet implemented

> **Status: proposed.** Nothing in this brief has been built. File and line references point at `b5e9046`. The brief is self-contained: it describes the existing architecture it depends on, the design, the changes per file, and a measurable test of when each phase is done. Decisions that belong to Gary are collected under [Open decisions](#open-decisions-for-gary); each one has a recommended default so work can start.

## What Gary asked for

> Ad-hoc receipts, just a tool for non-trips, to see what each person owes. Base it on the already established architecture.

TripTab is built around the holiday. To split a single restaurant bill today, you must create a holiday, name it, list travellers, choose a settlement currency, optionally set dates, and then add the expense. The result sits in **Your holidays** next to real trips, shows holiday-only panels (budget, daily average, presence dates, trip summary), and counts toward the 50-holiday limit.

This brief adds a lightweight **bill**: a group of people and one or more receipts, with the answer "who owes whom, and how much" on the same screen. Every calculation, receipt, scan, payment and history path is reused unchanged.

## Summary of the design

1. **A bill is a trip with `kind: 'bill'`.** It is stored in the existing `trips` table, saved through the existing `writeLedger`, and calculated with the existing `balances` and `settlements`. No migration and no new table.
2. **One screen.** A bill opens on a combined **Bill** view: receipts at the top, then each person's share, then the suggested transfers with **Mark paid**. History stays available. The Receipts, Travellers and Balances tabs are folded into that view.
3. **Starting a bill takes one sheet.** People (you are pre-filled), then **Scan receipt** or **Enter amount**. The bill takes its name from the merchant or expense title unless you type one. The bill's currency follows the first receipt.
4. **Bills are listed separately** under **Bills** in the holiday drawer, with a "Settled" or "You owe £x" chip, and settled bills offer to archive themselves.
5. **Holiday-only features are hidden for bills**, not removed from the model: dates, budget, daily averages, presence dates, weights, repeat purchases and the receipt-language hint.

## Why a trip with a kind, and not a new entity

Three designs were considered. The first is recommended.

| Option | What it means | Verdict |
| --- | --- | --- |
| **A. `kind: 'bill'` on `Trip`** | Same row, same schema, a discriminator field and UI branching | **Recommended.** Everything below keys off `tripId` and works unchanged. |
| B. A new `bills` table and model | Separate storage, routes and calculation entry points | Duplicates the money model, audit trail, receipt pipeline, invites and MCP tools. Months of work and two sources of rounding truth. |
| C. A hidden "Everyday" holiday holding all one-off expenses | One container trip per account | Different people per bill break the shared member list, balances net across unrelated bills, and sharing one bill would expose all of them. |

What option A reuses, with the code that already handles it:

| Capability | Existing code | Why it needs no change for bills |
| --- | --- | --- |
| Item, percentage and unit splits; tax, tip, discount; exact pennies | `lib/model.ts` `allocate` (line 575), `shares` (716), `expenseShares` (789) | Works per expense; independent of holiday metadata |
| Per-person balance and transfers | `balances` (`model.ts:802`), `settlements` (`model.ts:871`) | A bill is just a trip with few members |
| Foreign-currency receipts, reference rates, bank charges | `expenseTotal`, `/api/fx` | Unchanged; see the currency rule in Phase 1 for the first receipt |
| Receipt photos, AI scan, review, drafts | `/api/receipt`, `/api/receipt/process`, `lib/receipt-scan.ts` | Receipts are scoped by `receipts.trip_id` (`db/schema.ts`, `receipts` table), so a bill must be a trip row |
| Concurrency, size limits, revision CAS | `writeLedger` (`lib/store.ts:516`) | Same path |
| Append-only history and notifications | `tripChanges` (`store.ts:108`), `activity_events`, `lib/notifications.ts` | `entityType: 'trip'` covers bills; only copy changes |
| Payments, payment links, reminders | `paymentSchema`, `components/payment-editor.tsx`, `lib/payment-links.ts`, `/api/remind` | Unchanged |
| Sharing with other accounts | `/api/invite`, `memberships` | Unchanged; v1 may hide it (see decisions) |
| Archive, leave, transfer, delete | `lib/trip-lifecycle.ts` | Archive is the natural end state of a settled bill |
| JSON/CSV export, import, offline capture | `/api/export`, `lib/import-ledger.ts`, `components/offline-capture.tsx` | `kind` rides along in the trip JSON |

## Ground rules

1. **No money logic changes.** `lib/model.ts` gains a field and validation rules only. Any change to `shares`, `expenseShares`, `allocate`, `balances` or `settlements` is out of scope. A bill and a holiday with the same members and expenses must give identical balances; Phase 1 adds that as a test.
2. **No migration.** `kind` lives in the trip's JSON `data`. An absent `kind` means `'holiday'`, so every existing trip, export and import keeps working unchanged.
3. **`kind` is immutable after creation**, enforced on the server like the settlement currency (`store.ts:569`). A bill never turns into a holiday mid-history, or the reverse.
4. **Keep accessible names that tests use** (`Add expense`, `Scan receipt`, `Record payment`, `Open holidays`, `View statement` and the others listed in the layout brief). New controls get their own stable names, listed per phase.
5. **Do not call hooks inside `renderSection`** (`components/trip-app.tsx:1730`). New state goes in `Home` (`trip-app.tsx:247`) or inside a new component that `renderSection` renders.
6. **Use the layout tokens** (`--space-*`, `--text-*`, `--radius-*`) and the 700/480/359px breakpoints, as set by the layout brief. Tap targets at least 44×44px; 16px text in overlays.
7. **Every new UI string goes through `uiText`** and gets Spanish, French and German rows in `lib/ui-copy.json`.
8. **One phase per PR.** Each must pass `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` and `npm run test:layout`.

## Data model

### The new field

In `lib/model.ts`, extend `tripSchema` (line 365):

```ts
// What the trip is for. Absent means a holiday, so stored trips are unchanged.
// A bill is a one-off split with no dates, budget or presence planning.
kind: z.enum(['holiday', 'bill']).optional(),
```

Add a helper next to `tripMemberWeights`:

```ts
export const isBill = (trip: Pick<Trip, 'kind'>) => trip.kind === 'bill';
```

### Validation rules for bills

In `validateLedger` (`model.ts:468`), inside the per-trip loop, before the member checks:

| Rule | Message (through `LedgerValidationError`) |
| --- | --- |
| No `startDate`, `endDate` or `budget` on a bill | `Bills don’t have dates or a budget.` |
| No member `joinedOn`, `leftOn` or `weight` on a bill | `Bills don’t track traveller dates or family weights.` |
| At most 20 members on a bill (holidays keep 50) | `A bill can be split between up to 20 people.` |

The 20-person limit keeps the bill view to one screen of shares; holiday limits are untouched. These rules apply only to new or changed trips. A stored bill never fails to load because of them, since `parseStoredTrip` does not run `validateLedger`.

Every other field stays legal. A bill may hold several expenses (dinner, then drinks), drafts awaiting review, and payments.

### Server rules in `writeLedger`

In `lib/store.ts`, in the `if (stored)` branch next to the currency check (`store.ts:569`):

1. **`kind` is fixed.** If `(trip.kind ?? 'holiday') !== (previous.kind ?? 'holiday')`, throw `RequestError('A bill can’t become a holiday, or the reverse.')`.
2. **An empty bill may change currency.** Replace the unconditional currency check with: reject a currency change unless `isBill(previous)` and `previous.expenses.length === 0 && previous.payments.length === 0 && previous.drafts.length === 0`. This lets the first scanned receipt set the bill's currency (Phase 2). Holidays keep today's rule.

For new trips (the `else` branch, `store.ts:596`), nothing changes: the first member becomes the signed-in user, as for holidays.

### Lifecycle: discarding an empty bill

A bill must exist as a trip row before its receipt photo can be uploaded (`receipts.trip_id` has a foreign key to `trips.id`). So the bill is created when the person taps **Continue**, before the editor opens. If they then close the editor without saving anything, an empty bill would be left behind.

Add a `discard` action to `POST /api/trip` (`app/api/trip/route.ts`) and a `discardEmptyBill` function in `lib/trip-lifecycle.ts`. It reuses the `deleteTrip` batch (`trip-lifecycle.ts:149`) with these differences:

- No name confirmation.
- Only when `isBill(trip)`, the actor is the owner, no other account has joined, and the bill has no expenses, payments or drafts. Otherwise `409` with `This bill has entries. Delete it from its settings instead.`
- The same `advanceRevision` guard, so a save that raced the discard wins and the discard fails.
- Receipt images still go through `receipt_object_purges`. An uploaded-then-abandoned photo is cleaned up by the existing scheduled maintenance.
- The create and delete events stay in `activity_events`, as for any deleted holiday.

### Limits

Bills share the 50-open-trips limit (`MAX_OPEN_TRIPS`, `trip-lifecycle.ts:9`) and the whole-ledger byte budget (`MAX_LEDGER_CONTENT_BYTES`, `store.ts:383`). That is acceptable because settled bills are archived (Phase 3), and archived trips leave both the open list and the ledger payload (`OPEN_TRIP_IDS` in `trip-lifecycle.ts`). If Gary wants bills not to count against holidays, that is a separate limit and a larger change; see the decisions.

The known whole-ledger scaling issue (audit F-20, `docs/audit/IMPLEMENTATION.md`) is made slightly worse by many small trips. Auto-archiving keeps the open set small; do not raise any limit in this work.

## User experience

### Starting a bill

Entry points:

- **Holiday drawer:** a **Split a bill** button beside **New holiday** in `.holiday-actions` (`trip-app.tsx:2260`).
- **Empty state:** under **Create your first holiday** in the onboarding panel (`trip-app.tsx:2409`), a secondary **Split a bill** button.
- **Page heading of a bill:** **Add receipt** opens the existing editor on the same bill.

**Split a bill** opens one sheet, `components/bill-start.tsx`, using the same modal primitives as the create-holiday form (`useModalLayer`):

| Field | Default | Notes |
| --- | --- | --- |
| **Who's splitting?** | You (profile name, locked in first place) plus one empty name field | Chip list: type a name, press Enter or comma for the next. Suggestions come from people on your other holidays and bills (client-side, from `ledger.trips[*].members`, deduplicated by case-insensitive name, most recent first). No new storage. |
| **Name** | Empty; placeholder `Named after the receipt` | Optional. Collapsed under **More options**. |
| **Currency** | Currency of your most recently created trip, else `GBP` | Collapsed under **More options**. Replaced by the first receipt's currency (Phase 2). |

Two buttons end the sheet: **Scan receipt** (primary) and **Enter amount**. Both:

1. build a `Trip` with `kind: 'bill'`, a generated id, the members and currency, and the name `Bill · {date}` (localised, using `formatCalendarDate`) when none was typed;
2. save it with the existing `save({ trips: [...ledger.trips, bill] })` (`trip-app.tsx:635`);
3. select it, and call the existing `newExpense()` (`trip-app.tsx:767`). **Scan receipt** then clicks the existing `scanReceiptInput`, exactly as the page-heading button does today (`trip-app.tsx:2372`).

Record in a `Home` ref that the bill's name and currency are still the defaults (`billDefaults: { tripId, name: boolean, currency: boolean }`). Phase 2 uses it.

If the person closes the editor and the bill has no expenses, payments or drafts, call the `discard` action and return to the previously selected trip. No confirmation: nothing is lost.

**Tap budget.** From the drawer to a saved, split, scanned bill: **Split a bill**, type names, **Scan receipt**, take photo, (review) **Save expense**. That is four taps plus the photo and the names, against at least nine today (New holiday, name, travellers, currency, Create, Scan receipt, photo, review, Save). Manual entry: **Split a bill**, names, **Enter amount**, amount, **Save expense**.

### Naming and currency from the first receipt

When the first expense on a bill is saved and `billDefaults` says the name is untouched, set `trip.name` to the expense title (trimmed to 100 characters) in the same save. When the currency is untouched and the expense's receipt currency differs, set `trip.currency` to the receipt currency, also in the same save, and drop the expense's `fx` and `bankAmount` (they are no longer needed; `validateLedger` rejects a same-currency bank charge, `model.ts:534`). The server allows this only because the bill was empty before this save (data model rule 2).

Doing both in the save that adds the expense keeps them atomic: one revision, one history event per entity, and no window in which the bill shows "Bill · 10 Oct" with a EUR receipt converted to GBP.

After the first expense, the bill behaves like a holiday: the name is editable in the bill's settings and the currency is fixed.

### The bill view

`components/bill-view.tsx`, rendered by `renderSection` for every section except `history` when `isBill(trip)`. It is one column on phones and two above 900px (receipts left, shares right), using existing classes where they exist (`.panel`, `.stats`, expense rows).

1. **Heading.** Eyebrow `BILL` instead of `HOLIDAY LEDGER`; the bill name; `{n} people · {total}`. Actions: **Add receipt** (primary; same handler as **Add expense**) and **Scan receipt**. Keep the same accessible-name pattern as the holiday heading so the layout spec's action-row checks apply.
2. **Receipts.** The existing expense rows for `trip.expenses`, plus pending drafts with **Review**, exactly as the Expenses and Receipts tabs show them now. Reuse the components, not copies.
3. **Who owes what.** One row per person:
   `Alex · paid £84.20 · share £21.05 · is owed £63.15`, or `Sam · share £21.05 · owes £21.05`.
   Values come from `travellerFinancialPreview` (`model.ts:840`), which already returns `costShare`, `paidUpfront`, `paymentsSent`, `paymentsReceived` and `netBalance` per person. Tapping a row opens the existing traveller statement (`components/member-statement.tsx`).
4. **Settle up.** The existing `settlements(trip)` list. Each transfer has **Mark paid** (opens the existing payment editor prefilled with from, to and amount) and, when the recipient has a `payTo` handle, the existing payment-link buttons. Once every balance is zero, the section shows `Everyone’s settled` and **Archive bill**.
5. **Share.** **Copy summary** and, where `navigator.share` exists, **Share**. The text comes from a new `billSummaryText(trip)` next to `tripSummaryText` (`components/trip-summary.tsx:15`):

   ```
   Dinner at Taberna Real — €126.40
   Alex paid. Sam owes Alex €31.60. Jo owes Alex €31.60. Kim owes Alex €31.60.
   ```

   Names, amounts and the bill name only. No emails, payment handles or notes.

If any expense fails to calculate (the `calculationError` path, `trip-app.tsx:1503-1511`), the shares section shows the same message the holiday stats do, and Settle up is hidden.

### Navigation for a bill

Add to `lib/trip-routes.ts`:

```ts
export function sectionsFor(kind: Trip['kind']) {
  return kind === 'bill'
    ? [{ id: 'expenses', href: '/expenses', label: 'Bill' }, TRIP_SECTIONS[4]] as const
    : TRIP_SECTIONS;
}
```

`TripTabNavigation` (`components/trip-routing.tsx`) takes the trip's `kind` and renders `sectionsFor(kind)`. The other paths (`/balances`, `/receipts`, `/travellers`) stay valid and render the bill view for a bill, so a link or reload never 404s. Do not add a new route: `selected` is client state, and the existing section routes already work for any selected trip.

People are managed from a **People** sheet opened from the bill heading (`•••` → **People**), which reuses the traveller name editor and removal rules (`memberRemovalBlocker` in `lib/trip-insights.ts`). Holiday details, budget, dates, language hint, archive/leave/transfer controls and invitations live in `trip-controls.tsx` and `trip-details.tsx`; for a bill, show only name, archive, delete and (if enabled) invite.

### The drawer

Split the trip list in the sidebar (`trip-app.tsx:2236`):

- **YOUR HOLIDAYS**: trips where `!isBill(t)`, in their current order.
- **BILLS**: bills, newest first by the latest expense date (falling back to creation order). Each row uses a receipt icon from `lucide-react` instead of `Plane`, and a small chip: `Settled`, `You owe £x` or `You’re owed £x` for the signed-in member (from `travellerFinancialPreview`). Show at most 5, then **Show all bills** expands the rest.

The archived list (`ArchivedHolidays`, `components/trip-controls.tsx`) gains a `Bill` label. Extend `listArchivedTrips` (`trip-lifecycle.ts:33`) to select `json_extract(t.data, '$.kind') AS kind` and return it.

### What a bill hides

| Holiday feature | Where | For a bill |
| --- | --- | --- |
| Dates, budget, receipt-language hint | `components/trip-details.tsx` | Hidden; rejected by the server |
| Budget card, daily average, trip summary | `components/trip-summary.tsx`, `lib/trip-insights.ts` | Hidden |
| Presence dates and weights | `components/traveller-options.tsx` | Hidden; rejected by the server |
| Repeat purchase | `components/repeat-expense-dialog.tsx` | Hidden |
| Spending insights by day and category | `components/expense-insights.tsx` | Hidden while the bill has fewer than 3 expenses |
| "Total trip spend", "Average per traveller" | `.stats` in `trip-app.tsx:2433` | Replaced by the bill heading total |

Receipt-language detection still runs per scan; only the shared hint is hidden.

### Copy

All server and notification copy that says "holiday" must say "bill" for bills. The changes are mechanical but scattered:

- `lib/notifications.ts`: `activityNotification` (line 312) and the `add('the holiday …')` titles (lines 286–304) take the trip kind from `NotificationContext` and choose `Bill` or `Holiday`. Add `kind` to the context where `notifyMembers` (line 475) builds it.
- `lib/trip-lifecycle.ts` and `app/api/trip/route.ts`: error and notification messages, where the trip's kind is known.
- `components/trip-app.tsx`: headings, empty states and buttons in the bill branch.

Add every new English string to `lib/ui-copy.json` with es, fr and de translations.

## MCP tools

Changes in `app/mcp/route.ts`, all in Phase 4:

1. `get_trip_ledger` summaries (`toolLedger`, line 417) include `kind`. Its description gains: `A bill is a one-off split with no dates; treat it like a holiday otherwise.`
2. `create_holiday` (line 62) gains optional `kind: 'holiday' | 'bill'`. When `kind` is `'bill'`, `startDate` and `endDate` are rejected, matching the server rule. Do not add a separate tool: the creation, retry-token and revision logic at lines 636–665 is identical.
3. Every other tool works unchanged, since they are scoped by `tripId`.

## Export and import

- **JSON** exports already carry the whole trip, so `kind` is included. `lib/import-ledger.ts` must preserve `kind` from TripTab JSON and run the bill validation rules.
- **CSV** financial export: add a `Kind` column after the trip name. The import's CSV paths (Splitwise and basic CSV) always create holidays.
- **Offline capture** (`components/offline-capture.tsx`) lists bills with holidays, labelled `Bill`. Creating a bill offline is out of scope: it needs a server-created trip row before its photo can be queued.

## Implementation plan

Five PRs. Each activates its own browser cases; follow the same `test.fixme` protocol as the layout brief (tag each case `[P{n}]`, commit later phases as `test.fixme` naming the phase that activates them, never re-`fixme` an active case, and the last phase adds a unit test that fails if any `test.fixme(` remains in `tests/browser/bill.spec.ts`).

### Phase 0: tests first

- `tests/browser/bill.spec.ts`, mocking `/api/**` as `tests/browser/expense-layout.spec.ts` does. Fixture: one holiday with 4 travellers, one bill with 4 people and one EUR expense paid by the first person, one settled and archived bill.
- Cases for every phase below, all `test.fixme` except the baseline check that the holiday fixture renders as today.

**Done when** CI is green and the PR description lists every case with the phase that activates it.

### Phase 1: model and server

- `kind` in `tripSchema`, `isBill`, and the bill rules in `validateLedger`.
- `writeLedger`: `kind` immutability, and currency change on an empty bill.
- `discardEmptyBill` and the `discard` action.
- `listArchivedTrips` returns `kind`.

Tests in `tests/` (using `tests/helpers/sqlite-d1.ts` for the store tests):

1. A trip without `kind` validates and round-trips unchanged.
2. A bill with dates, budget, presence dates, weights or 21 members is rejected with the messages above.
3. **Equivalence:** for 20 seeded random ledgers (reuse the seeded generator in `tests/model.test.ts:285`), the same members, expenses and payments as a holiday and as a bill give identical `balances` and `settlements`.
4. Changing `kind` on a stored trip is rejected, in both directions.
5. An empty bill can change currency; a bill with one expense, payment or draft cannot; a holiday never can.
6. `discard` deletes an empty bill, returns 409 for a bill with an entry or another member account and for any holiday, and fails if a save landed first.

**Done when** the tests pass and `npm test` is otherwise unchanged.

### Phase 2: starting a bill

- `components/bill-start.tsx` and the two entry points.
- Create, select and open the editor; discard on close when empty.
- First-save naming and currency adoption.

Browser cases:

- From the drawer at 390×844, **Split a bill** → add `Sam`, `Jo` → **Enter amount** → `48` → **Save expense** leaves 4 people, a bill named after the expense, and shares of 12.00 each. Count taps: at most 5 plus typing.
- **Scan receipt** with a mocked EUR scan on a bill created in GBP leaves the bill in EUR with no `fx` on the expense.
- Closing the editor on a new bill without saving calls `discard` and returns to the previous trip.
- Name suggestions offer travellers from the fixture holiday.

**Done when** those cases pass in Chromium and WebKit, at 320px and 390px with no clipping (reuse the layout spec's clipping and word-split checks).

### Phase 3: the bill view and drawer

- `components/bill-view.tsx`, `sectionsFor`, the reduced tab bar, and the People sheet.
- The drawer's **Bills** group with chips; archived label.
- **Mark paid**, payment links, `Everyone’s settled`, **Archive bill**.
- `billSummaryText`, **Copy summary**, **Share**.
- Hide the holiday-only features listed above.

Browser cases:

- The bill view shows each person's paid, share and balance, matching `travellerFinancialPreview` for the fixture.
- **Mark paid** on each suggested transfer leads to `Everyone’s settled`; **Archive bill** removes it from the drawer and it appears in the archived list labelled `Bill`.
- Copied summary text equals `billSummaryText(fixture)` and contains no `@`.
- `/balances`, `/receipts` and `/travellers` render the bill view for a bill; the tab bar shows exactly **Bill** and **History**.
- Holidays render exactly as before: the existing `main-layout.spec.ts` passes untouched.
- Layout: at 320px, the shares rows don't split words and the action row fills its width (same checks as Fixes 1 and 3 of the layout brief).

**Done when** those pass and no holiday screenshot in `tests/browser` changes.

### Phase 4: copy, MCP, export and import

- Kind-aware copy in notifications, lifecycle errors and the app; translation rows.
- MCP `kind` in summaries and `create_holiday`.
- Export `Kind` column; JSON import preserves `kind`.

Tests: notification titles for a bill say `Bill`; `tests/mcp.test.ts` covers creating a bill and rejecting dates on one; `tests/import-ledger.test.ts` round-trips a bill through JSON; `tests/ui-language.test.ts` finds every new string in all three catalogues.

**Done when** those pass, and the last-phase gate (no `test.fixme(` in `bill.spec.ts`) is in place and green.

## Out of scope

- Moving an expense between a bill and a holiday. Receipt images, drafts and history are scoped to their trip, so this needs its own design.
- Netting balances across bills, or a "people" view showing what Sam owes you across everything.
- Creating a bill offline.
- Any change to rounding, calculation rules or the money model.
- A separate limit for bills or a new storage path for them.

## Open decisions for Gary

Each has a default so work can start; changing it later affects only the phase named.

1. **What do we call it?** Default: **Split a bill** for the button and **Bill** for the thing. Alternatives: "Quick split", "Receipt". Copy only (Phase 2–4).
2. **Do bills count toward the 50 open holidays?** Default: yes, with the archive prompt when settled. A separate limit needs a second open-list query and a change to `readLedgerSnapshot`; it would be its own PR after Phase 3.
3. **Can a bill be shared with other accounts in v1?** Default: yes, by keeping the existing **Invite** in the bill's `•••` menu. The people on a bill are usually not TripTab users, so the share text (Phase 3) is the main way to send the result. Hiding Invite is a one-line change.
4. **Should a settled bill archive itself?** Default: no, it offers **Archive bill**. Automatic archiving would surprise people who mark one payment by mistake.
5. **Several receipts per bill?** Default: yes (dinner then drinks). Setting a limit of one would simplify the view but means a new bill for the second round.

## Risks

| Risk | Mitigation |
| --- | --- |
| Empty bills accumulate if `discard` fails (offline, tab closed) | They are harmless and visible in the drawer as `Bill · {date}` with no entries. The bill view offers **Delete** for an empty bill without a name confirmation. |
| A holiday screen changes by accident while branching the UI | Every holiday browser spec stays active and unchanged; Phase 3 forbids holiday screenshot changes. |
| Many bills grow the whole-ledger payload (F-20) | The archive prompt; the 50-trip and byte limits are unchanged and still enforced. |
| Currency adoption on the first receipt confuses someone who chose a currency deliberately | Adoption happens only when the currency field was left at its default (`billDefaults.currency`). |
| "Holiday" wording leaks into bill notifications or errors | Phase 4 grep check: `rg -n "holiday" lib/notifications.ts lib/trip-lifecycle.ts app/api/trip` reviewed line by line, and notification tests for both kinds. |
