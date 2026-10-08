# Expense entry: progressive-flow audit

8 October 2026 · Base: `main` at `b239d34` · Audit only: no application code has changed.

This audit reviews Sol's "Expense Entry UX and Design Audit" from the same day, then audits the add-expense flow against Gary's brief. It is written as a handoff for Opus to implement.

> Audit adding a new expense in detail. The interface seems rather cluttered and the CSS isn't great. It needs to be as simple as possible for the user, with the steps clearly laid out for ease of use. Make the steps truly progressive instead of feeling haphazard.

## Summary

The simplest route is already short. A same-currency manual expense takes two presses (Add expense, Save), and every field it needs is on the first phone screen. Keep that.

The clutter starts as soon as an expense is more than one amount. Three things make the flow feel haphazard rather than progressive:

1. **There is no fixed order.** The editor has two layouts and switches between them mid-task. Pressing **Custom split** or **Split by item** removes the amount field, folds payer and currency into a collapsed summary line, moves the currency conversion from the middle of the form to below "More options", and moves focus halfway down the page. A scanned receipt always opens in that second layout, even a one-line taxi receipt.
2. **Every optional detail has its own look.** On an untouched new expense, five different patterns offer more options: a text link, a card with an Edit button, outlined "+" buttons, a filled card and a bordered disclosure. Nothing signals which of them matters.
3. **Receipts show everything at once, several times over.** On a 390 px phone, a 7-line restaurant receipt is 9,040 px tall (10.7 screens), with 155 controls and about 1,000 words. It opens scrolled 712 px down. The first item starts 2.2 screens in, each item row is 713 px tall with 16 controls, and the conversion, per-person shares and photo are 8.7–9.6 screens down. The fact that nobody is assigned to a line yet appears in 38 separate messages.

The CSS has no scale. A single view uses 8 border radii and 7–8 font sizes, and spacing runs in 1 px steps from 6 to 28 px. An undefined `--border` token renders as a bright border in dark mode, `.personchips button` is styled in five places, and four selectors are left over from controls removed on 8 October.

**Recommended direction:** use one editor layout for every route, built from three fixed sections: **1 Purchase · 2 Split · 3 Check & save**. Sections never reorder. Optional details open inside the section they affect, all using one disclosure pattern. Receipt lines become compact rows that expand for editing. This adds no extra screens and no extra presses.

## How this was checked

- Built `main` locally (`RECEIPT_AI_OWNER_EMAIL=ci-owner@example.invalid npm run build`) and served it with `npm start`.
- Drove every route in Chromium with Playwright against local API fixtures. The fixture trip has four travellers (Gary, Sam, Priya, Tom), GBP as the holiday currency, a saved EUR taxi, and a scanned 7-line EUR restaurant receipt. The receipt has one low-confidence line, a €6 tip, a printed total €0.40 above the item sum, and nobody assigned. The photo is the repository fixture from `tests/fixtures/receipts`. No live data was used.
- Viewports: 390 × 844 (touch) and 1440 × 900, plus dark mode at 390.
- `docs/audit/expense-progressive-2026-10-08/measure.mjs` reproduces every screenshot and number below and writes `metrics.json`. Run it before and after each phase.
- Source read: the editor in `components/trip-app.tsx` (lines 1462–1530 and 1837–3116), `expense-quick-review.tsx`, `receipt-scan-review.tsx`, `share-split.tsx`, `receipt-capture.tsx`, `receipt-item-names.tsx`, `receipt-upload-dialog.tsx`, `lib/expense-readiness.ts`, `lib/quick-expense.ts`, and the editor CSS in `app/globals.css` and `components/*.css`. Also read the 6, 7 and 8 October expense audits so this one does not undo deliberate decisions.

### Measurements

All at 390 × 844. "Screens" is height divided by 844.

| View | Height | Screens | Controls | Words |
| --- | ---: | ---: | ---: | ---: |
| New expense, untouched | 1,119 px | 1.3 | 27 | 194 |
| Same, currency changed to EUR | 1,685 px | 2.0 | 31 | 287 |
| After **Custom split** | 2,340 px | 2.8 | 37 | 219 |
| **Split by item** with 3 lines | 2,749 px | 3.3 | 58 | 185 |
| Editing a saved EUR expense | 1,788 px | 2.1 | 34 | 284 |
| Scanned 7-line receipt | 9,040 px | 10.7 | 155 | 992 |
| Same, after **Share 7 remaining items equally** | 8,287 px | 9.8 | 153 | 701 |

