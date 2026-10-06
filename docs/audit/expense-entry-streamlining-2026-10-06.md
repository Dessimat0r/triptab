# Expense entry: verification of Sol's usability audit and follow-up changes

Reviewed on 6 October 2026, starting from `c36abcc` (the revision Sol audited). This review re-checked each of Sol's 22 findings against the source, measured the editor before and after with one script, and made changes on this branch so that adding an expense is as short as possible without losing anything.

## Result

| New manual expense (same fixture, same script) | Before (`c36abcc`) | After |
| --- | ---: | ---: |
| Editor height, 390 × 844 | 2,635 px | 1,163 px |
| Editor height, 320 × 740 | 2,827 px | 1,259 px |
| Editor height, 1440 × 900 | 2,219 px | 1,030 px |
| Expense name, top of field (390) | y = 975 | y = 153 |
| Amount, top of field (390) | y = 1,637 | y = 250 |
| Pinned footer, 320 × 740 | 270 px | 80 px |
| Rendered controls | 38 | 22 |
| Initial focus | "Who bought what?" (receipt notes) | Expense name |

The "before" figures agree with Sol's measurements (the small differences come from the fixture). On a 390 px phone the name, amount, currency, payer, people, per-person shares and Save are all on the opening screen. A same-currency shared purchase now needs **two typed fields and Save**. On a scanned receipt, initial focus goes to the "share the remaining items" action, which opens no keyboard, and review now comes before photo management.

## Sol's findings: verification

All 22 findings are accurate as described. "Verified" below means I confirmed the cause in source and, where shown, reproduced the behaviour or covered the fix with a test.

| # | Finding | Verified | Change on this branch |
| --- | --- | --- | --- |
| 1 | Decimal comma changes magnitude | Source: amount regex accepted only `.`, so `12,50` became `1250` | One `.` or `,` is the decimal separator, whether typed or pasted. Grouped, signed or 3-decimal input is refused with a validity message and never reinterpreted. Unit and browser tests added. |
| 2 | Simplest expense not on opening screen | Source and measured (table above) | New **quick form**: name, amount + currency, paid by, shared with, live shares. Receipt capture is a compact "Have a receipt?" block further down. |
| 3 | Duplicate name / translation trap | Source: manual line rendered a reading-language field plus a required receipt-original field | The quick form uses the expense name as the line name. A manual line with no language evidence gets one "Item name" field. The first line follows the expense name until someone names it separately. |
| 4 | Close / Escape / reload lose work | Source: close and Escape called the unconditional close | Close and Escape now ask "Discard unsaved changes?" (Keep editing / Discard changes) when there is unsaved work, and `beforeunload` warns on reload. Unsaved work includes photo removal, printed evidence, review acknowledgements and confirmed fields. An untouched form, or a receipt filled only by the server, closes without asking. Draft persistence across reloads is **not** implemented (see Not done). |
| 5 | Pending FX lookup disables Save and leaks to next editor | Source: global `fxLoading` was in `saveDisabled` and was never reset on close | A pending lookup no longer gates Save; a manual rate or bank charge is a complete conversion. Closing the editor retires the request. Browser test covers both cases. |
| 6 | Default date/time vs reused timezone | Source: `localDate()`/`localTime()` used the device zone | Default date and time are computed in the chosen zone from the same instant. |
| 7 | Receipt review starts with attachment management | Source: capture rendered first | With a photo, the review fields come first in DOM, reading and focus order. Desktop keeps the photo panel in the left column. "View receipt photo" stays at the top. |
| 8 | Sticky footer covers focused field | Plausible from CSS; guarded now | The footer's measured height drives `scroll-padding-bottom`, and a focus handler scrolls any covered control into view. Browser test tabs through item fields. |
| 9 | Checklist and Save disagree; item blockers don't focus | Source: `saveDisabled` ignored names/title; targets pointed at a heading | Save is disabled exactly when the checklist has blockers. Blockers point at the specific line and control (name, price, people), and the quick form maps them to its own fields. |
| 10 | Receipt notes look manual but are discarded | Source: `captureNotes` is only used by photo capture | Notes and location sit inside "Add notes for reading the photo" in the capture block, so they are clearly receipt-reading context. |
| 11 | Two levels of split configuration | Design | The quick form shows a "Shared with" chip row (at least one person stays selected). **Custom split** opens the item split (percentages, units) and whole-bill options. |
| 12 | Bulk wording unclear | Source | "Share the remaining item equally" / "Share 3 remaining items equally" / "Give … to Gary", with "Only items with nobody on them yet change." |
| 13 | Long receipts repeat full editors | Source | **Not done** (see below). |
| 14 | Payer/currency bundled with metadata; details can't collapse | Source | In the quick form, currency sits beside the amount and payer beside people; details hold only date/time/zone. A **Done** button collapses details again. |
| 15 | Zero adjustments always shown | Source | Hidden behind **Tip, tax or discount**; shown automatically when any is non-zero (including from a scan). |
| 16 | New lines reset people to everyone | Source | A new line starts with the previous line's people (everyone if that line had none). |
| 17 | "Use current location" blocked by site policy | `build/sites-worker.ts:31` sets `geolocation=()` | The action is hidden where the Permissions/Feature Policy reports geolocation disallowed (Chromium). Where it still fails, the message no longer implies the person declined. |
| 18 | External-assistant tools expanded after processing | Source: `open={!aiConnected}` | The handoff tools and raw prompt start collapsed once a receipt is read or ready. |
| 19 | Offline leaves Save enabled | Source | Save is disabled offline, and the footer explains that the entry stays while the form is open. |
| 20 | 32 px checklist targets, large footer | CSS | Targets are 44 px. The checklist shows the next blocker plus "N more", and an untouched quick form shows no checklist at all. |
| 21 | Duplicate completion controls | Source | "Check details" now goes to the first line rather than the name. The duplicate "Save expense now" on a ready receipt is kept (see Not done). |
| 22 | History/helper copy without context | Source | "Receipt history" only appears for saved entries and drafts. "Suggested name" only appears for a receipt-supplied name. A brief "Saved “Taxi”." confirmation with **Add another** appears after saving. |

