# Brief for Sol: one confirmation, and a Save that always explains itself

8 October 2026 · Base: `f7537fa` · Follows Sol's "Expense confirmation and click-efficiency audit" (same date)

> **Status: implemented** in [#43](https://github.com/Dessimat0r/triptab/pull/43) (merged as `4d19185`); see `expense-confirmation-2026-10-08.md` for what was built. File and line references below point at `f7537fa`, before that change.

## What Gary asked for

> Adding an expense: minimise the clicks to confirm, perhaps one "check all details are correct before submitting" type box. Cover every route, including scanning a receipt.

Gary's follow-up, which is the real priority:

> There are just too many boxes to check, and pretty much every time "Save expense" is disabled for a reason that is unclear to the user.

This brief checks Sol's audit against the code, adds what it missed, and sets out the fix. Nothing in it has been implemented yet.

## Verdict on Sol's audit

Sol's route-by-route counts and safety rules hold up against the source, and the overall direction is right: one final Save, no universal checkbox, and the AI only ever proposes. I agree with these findings and they stay in scope:

- A manual expense is already two taps (Add expense, Save). Keep it that way.
- The inbox upload dialog has an extra **Upload & read receipt** tap after you pick a photo (`components/receipt-upload-dialog.tsx:44`).
- A ready receipt shows two Save buttons: **Save expense now** (`components/expense-quick-review.tsx:112`) and the footer button.
- A suspicious manual FX rate opens a modal *after* Save is pressed (`components/trip-app.tsx:1191-1195`).
- Acknowledgements become stale after edits (Sol's Finding 2).

**What it missed: Gary's main complaint.** Sol counted taps on the happy path and treated the acknowledgement controls as working as designed. The audit never asks why Save is disabled, and that is what Gary hits every time. I found five concrete causes, and two of them leave Save disabled even after the user has done everything the screen asked. I confirmed the receipt-scan traps (D1 and D2) by running the real `lib/receipt-scan.ts` functions (script output below), and the rest by reading the source.

### D1. "I checked all N points" does not clear the save block (high)

An AI scan can return an `ambiguous-currency` warning. That warning:

- is not in `RESOLVABLE_SCAN_WARNINGS` (`lib/receipt-scan.ts:343`), so neither the per-warning button nor the bulk **I checked all N points** button covers it;
- only clears when `fieldSources.currency === 'user'` (`lib/receipt-scan.ts:164`). The `<select>` won't fire `onChange` if you re-pick the same currency, so the only way to clear it is a separate **I checked the currency: EUR** button (`components/trip-app.tsx:1890`);
- puts that button inside **Purchase details**, which stays collapsed because the currency came from the AI (`'ai'`), and `purchaseDetailsNeedAttention` only opens for `'default'` (`components/trip-app.tsx:1521-1523`);
- produces the checklist text "Review and resolve the receipt scan warnings before saving." That entry only appears once every other blocker is cleared (`lib/expense-readiness.ts:82-85`). It points at the review section, which shows "The receipt currency needs your confirmation." and has no button there.

The bulk button's footnote even says "currency differences still need correcting", which doesn't describe this case. **Result:** the user presses the big button, nothing visibly changes, and Save stays disabled.

### D2. Acknowledgements cancel each other depending on the order you click (high)

The review fingerprint (`lib/receipt-scan.ts:285`) covers resolved warnings and `fieldSources.currency`. So any other acknowledgement made *after* a fingerprinted one silently makes the earlier one stale:

- Tick "printed total is unavailable", then click "I checked this against the receipt" on a warning: the missing-total box unticks itself.
- Press **I checked all N points**, then **I checked the currency**: the missing-total acknowledgement is stale again (see the script output below).
- Per-warning resolve and the printed-total fields also clear `acknowledgement` explicitly (`components/receipt-scan-review.tsx:79,84,86`).

`carryReviewAcknowledgements` only protects changes to allocation, not other acknowledgements.

```
after missing-total tick: pending 1 | error Review and resolve the receipt scan warnings before saving.
after per-warning tick:   pending 1 (missing-total ack now stale)
after bulk:               pending 0 | error Review and resolve the receipt scan warnings before saving.
after currency confirm:   pending 1 | error Enter the printed receipt total or explicitly confirm …
```

### D3. Save is disabled for reasons the checklist never shows (high)

`saveDisabled` (`components/trip-app.tsx:1507-1513`) is wider than `expenseSaveBlockers`:

- `uploading`, `receiptProcessing` and `editorConflict` disable Save, but none of them is a blocker. While a receipt is being read, the footer shows "Add at least one item" or "Choose the receipt currency": it tells the user to do work the AI is in the middle of doing.
- `bankAmount !== undefined && currency === trip.currency` disables Save with no message.
- The comment says "Save follows the same readiness model as the 'Before saving' list, so the two never disagree". That is not true for these cases.

### D4. A new expense opens with Save disabled and no reason (medium, every time)

`components/trip-app.tsx:3054` hides the checklist while the quick form is untouched (`quickMode && !editorDirty`). This was deliberate (6 October, additional finding 4), but it means *every* new expense opens with a greyed-out Save and nothing to say why. After the first keystroke, only the first blocker shows (`SaveChecklist` shows one, plus "N more").

### D5. The receipt review has too many separate controls

Sol counts the bulk button as one tap, but a single receipt can show up to six separate controls, each with its own wording:

- a per-warning **I checked this against the receipt** button for each warning (`receipt-scan-review.tsx:76`);
- **I corrected and checked this adjustment**;
- the total-difference checkbox (`:89`);
- the printed-total-unavailable checkbox (`:90`);
- the **I checked all N points** button (`:91-94`);
- the hidden **I checked the currency** button.

Then Save, which may be one of two buttons. This is the "too many boxes" Gary is describing.

### Smaller corrections to Sol

- Sol's §4 says the bulk action "does not clear … currency mismatches". That is true, but it also fails to clear *ambiguous* currency (D1), which is the more common case and isn't flagged anywhere.
- Sol's Finding 3 says purchase-detail defaults are "advisory rather than mandatory". Not entirely: an AI-sourced currency with an `ambiguous-currency` warning *is* mandatory, and it is hidden.
- The server validates the acknowledgement fingerprint on save (`lib/model.ts:417`, `allowAcknowledgement: source !== 'mcp'`). Sol's plan to combine "acknowledge and save" can therefore be done safely: the browser computes the acknowledgement at submit time, and the server still verifies it.

## Implementation plan

Do these in order, one commit or PR per phase. Phases 1 and 2 fix what Gary is complaining about. The rest is Sol's click reduction.

### Phase 1: Save never fails silently (fixes D3 and D4)

1. **Make `expenseSaveBlockers` the only gate.**
   - Add an optional `state` argument: `{ uploading, processing, conflict, offline, fxLookupPending }`.
   - Return these as blockers with honest wording: "Reading the receipt…", "Uploading photo…", "Resolve the edit conflict above", "You're offline".
   - Fold the stray `bankAmount`/same-currency condition into it.
   - While `processing`, suppress any blocker the incoming proposal will fill (items, currency, prices), so the user isn't asked to type what the AI is reading.
2. **Reduce `saveDisabled` to `saving || blockers.length > 0`.** Delete the duplicated conditions at `trip-app.tsx:1508-1513`. Add a unit test that drives a matrix of editor states through both and asserts `saveDisabled === blockers.length > 0`.
3. **Recommended: keep Save enabled even with blockers.** Pressing it would reveal the full checklist, scroll to and focus the first blocker, and announce it (`role="alert"`). Disable it only while `saving`. This removes "greyed out for no reason" entirely and gives the untouched form (D4) an answer on the first tap. `submitExpense` already re-validates everything. If you prefer to keep the disabled style instead, at minimum:
   - show the first blocker even on an untouched quick form, worded neutrally ("Enter a name and amount");
   - put a short reason next to the disabled button.
4. Keep `SaveChecklist` compact, but when Save is pressed with blockers, expand it automatically.

### Phase 2: One review statement, combined with Save (fixes D1, D2 and D5)

1. **Replace all acknowledgement controls in `ReceiptScanReview` with a single summary.** Remove the per-warning buttons, both checkboxes, the bulk button and the hidden currency button. Show a short list of what the user is accepting, generated from the current scan. Each line should name the actual point and link to the evidence (photo, line). For example:
   - "Printed total not readable — saving the itemised €42.10"
   - "Itemised total differs from printed total by €0.40"
   - "2 lines flagged as uncertain: Coffee, Cake"
   - "Currency read as EUR"

   Keep the warning text next to each item line so the user can still inspect it.
2. **Make the footer button do the acknowledgement, at submit time.**
   - When the summary has acknowledgeable points and no hard blockers, label Save **Confirm & save expense**, otherwise **Save expense**.
   - On submit, call `acknowledgeReceiptReview(editing)` on the *final* state and then save, in one `updateTrip`, so exactly one posting operation happens. Because the acknowledgement is computed last, it can't go stale (D2 disappears by construction).
   - Store nothing as "acknowledged" while editing.
3. **Let `acknowledgeReceiptReview` cover an ambiguous currency.** When `entry.currency` is set and `ambiguous-currency` is pending, set `fieldSources.currency = 'user'` *before* computing the fingerprint. This is safe only if the currency is visible in the summary above. Also:
   - open Purchase details automatically while `ambiguous-currency` is unresolved (`purchaseDetailsNeedAttention`);
   - remove the button at `trip-app.tsx:1890`.
4. **Keep the hard blockers.** These still need real corrections, and the one-button confirmation can never clear them (Sol §8.2):
   - `unreadable-amount`
   - a missing item name
   - `currency-mismatch` (printed currency ≠ chosen currency)
   - unassigned items
   - an invalid split
   - a missing FX rate or bank charge

   Make `pendingReviewActions` and `expenseSaveBlockers` agree on which is which, and list *every* hard blocker, not only "once everything else is clear" (`expense-readiness.ts:82-85`).
5. **Server.** The current check is enough. Add one test that sends a browser save with an acknowledgement computed at submit time and expects it accepted, and one that sends an MCP save with the same acknowledgement and expects it rejected.

### Phase 3: One Save button (Sol Finding 1)

- Keep the `ReadyToSave` summary (payer, total, shares), but remove its **Save expense now** button.
- Make the footer button the only submit. The summary card can instead hold the Phase 2 "you're accepting" list.
- If the footer is far away on long receipts, the sticky footer already covers that.

### Phase 4: Faster receipt entry (Sol §3D, §3E)

1. Add a top-level **Scan receipt** button next to **Add expense** (`trip-app.tsx:~2229`). It opens the camera or picker directly and starts upload and reading as soon as a photo is chosen (reusing `captureEditorReceipt`).
2. **Inbox dialog** (`receipt-upload-dialog.tsx`):
   - Move the optional "Who bought what?" notes and place *above* the photo buttons.
   - Upload as soon as a file is selected, and drop the **Upload & read receipt** button.
   - Keep a visible way to cancel or replace the photo while uploading.
   - Notes added later can still go through the receipt conversation.
3. If the scan comes back clean, the user's only remaining actions are: a bulk allocation if needed (`QuickSplit`), then Save.

### Phase 5: FX rate check inline (Sol Finding 4)

- Move the suspicious-rate comparison from the post-Save `confirm()` (`trip-app.tsx:1191-1195`) into the FX panel as a visible warning.
- Add it as one line of the Phase 2 "you're accepting" list ("Manual rate differs from reference by 14%").
- Remove the modal once the list covers it.

### Out of scope

- Compact rows for long receipts (6 October follow-up #13).
- Draft persistence across reloads.
- Payments.

## Rules that must not regress

These are condensed from Sol's §8:

- The AI only proposes. No connector call or processing result may post an expense, or set a human acknowledgement (`receiptScanHumanReviewChanged` must still reject MCP).
- Hard blockers are never cleared by a confirmation.
- One press of Save produces exactly one posting operation, and success is shown only after the server accepts it.
- A new proposal or re-scan must not overwrite the user's own edits. The revision-conflict and idempotency checks stay.
- A manual expense stays at two taps with no checkbox.

## Acceptance criteria and tests

**Click budgets** (Playwright, counting button presses only):

| Route | Target |
| --- | ---: |
| Manual expense | 2 |
| **Scan receipt** (clean scan, needs allocation) | 3: Scan, Share equally, Save |
| Inbox upload (clean scan) | 3 |
| Receipt with any number of acknowledgeable warnings | Allocation, if needed, plus 1 (**Confirm & save**) |
| Draft review (allocated) | 2 |

**Regression tests for the traps found here:**

- D1: a scan with `ambiguous-currency`, a missing printed total and one low-confidence line saves with a single **Confirm & save** press.
- D2: no sequence of edits followed by **Confirm & save** can fail on a stale acknowledgement.
- D3: while `receiptProcessing` is true, the checklist reads "Reading the receipt…" and never asks for items or currency.
- Parity: `saveDisabled` agrees with `expenseSaveBlockers` across the state matrix.
- D4: pressing Save on an untouched form focuses the name field and announces why.
- Hard blockers (an unreadable price, `currency-mismatch`, an unassigned line) still block and are each listed.

**Update existing tests:**

- `tests/receipt-scan-ui.test.ts:129-166`: per-warning and bulk buttons.
- `tests/receipt-editor.test.ts:727`: the currency button.
- `tests/browser/receipt-upload.spec.ts` and `tests/browser/quick-expense.spec.ts`.

**Run before pushing:** `npx tsc --noEmit`, `npm run lint`, `npm test` and the Playwright specs. `pwa-live-refresh.test.ts` had 4 failures on base as of 6 October; check whether they still fail on base before treating them as yours.