Where each part of the 7-line receipt starts, measured from the top of the dialog:

| Part | y (px) |
| --- | ---: |
| Opening scroll position | 712 |
| "Receipt needs review" card | 241 |
| "7 items need people" | 1,247 |
| Paid by, date and currency (collapsed) | 1,476 |
| Split method | 1,564 |
| First item | 1,848 |
| Tip, tax and discount | 7,053 |
| Currency conversion | 7,316 |
| Each person's share | 7,860 |
| Receipt photo panel | 8,072 |

One foreign-language item row is 713 px tall and has 16 controls. When the checklist shows, the footer is 154 px, 18% of the screen.

## Sol's review: verdict

Sol's seven findings are all correct, and rendering the editor confirms each one. Its central advice is also right, and this audit keeps it: fix the structure before polishing the CSS, and don't add a wizard or extra presses.

I would change Sol's direction in four places:

1. **Items and sharing should be one step, not two.** Sol proposes Purchase → Items → Sharing → Review for itemised expenses. That makes the user go over the same lines twice, once for prices and once for people. In TripTab, items are already a way of splitting (the editor's own control is "Split method: By item"), and a compact row can hold the name, price and people together. I recommend Purchase → Split → Check & save, the same three sections for every route.
2. **The conversion already appears immediately; it is too large and badly placed.** In the quick form, the conversion panel appears as soon as a foreign currency is chosen. The problem is that it is about 500 px of mostly fixed text. It sits between the date and the split options, below the per-person shares that it determines. I recommend one line under the amount, with the manual rate and the bank charge behind "Change".
3. **Capture → Verify → Allocate → Review is the right mental order, but it should not become separate screens.** Don't add a "Looks right" press. The one-press **Confirm & save** from 8 October must stay. Checking a receipt should mean reading it, not clicking through it.
4. **"Simple and advanced splitting feel like different interfaces" understates the problem.** They are different layouts. **Custom split** moves payer and currency into a collapsed line, removes the amount field and moves focus to the middle of the page (screenshot 04).

What Sol missed:

- **Measurements.** Sol gave no heights, control counts or positions, so "cluttered" was never quantified. See the tables above.
- **Receipts never get the simple form.** `lib/quick-expense.ts:4-19` rejects any entry with a `receiptId`, `receiptScan` or `draftId`. Scanning a one-line taxi receipt therefore produces a harder form than typing it.
- **The receipt opens 712 px down the page,** below the name, photo and totals.
- **Repetition.** The unassigned state appears in 38 messages, the photo can be reached four ways, the shares are shown in two cards, and the totals appear in three places.
- **A per-line language preference.** Every foreign line has its own "Holiday display default" select (`receipt-item-names.tsx:87`).
- **AI features on manual expenses.** Every typed line has a "Discuss <item>" conversation, and "More options" offers receipt language, conversation and import.
- **Six defects (D1–D6 below),** including lost focus after the bulk-share button and misleading conversion text.
- **Specific CSS faults:** an undefined token, conflicting fallbacks, duplicated rules and dead rules.

Sol noted that the visual impact "still requires rendering". This audit rendered and measured it.

## Findings

Severity: **High** means the flow feels haphazard or the next step is hidden. **Medium** means added clutter or confusion. **Low** means polish.

Groups: A = order and progression, R = receipt review, S = splitting, C = currency, P = receipt capture, V = visual design and CSS, D = defects.

### A. Order and progression

**A1. The editor has two layouts and switches between them mid-task (High).**
`quickMode` (`trip-app.tsx:1465-1469`) chooses between the quick form (`:2666-2705`) and the itemised editor (`:2795-2921`). The two place the same fields differently:

| Field | Quick form | Itemised editor |
| --- | --- | --- |
| Amount | At the top, labelled | Removed; becomes line 1's price, which has no visible label |
| Currency | Beside the amount | Inside the collapsed "Purchase details" summary |
| Paid by | At the top | Inside the collapsed "Purchase details" summary |
| Conversion | After the date (`:2794`) | After "More options" (`:2999`) |
| Shares | One line under the people chips | "Each person's share" card at the bottom |
| Footer label | Total | Itemised total |

**Custom split** (`:2703`) and **Split by item** (`:2923`) switch to the itemised layout. Focus moves to the first item's split buttons, halfway down the page (screenshot 04). From the user's point of view, asking for a custom split makes the form they were filling in disappear.

**A2. Receipts always get the itemised layout (High).** `quickEligible` requires that there is no `receiptId`, `receiptScan` or `draftId` (`lib/quick-expense.ts:4-19`). A one-line taxi receipt therefore shows "Split method", a numbered item row and per-item split buttons.

**A3. A receipt opens halfway down the page (High).** `QuickSplit` takes initial focus (`trip-app.tsx:2657`, via `data-autofocus`), so at 390 px the dialog opens scrolled 712 px down (screenshot 06). The expense name, the photo, the totals and the heading of the review card are all off-screen. The 6 October reason for this focus is still valid: it keeps the keyboard closed. The fix is to put the bulk action on the first screen, not to scroll down to it.

**A4. Sections don't follow the order of decisions (Medium).**
- In the quick form, GBP shares appear directly under a EUR amount ("Gary £18.09 · Sam £18.09…", screenshot 03), before the conversion that produces them.
- On a receipt, "Ready to save", which is the final check, appears above the split method and the items (screenshot 11). The conversion and the shares come about 6,000 px further down.
- On a manual expense, "Have a receipt?" comes after the amount and people have been entered (`:2951`). Since 8 October the expense list has its own **Scan receipt** button, so this card mostly repeats it at the wrong moment.

**A5. Five different patterns offer more options (Medium).** On an untouched new expense (screenshot 02):
- a text link (Custom split)
- a bordered card with an Edit button (date)
- outlined "+" buttons (Split by item; Tip, tax or discount)
- a filled card (Have a receipt?)
- a bordered disclosure (More options)

Inside these there are further variants: disclosures with a ▶ marker (Enter a conversion rate yourself, Discuss item, More options), summaries with no marker (Add notes for reading the photo, Check or correct printed totals) and a checkbox (Use the actual bank charge). The same kind of choice looks different each time, so the form reads as a pile of options rather than a sequence.

### R. Receipt review

**R1. Every line is a full editor (High).** At 390 px, one foreign-language line is 713 px tall with 16 controls (screenshot 09). It contains:
- two name fields, each with a translate button
- a "Holiday display default" select
- the price and a remove button
- the printed-line text and a warning
- "Share of item N", four mode buttons and a hint
- four people chips
- a percentage total and an error
- "Discuss <item>"

Seven lines take about 5,000 px. Even a typed manual line, with no translation or warnings, is 463 px with 12 controls. Compact rows were deferred as follow-up #13 on 6 October, and this is now the largest single cause of clutter.

**R2. The same fact is repeated everywhere (High).** With 7 unassigned lines, the editor shows 38 messages that say so: five on every line, plus three summaries.

The summaries:
- the review card's counts line, "7 need people assigned" (`receipt-scan-review.tsx:66`)
- "7 items need people" (`QuickSplit`)
- the footer checklist

On every line:
- a bold entry in the review card's list, "X: Choose who owes this item's cost." (`:68`, from the `unassigned-item` warnings)
- "Item needs people assigned"
- "Unassigned: choose who owes this item. Printed quantities do not tell us who had it." (`share-split.tsx:166`)
- "Total 0% / 100%", in red
- "Choose at least one person for each item", in red

The red per-line errors appear before the user has done anything.

**R3. Review, allocation and confirmation are three separate cards in the wrong order (High).** The page shows, in order:
1. "Receipt needs review": totals, counts, a nested "Confirm when saving" card, the warnings list and the printed totals
2. "7 items need people"
3. "Ready to save", once everything is allocated
4. far below, "Each person's share"

The shares therefore appear twice ("Ready to save" and "Each person's share"), and the totals three times (the review card, "Ready to save" and the footer). "Confirm when saving" is a card inside a card (screenshot 08).

**R4. There are four ways to see the photo (Medium).**
- the "View receipt photo" button (`trip-app.tsx:2652`)
- the "View receipt photo" link inside the summary (`receipt-scan-review.tsx:111`), which opens a new tab
- the thumbnail in the receipt panel
- the "Open stored receipt image" link (`receipt-capture.tsx:316`)

On a phone, the thumbnail is at y = 8,072.

**R5. The receipt panel is built for setting up a receipt, not reviewing one (Medium).** After a receipt has been read, the panel (`receipt-capture.tsx:296-379`) still contains:
- two status sentences
- a location field
- **Scan receipt** and **Choose image**, which would replace the photo but are not labelled as replacing it
- the photo and a Remove button
- a three-sentence hint about privacy and AI
- "Connected ChatGPT tools" and "Request to send in ChatGPT"

On desktop this panel is the left column, so the photo sits below about 300 px of text and is only 266 px wide (screenshot 12), which is too small to check lines against.

**R6. Translation controls repeat on every line (Medium).** Each foreign line has an English field, a receipt-language field, two translate buttons and its own "Holiday display default / English first / Receipt original first" select (`receipt-item-names.tsx:84-88`). The select is a display preference saved to the account, but it appears inside data entry, once per line. The batch button, "Translate 7 missing names to English", already covers the common case.

### S. Splitting

**S1. A custom split takes two steps and a layout switch (High).** From the quick form, the user must press **Custom split** (which switches to the itemised layout), find "Share of item 1", press **Custom percentages** and then type. A separate "Split method: Whole bill (equal or custom %)" select (`trip-app.tsx:2796-2819`) offers whole-bill percentages through its own share control. For a single amount, item-level and whole-bill percentages give the same result through two different interfaces.

**S2. "One person" duplicates an existing mode (Medium).** Selecting one chip in Equal mode produces the same data as "One person" (`share-split.tsx:134-146`). "One person" then replaces the chips with a dropdown. At 390 px the four mode buttons wrap onto two rows.

**S3. "Equal" is shown as selected when nobody is selected (Medium).** A new or scanned line with no people shows Equal with `aria-pressed="true"` (`share-split.tsx:117`), next to the red "Choose at least one person" error. Confirmed in Chromium.

**S4. The extra-action buttons don't line up (Low).** In the itemised layout, "Add item", "Use one amount" and "Tip, tax or discount" are three outlined buttons of different widths stacked on top of each other (screenshot 04). "Use one amount" disappears once there are two lines.

### C. Currency

**C1. The conversion panel is large and repeats itself (Medium).** At 390 px, `fxPanel` (`trip-app.tsx:1926-2054`) is about 500 px tall. It contains:
- the heading "What did the bank charge?", before any bank has been mentioned
- a "Look up historical rate" button that stays after the automatic lookup has succeeded
- a rate with eight significant figures, "0.86120000" (`:1957`)
- "Estimated charge" in link blue
- a manual-rate disclosure and a bank-charge checkbox
- a four-line footnote

**C2. Currency labels assume a receipt (Low).** The field is labelled "Original currency" (`:1858`) even on a manual expense, and its empty option reads "Confirm receipt currency". "Currency" is enough.

### P. Receipt capture

**P1. Three capture screens use three sets of wording (Medium).**

| | Expense list | Editor, before a photo | Inbox dialog |
| --- | --- | --- | --- |
| Camera button | Scan receipt | Scan receipt | **Take photo** |
| Notes | None | Hidden below the buttons, "Add notes for reading the photo" | Visible above the buttons, "Who bought what?" |
| Place | None | Inside the notes disclosure, "Receipt location" | Its own disclosure, "Place or current location" |
| Privacy hint | None | One sentence | A different sentence |

Since 8 October, choosing a photo starts the upload immediately, so notes only help if they are entered first. In the editor they sit below the buttons and start collapsed.

### V. Visual design and CSS

**V1. Too many boxes (Medium).** Before allocation, the receipt view has nine cards: the review card, the "Confirm when saving" card nested inside it, "7 items need people", the purchase-details summary, the split method, More options, the conversion panel, the shares and the receipt panel. The manual form has three: the date summary, the receipt card and More options. These boxes do the job that section headings and spacing should do.

**V2. There is no spacing, radius or type scale (Medium).** The editor rules use:
- spacing of 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26 and 28 px, for example `.additem { margin: 17px 0 22px }`
- radii of 6, 7, 8, 10, 12, 13, 14, 18 and 999 px, of which 8 appear in the rendered receipt view
- 11 font sizes from 0.65 to 1.55 rem, of which 7–8 appear in any one view

**V3. Spacing is set globally on child elements (Medium).** `label > input/select/textarea { margin: 8px 0 20px }` and `label > small { margin-top: -12px }` (`globals.css:817-831`), `.footnote { margin-top: 14px }` (`:685`) and `.personchips { padding: 12px 0 0 24px }` all apply everywhere. Most editor components then undo them: `.receipt-split > label > select`, `.adjustments input`, `.single-share select`, `.percentage-input input`, `.share-split .personchips` and `.quick-shared .personchips`. This is why the vertical spacing differs from section to section.

**V4. Tokens are missing or inconsistent (Medium).**
- `--border` is never defined. `.receipt-scan-review` and `.receipt-no-items` fall back to `#d0d7de` (`receipt-editor-layout.css:59, 79`), which renders as a bright border in dark mode (screenshot 14).
- `--surface-raised` has two different light-mode fallbacks: `#f3f5fa` in most places and `#fff4d9` at `globals.css:1827`. One token produces two colours.
- Several hard-coded colours should be tokens:
  - label `#424c65` (`globals.css:790`, repeated at `expense-quick-review.css:249`)
  - input border `#dbe0eb`, against `--line` `#e4e8f0` (`globals.css:797`)
  - split preview `#f6f7fc`, against `#f3f5fa` elsewhere
  - selected chip `#edf0ff` / `#cbd2ff`
  - item number `#8e97ac`
  - primary hover `#3546c5`

  `globals.css` contains 149 hex literals in total.

**V5. Duplicated and dead rules (Low, but they make every change riskier).**
- `.personchips button` is styled in five places: `globals.css:1109, 2073, 2107, 2568`, plus the `.share-split` and `.quick-shared` overrides.
- In `expense-quick-review.css`, `.save-checklist ul` is defined twice, first as flex and then as inline-flex (`:187`, `:324`). `.save-checklist-item` gets a 32 px minimum height at `:205` and is later raised to 44 px.
- `.editor .expense-title-input:focus` is defined twice (`globals.css:943, 947`), and so is `.modalheading .eyebrow` (`:882, 2097`).
- Four selectors have no references in any TSX file: `.receipt-total-ack` and `.receipt-save-block` (`receipt-editor-layout.css:76-78`), `.receipt-review-all` (`expense-quick-review.css:8, 164, 168`) and `.receipt-preview` (`globals.css:988-1010`).

**V6. Editor styles are spread across many files (Low).** Editor rules live in:
- `globals.css`: about 210 editor lines, interleaved with unrelated pages
- `expense-quick-review.css`: 387 lines covering the checklist, the quick form, capture and the saved banner
- `receipt-editor-layout.css`: about half written as one-line rules
- `share-split-units.css`, `receipt-languages.css` and `receipt-upload.css`

The files also mix two authoring styles.

**V7. Header polish (Low).** The mode caption ("Add an expense") sits 2 px below the name input, and the placeholder "Taxi, groceries, dinner…" is cut off at 390 px. Otherwise the identity header from 7 October works and should stay.

**V8. The desktop dialog is too wide for a short form (Low).** The manual form uses the 1,060 px dialog, so the Amount field is 560 px wide for a few digits. Without a photo, cap the dialog at about 640 px.

### D. Defects found along the way

These don't depend on the redesign and can be fixed first.

| # | Defect | Where | Evidence |
| --- | --- | --- | --- |
| D1 | Focus drops to `<body>` after **Share N remaining items equally**, because the focused button unmounts | `expense-quick-review.tsx:51` | `document.activeElement` is `BODY` after the click (Chromium) |
| D2 | The conversion panel shows "Estimated charge: Outside the supported amount range" whenever `previewTotal` fails for any reason, including unassigned items | `trip-app.tsx:1968`, `:103-107` | Screenshot 10 |
| D3 | Equal shows as selected when nobody is selected | `share-split.tsx:117` | S3 |
| D4 | Bright border in dark mode, from the undefined `--border` | `receipt-editor-layout.css:59` | Screenshot 14 |
| D5 | "Look up historical rate" stays after the automatic lookup; the rate shows as `0.86120000` | `trip-app.tsx:1938-1951, 1957` | Screenshot 03 |
| D6 | The receipt AI conversation ("Discuss <item>") and "More options · receipt language, conversation, import" appear on typed manual expenses | `trip-app.tsx:2886, 2952` | Screenshots 04, 05 |

## Recommended design

### Principles

1. **One layout for every route, in three fixed sections:** 1 Purchase · 2 Split · 3 Check & save. Sections never reorder or disappear; only their contents grow. Mark them with numbered section headings, not cards.
2. **Nothing is gated.** There are no Next buttons and no "Looks right" presses. A simple manual expense stays at two presses and a clean scan at three, and the one-press **Confirm & save** from 8 October stays.
3. **Details open inside the section they affect,** always with the same disclosure pattern: a row showing a label, the current value and a chevron, which expands its controls in place. Opening one never moves other fields.
4. **Each message appears once,** next to the place where it can be fixed.
5. **Receipt lines are compact rows that expand for editing.** A row that needs attention (a flag, an unreadable price, an invalid split) is highlighted and may open itself. It doesn't print paragraphs.

### Layout

```
Header        [icon] Dinner ✎                                  ✕
              New expense

1 Purchase    Amount [ 84.00 ] [ EUR ▾ ]
              ≈ £72.34 · 1 EUR = 0.8612 GBP, 7 Oct reference      Change ›
              Paid by [ Gary ▾ ]
              7 Oct 2026, 21:14 · Lisbon                          Change ›
              Receipt: [thumbnail]  Total €110.30 · items €109.90 (€0.40 less)

2 Split       Single amount:
                Shared with  (G) (S) (P) (T)
                Equally · Gary £18.09 · Sam £18.09 · …            Change ›
                  → Equally | Percentages | Shares | By item  (opens in place)
              By item or receipt:
                [ Share everything equally ]  [ All to Gary ]   (only while lines are unassigned)
                Bacalhau à Brás                           €16.50
                (G) (S) (P) (T)                       ⚑        ⌄
                …
                Tip €6.00 · Tax · Discount                        Change ›
                + Add item

3 Check       Gary £23.67 · Sam £23.66 · Priya £23.66 · Tom £23.66
  & save      Saving confirms: €0.40 difference · Água com gás reading
              Receipt tools ›   (photo, notes, language, assistant, import)

Footer        €109.90 (£94.65)                  [ Confirm & save expense ]
```

**1 Purchase**
- Amount and currency come first. When the currency differs from the holiday currency, show the one-line conversion beneath them. "Change" opens the manual rate, the actual bank charge and one sentence of explanation. Show "Look up rate" only as "Retry" after a failed lookup.
- **Paid by** is always here; today each layout hides it differently.
- Date, time and zone form one disclosure row. It opens by itself when a value is missing, or when a receipt left a default in place (keep `purchaseDetailsNeedAttention`).
- On a receipt, show a photo thumbnail that opens the existing zoom viewer, plus one reconciliation line, with "Correct printed totals" as a disclosure. The thumbnail is the only way to view the photo.
- On a manual expense without a photo, replace the bottom card with one compact row at the top: "Have the receipt? Scan · Choose image".

**2 Split**
- **Single amount:** people chips, one line of live shares, and "Change", which opens the split method in place (Equally, Percentages, Shares, By item). Choosing By item turns the amount into line 1 without leaving the form. Opus should propose how the amount behaves once lines exist: it could stay as a Total that the lines must add up to, or become their sum. There is no layout switch and no focus jump.
- **Items** (manual itemised, or any receipt with more than one line):
  - The bulk bar shows only while some lines are unassigned.
  - A collapsed row shows the name, price, avatar toggles, a single flag icon if anything needs checking, and a chevron to expand.
  - An expanded row shows the names (with translation), price, split method (Equal, Percentages or Shares; drop One person), printed text, quantity evidence, and "Discuss" only when receipt AI is available for this entry.
- Adjustments become one row at the end of the list.
- The unassigned state is shown only by the highlighted row, the count in the bulk bar and the footer.

**3 Check & save**
- Per-person shares in the holiday currency. This replaces both "Ready to save" and "Each person's share".
- The existing acceptance points ("Saving confirms…") with their jump links, without a nested card.
- A collapsed "Receipt tools" disclosure: replace or remove the photo, location, notes and conversation, receipt language, item display order, ChatGPT handoff, and pasting itemised data. On a manual expense without a photo it holds only the import.

**Footer:** behaviour unchanged. Reduce the checklist to one line ("Choose who shares 7 items ›", "+N more") so the footer stays at about 110 px or less.

**Desktop, 1024 px and wider, with a photo:** the left column holds only the photo, sticky, at least 360 px wide and zoomable; everything else moves into "Receipt tools". Without a photo, cap the dialog at about 640 px in a single column.

### What stays exactly as it is

- The readiness model (`expenseSaveBlockers`): Save stays enabled, and each blocker focuses its field.
- **Confirm & save** computes the acknowledgement on submit. Hard blockers and server checks are unchanged.
- Initial focus on a receipt never opens the keyboard. It stays on the bulk bar, which will now be on the first screen.
- The unsaved-changes guard, the `beforeunload` warning, decimal-comma input, footer focus visibility, 44 px targets, and no horizontal overflow at 320 px.
- The identity header from 7 October (name and icon).
- The AI only proposes changes; the user confirms them.

## Implementation plan for Opus

First verify these findings against the code. Then propose the layout, as a static mock or as screenshots at 390 and 1440, before building. Use one PR per phase.

1. **Defects.** Small and independent: fix D1–D6.
   - D1: when the bulk bar unmounts, move focus to the first section 2 row or the Split heading.
   - D2: distinguish "can't calculate yet" from "out of range".
   - D3: show no mode as selected while nobody is selected.
   - D4: define the token, or use `--line`.
   - D5: hide the lookup button once a rate exists, and show at most six significant figures.
   - D6: show item discussion and receipt language only when the entry has a photo or scan, or receipt AI is connected.
2. **Tokens and an editor stylesheet.**
   - Add tokens for spacing (4, 8, 12, 16, 24, 32), radius (8, 12, pill), type (0.8, 0.875, 1, 1.25, 1.5 rem), surfaces and borders, all with dark-mode values.
   - Create one stylesheet for the new sections, spacing stacks with `gap` rather than child margins.
   - Delete the dead rules. Don't restyle the old components yet.
3. **Unified sections.**
   - Render 1 Purchase, 2 Split and 3 Check & save in both modes.
   - Payer, currency, date and conversion always go in section 1.
   - Section 3 has one summary, replacing `ReadyToSave`, the split preview and `ReceiptReviewSummary`.
   - Keep one way to view the photo, add the Receipt tools disclosure, and open receipts at the top.
   - `quickMode` should no longer decide the layout, only whether section 2 shows a single amount or item rows.
4. **Splitting in place.**
   - Open the split method in place for a single amount, and make By item convert without a layout switch.
   - Drop One person, and merge whole-bill percentages into the same control.
   - Decide how single-line receipts behave (open decision 1).
5. **Compact item rows.**
   - Rows are collapsed by default and expand for editing. Rows with hard blockers expand automatically.
   - Reduce the unassigned messages as described in R2.
   - Move the translation display preference into the expanded row, or to receipt level (open decision 2).
6. **Capture consistency and the desktop photo column.** Use one capture component, with the same wording, for the list, the editor and the inbox (P1), with notes before the buttons. On desktop, the left column holds only the photo.
7. **CSS clean-up.** Remove the superseded rules from `globals.css` and the component files, so that each selector is defined once.

## Acceptance criteria

Measure with `measure.mjs` and the same fixture. The targets for the 390 × 844 receipt are estimates, to be confirmed during the design phase.

| Check | Now | Target |
| --- | ---: | ---: |
| Manual, untouched: height | 1,119 px | ≤ 1,119 px, with name, amount, currency, payer, people and Save on the first screen |
| Manual: presses to save | 2 | 2 |
| Manual in a foreign currency: height | 1,685 px | ≤ 1,250 px |
| Custom split: payer, amount and currency stay visible and in place | No | Yes |
| 7-line receipt: height | 9,040 px | ≤ 2,600 px |
| 7-line receipt: opening scroll position | 712 px | 0, with the bulk action on the first screen |
| 7-line receipt: top of the first item row | 1,848 px | ≤ 844 px |
| Collapsed item row | 713 px, 16 controls | ≤ 120 px, ≤ 6 controls |
| 7-line receipt: controls / words | 155 / 992 | ≤ 60 / ≤ 350 |
| Unassigned-state messages | 38 | ≤ 3 |
| Ways to view the photo | 4 | 1 |
| Distinct radii / font sizes in one view | 8 / 7–8 | ≤ 3 / ≤ 5 |
| Undefined CSS custom properties | 1 (`--border`) | 0 |
| Focus lands on `<body>` after an editor action | Yes (D1) | Never |
| Clean scan: presses | 3 | 3 |
| Allocated receipt with review points: presses | 1 | 1 |

Every existing browser spec must keep passing in Chromium and WebKit, at all eight layout viewports.

These tests check the current structure and will need updating:
- `tests/browser/quick-expense.spec.ts`: Custom split, Split by item, Use one amount, Tip/tax, Details & split, `purchase-details`, Custom percentages
- `tests/browser/expense-layout.spec.ts`: Split by item, One person, Custom percentages
- `tests/browser/expense-flow.spec.ts`: Ready to save, Look up historical rate, `quick-split`, `purchase-details`
- `tests/browser/expense-confirmation.spec.ts`: Confirm when saving, View receipt photo, `receipt-scan-review`
- `tests/receipt-scan-ui.test.ts`, `tests/receipt-render-performance.test.ts` (Discuss), `tests/share-split.test.ts`, `tests/expense-readiness.test.ts` (More options)

Update their assertions to the new structure, but keep the behaviour each one protects.

Validate each phase with `npx tsc --noEmit`, `npm run lint`, `npm test` and Playwright in Chromium and WebKit. Builds need `RECEIPT_AI_OWNER_EMAIL` set; CI uses `ci-owner@example.invalid`.

## Open decisions for Gary

1. **Single-line receipts:** should they use the simple single-amount split (recommended)? The line would keep its printed text and warnings, but this changes how the line's name follows the expense name.
2. **The per-line language display preference:** keep it inside the expanded row (recommended), or replace it with one choice per receipt?
3. **Section headings:** numbered, "1 Purchase · 2 Split · 3 Check & save" (recommended), or unnumbered?
4. **Receipt history:** keep the tab bar, or make it a header action and free about 70 px?

## Evidence

Everything is in `docs/audit/expense-progressive-2026-10-08/`. `measure.mjs` regenerates the screenshots and `metrics.json`.

| # | Screenshot | Shows |
| --- | --- | --- |
| 01 | `01-new-expense-390.png` | Untouched new expense, first screen |
| 02 | `02-new-expense-full-390.png` | Same, full length: five patterns for more options (A5) |
| 03 | `03-foreign-currency-full-390.png` | EUR expense: GBP shares above the conversion; size of the conversion panel (A4, C1, D5) |
| 04 | `04-custom-split-full-390.png` | After **Custom split**: amount removed, payer and currency collapsed, conversion moved down (A1, S1, D6) |
| 05 | `05-itemised-three-lines-full-390.png` | Three manual lines: 463 px and 12 controls each, with "Discuss item" on typed lines (R1, D6) |
| 06 | `06-receipt-opening-390.png` | Receipt opens scrolled 712 px down (A3) |
| 07 | `07-receipt-full-overview-390.png` | The full 9,040 px receipt, at half scale |
| 08 | `08-receipt-review-section-390.png` | Review card with nested card and repeated unassigned messages (R2, R3) |
| 09 | `09-receipt-item-rows-390.png` | One 713 px line with 16 controls (R1, R6, S3) |
| 10 | `10-receipt-bottom-390.png` | Conversion, shares and photo panel at the bottom; misleading "Outside the supported amount range" (R4, R5, D2) |
| 11 | `11-receipt-allocated-390.png` | "Ready to save" placed above the split method (A4, R3) |
| 12 | `12-receipt-desktop-1440.png` | Desktop: setup text above a small photo (R5) |
| 13 | `13-inbox-upload-390.png` | Inbox dialog labelled "Take photo" (P1) |
| 14 | `14-receipt-dark-390.png` | Dark mode: bright review-card border (D4) |
