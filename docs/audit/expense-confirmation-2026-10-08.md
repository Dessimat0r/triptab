# Expense confirmation — 8 October 2026

The expense editor now explains corrections on Save and confirms receipt review in that same press. The five implementation phases start from TripTab main at `f7537fa`.

Save stays enabled unless a save request is running. New manual forms keep the checklist hidden until the first Save press. Pressing Save with blockers expands the complete checklist, announces a fixed snapshot of those blockers once, and focuses the first correction. Subsequent field edits update the visual list without repeating the alert. Offline status is plain explanatory text. Readiness includes uploading, receipt processing, edit conflicts, offline state, pending required FX lookups and conversion bank charges in the settlement currency. During upload or reading it asks the user to wait rather than enter the incoming proposal's values.

Receipt review has one acceptance summary with actual amounts, selected currency and uncertain line names. Item and FX checks use the same immediate field jump as the checklist: collapsed controls open, focus enters the relevant field, and browser history stays unchanged. The summary has one shared photo link. The footer becomes **Confirm & save expense** when there are review points and no hard blockers. It computes the acknowledgement from final values immediately before posting, including setting the ambiguous selected currency's provenance before fingerprinting. No editing control creates an acknowledgement. Missing prices, names, mismatched currencies, unassigned items, invalid splits and absent conversion values still require correction.

The server treats a new user-confirmed currency as human review, so MCP cannot forge the currency-only case. Existing acknowledgement verification, draft binding, conflict checks, idempotency and proposal protections remain. A guard also prevents rapid repeated submit events from issuing two posting operations; server rejection retains the editor, and the success notice waits for acceptance.

The Ready to save card keeps the payer, totals and shares but has no submit button. The sticky footer is the only Save. The new top-level Scan receipt action opens the camera/picker directly, prepares the image and reuses editor capture. Inbox notes and place precede the photo controls; selecting a photo uploads and reads it immediately. Before draft saving starts, cancellation aborts the image request and invalidates its session, and replacement cannot reopen an old photo or start another scan. Immediately before the draft POST, the dialog locks Cancel, Close, Escape and replacement using a synchronous request flag and shows “Saving receipt…”. This prevents a committed draft from appearing after an accepted cancellation. A failed draft save unlocks the retained photo and notes for retry. Cancelling the initial camera/picker still leaves an untouched manual form available as a fallback. Notes added later can still use the receipt conversation.

Suspicious manual FX rates appear in the FX panel and acceptance summary, with the measured percentage difference when a matching reference exists. There is no post-Save FX modal.

| Route | Observed presses |
| --- | --- |
| Manual expense | 2: Add expense, Save |
| Clean scan needing allocation | 3: Scan receipt, Share equally, Save |
| Inbox upload with an allocated clean scan | 3: Add receipt, Choose image, Save |
| Allocated receipt with ambiguity, missing total and uncertain lines | 1: Confirm & save |
| Allocated saved draft | 2: Review, Save |

Native file selection and typing are excluded from the press counts. A receipt still needing allocation takes that explicit sharing action before its final confirmation.

Validation:

- Production build and `npx tsc --noEmit` pass.
- Lint has zero errors and the four existing warnings.
- Full unit suite: 1,210 passed and four existing `pwa-live-refresh.test.ts` failures. The same four failures were reproduced with unchanged PWA sources on the base.
- Full Playwright suite: 228 passed across Chromium and WebKit. The final run permitted one retry but used none. Earlier WebKit runs intermittently missed pointer actions or stalled navigation; these did not recur in the final full run.
- A further CI timing regression showed an old zero-delay focus callback could redirect the next split-button Enter to Amount and submit the expense. Mode-change focus now runs during the layout commit. The new delayed-callback test fails on the previous PR head and passes on the fix in both engines.
- Review follow-up tests hold the draft POST after image upload, try a late picker result and Escape, exercise a failed draft save/retry, verify quiet new forms, check focus without history entries, count announcement mutations after typing and confirm the offline notice has no field-jump action.
- Coverage includes a 64-state rendered Save/blocker matrix, D1–D4, hard blockers together, final acknowledgement fingerprints after edits, browser versus MCP acceptance, click budgets, double-submit protection, server rejection, upload cancellation/replacement across both phases, retained-note retries, static Save announcements and inline FX review.

Screenshots use local API fixtures with synthetic amounts and a fixture receipt photo; they show no live trip data.

| Screen | Phone, 390 × 844 | Desktop, 1440 × 900 |
| --- | --- | --- |
| Receipt confirmation | ![Receipt confirmation, phone](expense-confirmation-2026-10-08/receipt-confirmation-390.png) | ![Receipt confirmation, desktop](expense-confirmation-2026-10-08/receipt-confirmation-1440.png) |
| Save feedback and name focus | ![Save feedback and name focus, phone](expense-confirmation-2026-10-08/save-feedback-390.png) | ![Save feedback and name focus, desktop](expense-confirmation-2026-10-08/save-feedback-1440.png) |
| Notes before photo selection | ![Notes before photo selection, phone](expense-confirmation-2026-10-08/receipt-upload-390.png) | ![Notes before photo selection, desktop](expense-confirmation-2026-10-08/receipt-upload-1440.png) |

Saving the uploaded receipt locks cancellation and replacement while the draft is being committed:

![Saving receipt on a phone](expense-confirmation-2026-10-08/receipt-saving-390.png)
