# Brief: expense title and icon at the top of the expense editor

## Your role
Implement this change in TripTab (`github.com/Dessimat0r/triptab`), starting from `main` at `7c35d35`. Follow the conventions in the code around you. Mobile is the primary target, and desktop must still work. Do not change any expense behaviour other than where these two controls appear and how they look.

## What the owner asked for
> For creating or editing an expense, we want the title of the expense at the very top, which should be clickable for editing. Also, we want the expense icon next to this, and this should also be clickable for editing.

## Current state (verified in source)
All of this is in `components/trip-app.tsx`, in the editor dialog (`{editing && trip && … <section className="modal editor" aria-labelledby="expense-title">`, around lines 2576–2620).

- **Header (`.modalheading`, ~2591):** the eyebrow "MAKE EVERY ITEM FAIR", then `<h2 id="expense-title">` holding the mode ("Add an expense", "Edit expense", "Review receipt" or "Review expense update"), then the close `iconbutton`. The dialog's accessible name comes from that `h2`.
- **Title field (~2633):** a labelled `<input id={EXPENSE_TARGETS.title}>` ("Expense name") inside `.edit-fields`. It sits *below* the restoration notice, the receipt photo viewer, `ReceiptScanReview`, `QuickSplit` and `ReadyToSave`. Its `onChange` matters: it calls `userReceiptField(editing, "title", …)` and, in quick mode or for an untouched new manual expense, `withQuickName` so that line 1 follows the name. Under it is the "Suggested name…" footnote (shown when `fieldSources.title === "default"` on a receipt or draft).
- **Icon (~2938):** `<ExpenseIconPicker entry={editing} showLabel …>` is inside `MoreOptions` (collapsed by default), so most people never see it. The picker (`components/expense-icon.tsx`) is already a button that opens a portal dialog. Without `showLabel` it renders only the 45 px badge (`components/expense-icon.css`), and its `aria-label` already says "Choose icon for {title}. Selected/Automatic: {label}".
- **Initial focus:** `ModalA11y` focuses `[autofocus]/[data-autofocus]` first, otherwise the first focusable control. Today a new manual expense lands on "Expense name", and a processed receipt lands on the `QuickSplit` action (`data-autofocus`), so the phone keyboard stays closed. Both behaviours must survive.
- **Readiness:** `lib/expense-readiness.ts` maps the "Add an expense name" blocker to `EXPENSE_TARGETS.title` (`expense-name-field`), and `focusExpenseTarget` scrolls to and focuses it.
- **Styles:** `.editor form > .modalheading` in `app/globals.css` (~875, and the `max-width: 700px` override ~1459, where the editor is full-screen `100dvh`). Phone overflow guards are in `components/receipt-editor-layout.css`.

## Target design
Make the header row the identity of the expense:

```
[icon] [Expense title ............ ✎]  [×]
       Add an expense · tap to rename      ← small muted mode line (the h2)
```

1. **Icon, top left.** Render `ExpenseIconPicker` (without `showLabel`) as the first item in the header. A tap opens the existing picker. Size it for touch: the visible badge can stay 40–45 px, and the hit area must be at least 44 × 44 px. Remove the labelled copy from `MoreOptions` so there is only one place to change it. The picker's own preview already shows "Automatic" or "Your choice", so no information is lost; check that the `aria-label` keeps the selected/automatic wording.
2. **Title, next to the icon.** Move the existing input into the header and style it as the heading: large and bold (match `.modalheading h2` at 1.4rem desktop; about 1.2rem on phones is fine), no box at rest, a subtle underline or background plus a pencil hint on hover and focus, and a clear `:focus-visible` ring. It is still a real `<input>`, so **one tap places the caret and opens the keyboard**. Do not build a read-only label that switches into an input: that costs an extra tap on mobile and breaks the readiness focus target.
   - Keep `id={EXPENSE_TARGETS.title}`, `required`, `maxLength={200}`, `autoComplete="off"`, the placeholder logic and **the `onChange` body unchanged**.
   - Keep the accessible name exactly **"Expense name"** (`aria-label`, or a visually hidden `<label>`). The browser specs query `getByRole('textbox', { name: 'Expense name', exact: true })`.
   - Long titles: one line, no wrap, ellipsis or horizontal scroll inside the input at rest, with the full text while editing. The row must never cause horizontal page scroll at 320 px.
   - Move the "Suggested name…" footnote directly under the header row, unchanged.
3. **Mode line.** Keep `<h2 id="expense-title">` with the same mode text (the specs assert `heading 'Edit expense'` is visible), but restyle it as a small muted line under the title. The dialog stays labelled by it. Drop the "MAKE EVERY ITEM FAIR" eyebrow, or keep it only on desktop if space allows; your call.
4. **Close button** stays at the top right, unchanged (`flex-shrink: 0`).
5. **Focus stays as it is today.** A new or manual expense opens with the title focused. A processed receipt still focuses `QuickSplit`, because its `data-autofocus` wins and the header input must not get `autoFocus`. Make sure the icon button, which is now first in DOM order, does **not** become the default focus for a new expense: add `data-autofocus` to the title input when no `QuickSplit` is rendered, or use the equivalent. Tab order should run icon → title → close → body.
6. **Mobile header.** On phones (`max-width: 700px`) the editor is full-screen. Keep the header compact (about 72–88 px) so name, amount, payer, people and Save stay on the opening screen at 390 × 844. Make the header sticky only if it does not reduce that; the current measurements are in `docs/audit/expense-entry-streamlining-2026-10-06.md`.

## Must not regress
- Quick-name linking (line 1 follows the name), `fieldSources.title` provenance, "Suggested name" footnote.
- The unsaved-changes guard (`editorDirty`): changing the icon or the title still counts as unsaved, and Close or Escape still asks before discarding.
- Readiness checklist: "Add an expense name" focuses and scrolls the header input into view, including on phones with the pinned footer.
- Receipt flows: photo viewer, scan review, `ReadyToSave` (it reads `editing.title`), Receipt history tab (the header stays visible above both views), drafts and expense updates.
- Icon picker behaviour: Automatic vs chosen, the background colour, saving into `editing.icon`, and the existing pickers on the expense list and drafts (lines ~1559 and ~1716), which stay as they are.
- Save notice ("Saved “Taxi”." with **Add another**), delete confirmation text, and `submitExpense` title trimming.

## Tests
- Update `tests/browser/quick-expense.spec.ts` and `tests/browser/expense-layout.spec.ts` only where layout assertions genuinely move. Role and name queries should keep working unchanged.
- Add browser coverage for:
  - New expense: the title input is in the header, focused, and above the amount (bounding box `y`). Typing names line 1 as before.
  - Tapping the header icon opens "Choose an icon". Choosing one updates the header badge and marks the editor dirty (Close asks before discarding).
  - A processed receipt still focuses the `QuickSplit` action, not the title.
  - At 320 × 740, 390 × 844 and 1440 × 900: no horizontal overflow (`scrollWidth <= clientWidth` on the editor), the header icon and close button are ≥ 44 px, and a 200-character title doesn't push the close button off-screen.
  - The "Add an expense name" blocker focuses the header input.
- Run `npx tsc --noEmit`, `npm run lint`, `npm test` and the Playwright suite. The 4 `pwa-live-refresh.test.ts` failures are pre-existing on `main`; report anything else.

## Deliverable
One PR against `main` with the change and tests, and before/after screenshots at 390 × 844 and 1440 × 900 for a new expense, an existing expense and a receipt review. In the description, note anything left for a real-device check (iOS keyboard over the header input).