## Additional findings from this review

1. **Typing into a `0.00` amount did nothing (high).** New amounts were pre-filled with `0.00`, and on a phone the caret lands at the end. The next digit made a third decimal, which was silently rejected, so the person had to delete the zeros first. Required amounts now start empty with a `0.00` placeholder, and a shown zero on a receipt line is selected on focus.
2. **"Translate missing names" was offered for a typed English line (medium).** A manual line with no language evidence was treated as foreign. It is now excluded until a receipt language is set.
3. **Itemising before naming lost the name (medium).** Choosing *Split by item* and then typing the expense name left line 1 blank and produced a "Name 1 item" blocker. Line 1 now follows the name until someone edits it separately.
4. **An untouched form opened with a to-do list (low).** "Before saving: Add an expense name, Enter the amount" appeared before any typing and took a third of a small screen. It now appears once the form has been touched, and it is always shown for receipts.
5. **Opening a processed receipt focused a text field (low).** That opens the phone keyboard over the review. Focus now goes to the allocation action.

## Not done (follow-ups)

- **Compact rows for long receipts (#13).** Collapsing each line into a summary row (auto-expanding unresolved ones) is the remaining large win for 10+ line receipts. It touches every receipt-line test and needs its own design pass.
- **Draft persistence across reloads (#4).** Reload now warns but does not restore. A saved draft for manual entries needs a decision on storage: the README states that private ledger data is not cached on the device.
- **Single primary Save on ready receipts (#21).** "Save expense now" in the ready card duplicates the footer button. It is kept because on a long receipt it is the nearest Save. Revisit together with compact rows.
- **WebKit and physical devices.** WebKit is not installed in this environment, so the browser specs ran on Chromium only. Real iOS/Android keyboard overlap (finding 8) still needs a device check.

## Validation

- `npx tsc --noEmit`: clean. `npm run lint`: no errors (4 warnings, unchanged from base).
- `npm test`: 1,191 passed and 4 failed. The 4 failures are in `pwa-live-refresh.test.ts` and fail identically on `c36abcc`; they are unrelated to this change.
- Playwright (Chromium, local build): 47 passed. This includes the new `tests/browser/quick-expense.spec.ts` (quick taxi save, decimal comma and refusal, people/itemise/one name field, close/Escape guard, pending FX vs manual rate and next expense, checklist/Save agreement and focus, footer focus visibility, adjustments toggle, details collapse, single-line reopen, and unsaved-change detection for photo removal, printed-evidence edits and a cleared adjustment) and the updated layout specs at every existing viewport.
