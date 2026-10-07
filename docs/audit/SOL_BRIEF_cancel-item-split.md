# Brief: let people cancel "Split by item" on a manual expense

## Your role
You are implementing a small UX fix in TripTab (`github.com/Dessimat0r/triptab`), a mobile-first shared-expense app. The investigation is done (below); your job is to implement it, test it on mobile and desktop, and open a PR. **Mobile (390 × 844, touch) is the primary target.** Keep every existing behaviour listed under "Must not change".

Start from `main` at `7c35d35` or later. Run `npm run lint`, `npm test` and `npm run test:layout` before pushing.

## The problem
A new manual expense opens in the **quick form** (name, amount + currency, paid by, shared with). Tapping **Split by item** (or **Custom split**) switches to the **itemised editor**, showing the expense as "Item 1". There is no way back:

1. The remove (×) button on the only item is disabled: `disabled={editing.items.length === 1}` in `components/trip-app.tsx` (~line 2849). This is what people try, and it does nothing.
2. Even after deleting extra lines, the editor stays itemised. `itemiseEditor()` (~line 1491) sets `editorMode` to `{ quick: false }`, and nothing ever sets it back to `quick: true`. `editorMode` is only reset when a different entry opens (~line 1483).
3. `quickMode` (~line 1487) needs both `editorMode.quick` **and** `quickEligible(editing)` (~line 204). So even if the mode flag were reset, the form would not return unless the line matches what the quick form can show: one line, `name === title`, an amount that is not `null`, at least one member, no `percentages`/`units`/`quantity`/`translations`/`scanSource`, and no whole-bill `percentages` on the entry.

The only escape today is to close the editor and discard the expense.

## What to build

### 1. The × on the only line of a manual expense cancels the split
When the entry is **manual** (`!editing.receiptId && !editing.receiptScan && !editing.draftId`) and has exactly one item, enable that item's × button. Tapping it **returns to the quick form** and does not delete the line. Change its `aria-label` from "Remove item 1" to **"Stop splitting by item"** so the label says what happens. With 2 or more items, × removes that line exactly as it does now.

### 2. A visible "Use one amount" action
In `.expense-extra-actions` (where **Split by item** appears in quick mode, ~line 2909), show a `quiet` button **"Use one amount"** (lucide `Minus` or `Undo2`, `aria-hidden`) when `!quickMode`, the entry is manual and `editing.items.length === 1`. It runs the same collapse as the ×. This is the discoverable route back. It mirrors "Split by item" and is already a 44 px touch target via existing CSS. Do not show it for receipts or scans, or when there are 2 or more lines. People remove extra lines first, so nothing is merged silently.

### 3. One collapse function
Add a helper next to `quickEligible`/`withQuickName`, e.g. `collapseToQuick(entry: ReceiptEditor, memberIds: string[]): ReceiptEditor`. The result must satisfy `quickEligible`:
- Keep the line's `id`, `amount` (`null` → `0`, so the existing "Enter the amount" blocker shows) and `members` (empty → every trip member, as a new expense does).
- Set the line's `name` to `entry.title` (use `withQuickName` so `fieldSources.name` is `"user"`).
- Drop the line's `percentages`, `units`, `quantity` and `translations`, and set the entry's `percentages` to `undefined`.
- Leave `tax`, `tip`, `discount`, FX, date/time and everything else unchanged. Adjustments already render in both modes.

Then call `setEditorMode({ id: editing.id, quick: true })`, wrap the result in `carryReviewAcknowledgements(prev, …)` as the other split changes do, and move focus to the quick **Amount** field (`focusExpenseTarget(EXPENSE_TARGETS.amount, …)` after a `setTimeout(…, 0)`, as `itemiseEditor` does). The control that had focus disappears, so focus must not fall to `<body>`.

### 4. Confirm only when something would be lost
If the collapse would discard information the quick form cannot show, ask first. That is the case when the line has custom `percentages`/`units`, a `quantity` or `translations`, when the entry has whole-bill `percentages`, or when the line's name is non-empty and differs from the title. Reuse the existing async `confirm({ title, message, confirmLabel, cancelLabel })` helper, which `requestCloseEditor` (~line 790) uses for "Discard unsaved changes?". For example:
> **Use one amount?** — "Item 1's custom shares (and its separate name) will be replaced by an equal split between the people selected." Buttons: **Keep items** / **Use one amount**.

If nothing would be lost (the usual case: Split by item tapped, then cancelled), collapse immediately with no dialog.

## Must not change
- **Receipts, scans and drafts:** × on the last line stays disabled, "Use one amount" is never shown, and the itemised editor stays. Existing receipt and layout tests must pass unchanged.
- × on a line when there are 2 or more lines removes that line, and only that line.
- **Split by item** and **Custom split** still open the itemised editor with the same focus targets. The "first line follows the expense name" rule and its tests stay as they are (`quick-expense.spec.ts` "keep one canonical name", "checklist and Save agree").
- Unsaved-change detection (`editorWorkValue`) and the Close/Escape discard prompt are unchanged. A split-then-cancel with no other edits may count as dirty or not, as long as it never loses typed work.
- Saved data shape: the result is a normal one-item expense with no new fields and no migration.
- Existing saved expenses: opening one still picks its mode through `quickEligible` on open. A saved manual expense with one item that opens itemised (for example with custom percentages) may also use the new collapse, with the confirmation from step 4.

## Layout (mobile first)
- At `max-width: 480px`, `.item-top` is a 3-column grid with the × in a fixed 44 px column (`app/globals.css` ~line 3155). Enabling the button must not move it. Check that the enabled and disabled states look clearly different in light and dark themes. Today the disabled × looks almost the same as an enabled one, which is part of why this is confusing.
- "Use one amount" sits in `.expense-extra-actions` next to "Tip, tax or discount". At 320 px they must wrap without horizontal scroll and stay at least 44 px tall.
- When the editor returns to the quick form, the Amount field must be visible above the pinned `.editor-footer` on a 390 × 844 phone with the virtual keyboard open. `useStickyFooterReveal` and the existing "never left behind the pinned footer" test cover this pattern; extend them if needed.
- Desktop (1440 × 900): the same controls with no special casing.

## Tests to add
In `tests/browser/quick-expense.spec.ts` (already 390 × 844, touch, run on Chromium and WebKit):
1. Name + amount + Sam deselected → **Split by item** → × "Stop splitting by item" → the quick form returns with the name, amount, currency and people unchanged, Amount focused, no dialog → Save posts one item `{ name: title, amount, members }`.
2. The same through **Use one amount**.
3. **Split by item** → **Add item** → "Use one amount" is hidden, and × on item 1 removes item 1 only (item 2 becomes item 1). Then "Use one amount" appears and collapses.
4. **Custom split** → set a percentage → × → the confirm dialog appears. **Keep items** changes nothing; **Use one amount** returns to an equal quick split.

In `tests/browser/expense-layout.spec.ts`: for the manual-mode loop over widths (320/390/1440), after itemising, assert the × is enabled and that "Use one amount" keeps `fits(page)` true. For the receipt case, assert the last line's × is still disabled and "Use one amount" is absent.

Add a unit test for `collapseToQuick`: its result passes `quickEligible` for null amounts, empty members, a stale name, and percentages/units/quantity. If the helper is not exportable from the component, put it in `lib/` with `quickEligible`.

## Done when
- The behaviour above works on a 390 px phone (Chromium and WebKit) and on desktop. Attach before/after screenshots at 390 × 844 to the PR.
- Lint, unit and layout suites are green, and no existing test was changed except to add assertions.
- The PR description lists the behaviour changes and links this brief.
