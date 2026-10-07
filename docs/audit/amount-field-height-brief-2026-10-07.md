# Brief for Sol: make the Amount field the same height as the other fields

Investigated on 7 October 2026 against `main` at `7c35d35`. This brief describes the cause, the fix and how to check it. The fix below was tried on a local production build and the full Chromium browser suite passed with it applied. The change has not been committed.

## Problem

In the quick expense form (new expense, or an existing one-line expense), the **Amount** box is taller than every other field. The **Original currency** dropdown beside it is shorter, so the two boxes in that row don't line up.

Measured in Chromium on a production build, using the quick-form fixture with purchase details open:

| Viewport | Amount | Expense name, date, time | Currency, payer, time zone dropdowns |
| --- | ---: | ---: | ---: |
| 320 × 740 (touch) | **51.6 px** | 48 px | 46 px |
| 390 × 844 (touch) | **51.6 px** | 48 px | 46 px |
| 1440 × 900 | **51.6 px** | 46.8 px | 45 px |

There is also a smaller, separate mismatch: dropdowns are 1–2 px shorter than text inputs everywhere. On desktop this is visible in the itemised and receipt editors, where **Date** (46.8 px) sits beside **Paid by** (45 px) and **Time** sits beside **Original currency**.

## Cause

1. `components/expense-quick-review.css` (added in `ec896bd`, the quick-form change) gives the amount its own type size:

   ```css
   .quick-amount input {
     font-size: 1.15rem;   /* 18.4 px */
     font-weight: 650;
   }
   ```

   Fields take their height from the font (padding 11 px × 2 + 1 px border × 2 + line-height 1.5 × font size), so 18.4 px text gives a 51.6 px box. This rule also overrides the mobile rule `.overlay input { font-size: max(16px, 1rem) }` in `app/globals.css`: both selectors have the same specificity and this stylesheet loads later.

2. In Chromium, `<select>` ignores the inherited `line-height`, so a dropdown comes out about 2 px shorter than a text input with the same padding and font. `min-height: 44px` doesn't help, because both are already taller than 44 px.

## Change to make

**1. Remove the amount override.** In `components/expense-quick-review.css`, delete the whole `.quick-amount input { … }` block. Keep `.editor .fieldpair.quick-amount { grid-template-columns: … }`, which keeps currency beside the amount on phones.

With the block gone, the amount uses the normal field styles: 16 px on phones and touch devices (from `.overlay input`, which also stops iOS zooming on focus) and 0.95 rem on desktop.

**2. Give block-label dropdowns the same height as text inputs.** In `app/globals.css`, next to the existing `label > input, label > textarea, label > select { margin… }` rule (around line 783), add:

```css
/* Chromium ignores line-height on <select>; match the height of a text
   input with the same font (1.5 line-height + 22px padding + 2px border). */
label > select {
  min-height: calc(1.5em + 24px);
}
```

Keep this scoped to `label > select`. Compact dropdowns with their own sizing must not change. For example, `.item-language-actions select` ("Show first for item N") has a more specific `min-height: 44px` and stays at 44 px.

That is all the change needed. Don't change the `Amount` component or anything in `trip-app.tsx`.

### Result with the change applied (Chromium, same fixture)

| Viewport | Quick form, all fields | Itemised / receipt editor, standard fields |
| --- | --- | --- |
| 320 × 740 | 48 px (all 9 controls) | 48 px; no mismatched rows |
| 390 × 844 | 48 px (all 9 controls) | 48 px; no mismatched rows |
| 1440 × 900 | 46.8 px (all 9 controls) | 46.8 px; no mismatched rows |

Compact item-row controls keep their intended smaller sizes (item name 44 px, item total 46 px on phones, "Show first" 44 px), and no fields in the same row differ in height.

## Must keep working

- On touch devices the Amount field stays at 16 px or larger. The `expense-layout.spec.ts` touch checks assert this; with the override removed it is 16 px.
- At 320 px, `1000000.00` still fits in the Amount field without clipping. The "320px amount field" test passed, and the smaller font only adds room.
- Currency stays beside Amount on phones (`.fieldpair.quick-amount` grid).
- Decimal comma, paste handling, the validity message, select-on-focus of a zero, the checklist and Save, and footer scroll padding are all unaffected (no TS/JS change). All of `quick-expense.spec.ts` passed.

## WebKit / iOS: check before merging

WebKit wasn't installed in this environment, so only Chromium was measured. On iOS, `app/globals.css` (around lines 948–963, inside `@supports (-webkit-touch-callout: none)`) sizes date and time fields with `line-height: 1.2; height: calc(1.2em + 24px)`. That makes them 44 px (the min-height), not 48 px. That rule was written to stop them standing taller than the selects beside them. Now that selects are 48 px, change it to `line-height: 1.5; height: calc(1.5em + 24px)` so **Date** / **Time** match **Paid by** / **Currency** on iPhone. Then confirm in the WebKit project (CI runs it) or on a real iPhone that:

- date, time, text and dropdown fields in the quick form and the purchase details are the same height;
- the iOS native picker still opens and the value isn't clipped vertically.

If WebKit already renders selects at 48 px without step 2, step 2 is harmless there (it's a `min-height`).

## Test to add

In `tests/browser/quick-expense.spec.ts` (runs at 390 × 844 touch, in both engines), add a test that opens a new expense, opens purchase details (`.purchase-details-summary` → **Edit**), and checks that these all have the same rendered height (±0.5 px):

- the **Expense name** and **Amount** textboxes
- the **Original currency** and **Paid by** comboboxes
- the date and time inputs

Optionally, repeat the Amount vs Original currency check at 320 × 740 and 1440 × 900 in `expense-layout.spec.ts`.

## How it was measured

A temporary Playwright spec opened the quick, itemised (Split by item), edited and receipt-draft editors at 320, 390 and 1440 px. It recorded the rendered height of every visible `input` and `select` in `.editor-body` and flagged rows where controls side by side differed. Build with `RECEIPT_AI_OWNER_EMAIL=ci-owner@example.invalid npm run build`, then run `npm run test:layout`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if the bundled browser isn't present.
