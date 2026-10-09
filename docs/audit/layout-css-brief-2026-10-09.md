# Brief for Sol: even, readable layouts on phones

9 October 2026 · Base: `60b39a5` · Follows Claude's "TripTab Layout & CSS Audit" (same date)

> **Status: not implemented.** File and line references point at `60b39a5`. This brief is self-contained; you do not need the audit document. Evidence is in [`layout-css-2026-10-09/`](layout-css-2026-10-09/). Labels such as M4 or G2 are the finding IDs used in the audit document.

## What Gary asked for

> I want you to fully audit the layout and css of triptab. See if everything lines up evenly and can be clearly read. Particularly in mobile view. Some suggestions include making buttons in the same row like add expense and scan receipt spaced across the entire row. Also, pagination would be useful on panels with long lists or potential lists, for example your expenses.

The audit confirmed both suggestions and found more. This brief turns the findings into 25 fixes, in five phases, each with the files to change, the change itself and a test of when it is done.

## The problem in brief

Desktop is in good shape, and so is the expense editor on phones (it was reworked in #43–#47). The five main tabs are not. At 320–430px, rows are cramped, words break mid-word, paired buttons leave dead space, and every list renders in full. Only one sideways overflow exists (1px at 320px), so this is about alignment and readability, not breakage.

The root cause is the stylesheet. `components/expense-editor.css` uses the spacing and type tokens (`--space-*`, `--text-*`) 157 times. `app/globals.css`, which styles the tabs, uses them zero times: it has about 300 hard-coded spacing values and 23 different font sizes.

## Scope

- **In scope:** the shell (top bar, holiday drawer, page heading, stats, tab bar), the five tabs (Expenses, Balances, Receipts, Travellers, History), the right rail, and these dialogs: Record payment, traveller statement, Add a receipt, Profile & app settings.
- **Out of scope:** the expense editor (`components/expense-editor.css` and the editor markup in `trip-app.tsx` from line 2597). Reuse its patterns; do not restyle it. Also out of scope: money calculations, ledger writes, server code and the MCP tools.

## How the audit measured (reproduce this before and after)

The audit built the production Worker and drove it with Playwright, mocking `/api/**` exactly as `tests/browser/expense-layout.spec.ts` does. The fixture is in Appendix A. Use it for the new spec in Fix 17.

| Setting | Value |
| --- | --- |
| Phone viewports | 320×740, 375×667, 390×844, 430×932, all `isMobile`, `hasTouch`, 2× pixel density |
| Reference viewports | 768×1024 and 1440×900; dark mode at 390×844 |
| Fixture | 6 travellers (one named "Maximiliana Konstantinopoulou"), 24 expenses (one in four in USD), 9 payments, 6 receipt drafts, 40 activity events over 2 pages, 1 pending invite |
| Engine | Chromium only. **You must also pass WebKit**; `npm run test:layout` runs both. |

Baseline numbers you will move:

| Measure | 320px | 390px | Target |
| --- | ---: | ---: | --- |
| Receipt draft text column | 67px | 137px | ≥ 120px at 320px; no word split across lines |
| Expense title column (same-currency row) | 82px | 152px | ≥ 125px at 320px |
| Expense row height, average | 173px | 127px | ≤ 140px at 320px, ≤ 125px at 390px |
| Expense list height (24 rows) | 4,153px | 3,046px | 20 rows shown, then Show more |
| Empty space right of Add expense / Scan receipt | wraps unevenly | 53px | 0px (row filled) |
| Language preferences card padding | 0px | 0px | 20px on phones, 24px on desktop |
| Right rail height below every tab | — | 839px | Hidden on phones |
| Travellers tab height | 6,321px | 5,960px | Fix 21 reduces it |
| Expense date line contrast | 2.79:1 | 2.79:1 | ≥ 4.5:1 |

The "After" images in the evidence folder came from injecting [`preview.css`](layout-css-2026-10-09/preview.css) into the running app. With it, the title column went from 82px to 131px at 320px, the draft text column from 67px to 132px, and the buttons to 173px each at 390px.

## Ground rules for every phase

1. **Use the tokens.** Write new or edited rules with `--space-1`…`--space-6` (4–32px), `--text-xs`…`--text-xl` and `--radius-s`/`--radius-m` (`globals.css:27-40`). Two values are deliberately not tokens: 20px panel padding on phones (Fix 22 adds `--panel-padding`) and 44px tap targets.
2. **Reuse the existing breakpoints.** Use 700px for the phone layout, 480px for narrow phones and 359px for "stack pairs". The editor already stacks pairs at 359px (`expense-editor.css:1311-1316`). Do not add new widths.
3. **Never hide overflow to pass a test.** The layout suite asserts that containers do not clip (`expense-layout.spec.ts`, the `clipping` checks). Fix the layout instead.
4. **Keep tap targets at 44×44px or larger**, and keep text in overlays at 16px or more so iOS does not zoom (`globals.css:2015-2023`).
5. **Do not add hard-coded colours.** Use `var(--surface)`, `var(--muted)`, `var(--line)` and the other variables, so dark mode needs no override. Check every change in both themes.
6. **Keep accessible names.** Tests find buttons by role and name: `Add expense`, `Scan receipt`, `Add receipt`, `Record payment`, `Record paid`, `Review`, `Remove draft`, `Open holidays`, `View statement`, `Load older changes`. Keep those names.
7. **Do not call hooks inside `renderSection`.** It is a plain function called from `TripTabSection`'s render (`components/trip-routing.tsx:20-22`), and the section it renders changes with the route. Keep new state in `Home` (`trip-app.tsx:223`), which persists across tab changes.
8. **One phase per PR.** Each PR must pass the checks in "Run before pushing".

## Implementation plan

Write the Fix 17 spec first. It fails on base and should go green phase by phase.

### Phase 1: CSS-only quick wins (Fixes 1–5)

These clear the worst readability problems. All are CSS, apart from one class name (Fix 4) and one `aria-hidden` (Fix 5).

#### Fix 1. Receipt inbox rows break words (high)

**Finding.** At 320px each draft's text column is 67px, so words split: "Restaura / nte", "Continen / te", "processe / d yet". It is 137px at 390px. The row is one flex line (`globals.css:739-761`) holding the 52px thumbnail (`.draft-visual`, `expense-icon.css:34-37`), the text, the Review button and the 44px remove button (`globals.css:2856-2860`). `.draft > div { overflow-wrap: anywhere }` (`globals.css:754-758`) allows a split at any letter. See `03-receipt-rows.png`.

**Markup** (`trip-app.tsx:1724-1771`, unchanged): `div.draft` > `div.draft-visual`, `div` (title and status), `button.quiet` Review, `button.iconbutton` Remove draft.

**Change.** In `globals.css`, replace the `.draft` rules inside `@media (max-width: 700px)` (`1302-1312`) with:

```css
@media (max-width: 480px) {
  .draft {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr) 44px;
    grid-template-areas: "visual text remove" "visual review review";
    column-gap: var(--space-3);
    row-gap: var(--space-2);
    align-items: start;
    padding: var(--space-4);
  }
  .draft > .draft-visual { grid-area: visual; }
  .draft > div:not(.draft-visual) { grid-area: text; }
  .draft > .quiet { grid-area: review; width: 100%; }
  .draft > .iconbutton { grid-area: remove; justify-self: end; }
}
```

At all widths, change `.draft > div` to `overflow-wrap: break-word`. That splits only a word too long for the whole line. Delete `.draft .iconbutton { min-width: 30px }` (`1310-1312`): it is already overridden by `2856-2860`.

**Done when.** At 320px, no word in a draft title or status spans two lines (the Fix 17 word-split check). The text column is at least 120px. Review is at least 44px tall and spans the text and remove columns. Remove draft is 44×44. Above 480px the row is unchanged.

#### Fix 2. The language preferences card has no padding (high)

**Finding.** `PersonalLanguageSettings` renders `section.panel.personal-language-settings` (`components/trip-language-preferences.tsx:82-98`). `.panel` has no padding (`globals.css:493-498`). Its neighbours add their own (`.sharing-panel`, `globals.css:1815-1818`; `.trip-details-panel`, `2632-2637`), but this card only gets `margin-top: 20px` (`components/receipt-languages.css:27`). The heading, description and both selects sit on the card's border, in light and dark mode. The description also runs straight into the first label. See `04-language-panel.png`.

**Change** in `components/receipt-languages.css`:

```css
.personal-language-settings { margin-top: 22px; padding: var(--space-5); }
.personal-language-settings > .footnote { margin-bottom: var(--space-4); }
@media (max-width: 700px) { .personal-language-settings { padding: 20px; } }
```

Fix 22 later replaces these literals with `--panel-padding`.

**Done when.** Computed padding is 24px above 700px and 20px at or below. The card's heading starts at the same x as the "Holiday details" heading in the card above it (±1px).

#### Fix 3. Add expense and Scan receipt don't fill their row (Gary's suggestion)

**Finding.** The buttons keep their natural widths (147px and 146px) on phones. That leaves 38px empty at 375px, 53px at 390px and 93px at 430px. At 320px they wrap onto two rows, both left-aligned. The rule that once made the primary button full-width, `.page-heading > .primary` (`globals.css:1196-1199`), stopped matching when the buttons moved into `div.expense-entry-actions` (`trip-app.tsx:2226-2241`). That also removed the margin above them, so "Refreshed 08:00" now touches the buttons (0px gap). See `01-action-row.png`.

**Change.** Delete `globals.css:1196-1199`. In `components/expense-editor.css`, after the existing `.expense-entry-actions` rules (`1135-1142`), add:

```css
@media (max-width: 700px) {
  .page-heading .expense-entry-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-top: var(--space-4);
  }
  .page-heading .expense-entry-actions button {
    width: 100%;
    padding-inline: var(--space-3);
    white-space: nowrap;
  }
}
@media (max-width: 359px) {
  .page-heading .expense-entry-actions { grid-template-columns: minmax(0, 1fr); }
}
```

The third child is the hidden file input (`hidden` attribute). Tailwind's preflight gives `[hidden]` `display: none !important`, so it takes no grid cell. Two equal columns at 320px wrapped "Add expense" onto two lines inside its button, which is why pairs stack below 360px.

**Done when.** From 360px to 700px, both buttons have equal width (±1px), and together they span the row: the first button's left edge matches the heading's left edge, and the last button's right edge matches the stats grid's right edge. Below 360px they stack, each full width. The gap from "Refreshed" to the buttons is 16px. Above 700px nothing changes. The preview gave 173px each at 390px, 193px at 430px and 284px stacked at 320px.

#### Fix 4. The top-bar status wraps and overflows (M1)

**Finding.** `<small className="muted">Updates automatically</small>` (`trip-app.tsx:2173`) wraps to two lines at every phone width. At 320px it runs 1px past the right edge, the only page overflow found. It repeats the "Refreshed 08:00" line under the title.

**Change.** Give the element `className="muted topbar-status"`. In `globals.css`, inside the `@media (max-width: 700px)` block at `1921`, add `.topbar-status { display: none; }`.

**Done when.** At 320–700px the top bar is one line high, and `document.documentElement.scrollWidth === clientWidth` on every tab. Above 700px the status still shows.

#### Fix 5. Secondary text fails contrast (G2)

**Finding.** WCAG AA needs 4.5:1 for normal text and 3:1 for icons. These colours fail on white or on `--bg`:

| `globals.css` line | Selector | Colour now | Contrast | Change |
| --- | --- | --- | ---: | --- |
| 542 | `.expense-details small` (date line on every expense) | `#929bb0` | 2.79:1 | `var(--muted)` |
| 807 | `footer` | `#8d96ab` | 2.77:1 | `var(--muted)` |
| 163 | `.side-label` ("YOUR HOLIDAYS") | `#8790a5` | 3.2:1 | `var(--muted)` |
| 425 | `.stat > span svg` | `#929bb3` | 2.78:1 | `var(--muted)` |
| 645 | `.empty > svg` | `#8d98c2` | 2.84:1 | `var(--muted)` |
| 330 | `.breadcrumb span` (the "/" separator) | `#b3bacb` | 1.94:1 | Leave it; mark the separator `aria-hidden="true"` |

`--muted` is `#68718a`: 4.86:1 on white and 4.54:1 on `--bg`. In dark mode it is already used for these selectors (`globals.css:2130-2136`). Once the light values use the variable, remove `.side-label`, `.stat > span svg`, `.expense-details small` and `footer` from that dark-mode list. `--faint` (`globals.css:22`, dark `2109`) is defined but never used; delete it.

**Done when.** The Fix 17 contrast check passes on all five tabs, in both themes.

### Phase 2: Rows that read cleanly (Fixes 6, 8, 9, 12)

#### Fix 6. Expense rows are cramped (high)

**Finding.** Each row is `div.expense` > `ExpenseIconPicker` + `button.expense-open` > `span.expense-details` (title `b`, payer `span`, date `small`) + `span.expense-amount` (amount `b`, then a `small` that reads "Edit split" or "US$13.61 original", then a `small` "Your share €3.00") (`trip-app.tsx:1572-1616`). `.expense-open` is a flex row (`expense-icon.css:5`). The amount column is 98px wide because it stacks three lines. That leaves the title 82px at 320px, so "Dinner by the harbour" takes three lines and rows average 173px (the tallest is 270px). "Edit split" repeats on every same-currency row, though the whole row is already the edit button. See `02-expense-rows.png`.

**Markup change** (`trip-app.tsx:1608-1613`). Give the two `small` elements their own classes:

```tsx
{e.currency !== trip.currency
  ? <small className="expense-original">{money(total(e), e.currency) + " original"}</small>
  : <small className="expense-edit-hint">Edit split</small>}
{currentMemberIndex >= 0 && <small className="expense-share">Your share …</small>}
```

**CSS** in `globals.css` (replacing the `.expense*` rules in the ≤700px block where they conflict, `1259-1278`):

```css
@media (max-width: 480px) {
  .expense { padding: 14px 15px; align-items: start; }
  .expense-open {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: var(--space-3);
    row-gap: 2px;
    align-items: baseline;
  }
  .expense-details, .expense-amount { display: contents; }
  .expense-details b { grid-column: 1; grid-row: 1; }
  .expense-amount b { grid-column: 2; grid-row: 1; text-align: right; }
  .expense-details > span { grid-column: 1; grid-row: 2; margin: 2px 0 0; }
  .expense-original { grid-column: 2; grid-row: 2; margin-top: 0; text-align: right; }
  .expense-details small { grid-column: 1 / -1; grid-row: 3; }
  .expense-share { grid-column: 1 / -1; grid-row: 4; margin-top: 2px; text-align: left; }
  .expense-edit-hint { display: none; }
}
```

The result on a phone:

```
[icon]  Dinner by the harbour            €24.00
        Alex paid · 2 items
        28 Jul 2026 · 09:00 · Paid · AI assisted
        Your share €3.00
```

`display: contents` applies only to the two spans; never to the button. **Check WebKit** with a grid on a `<button>` that has `display: contents` children. If it misbehaves, wrap the button's content in a `<span className="expense-row">` and make that span the grid instead.

**Done when.** At 320px, a same-currency row's title column is at least 125px, and with the Appendix A fixture rows average 140px or less (125px or less at 390px). "Edit split" is hidden at or below 480px and visible above. The row is still one button plus the icon picker (two tab stops). Desktop is unchanged. The preview gave a 131px title at 320px and 201px at 390px.

#### Fix 8. The right rail is out of reach on phones (M5)

**Finding.** Below 700px, the rail (`aside.right-rail`, `trip-app.tsx:2342-2403`) stacks under every tab. It holds the group balance card (533px at 390px) and the "Snap it. Check it. Split it." card (290px): 839px in all. On Expenses it starts 3,538px down at 390px (4,715px at 320px). Its Upload receipt button repeats Scan receipt.

**Change.**

1. In `Home`, build the balance card JSX once (`2343-2382`) as `const groupBalance = (inline: boolean) => …`. Render `groupBalance(false)` in the rail as now.
2. At the top of the `"balances"` case (`1632`), render `groupBalance(true)`. Give it the extra class `balance-card--inline`, and leave out its "View settlements" button, since you are already on that tab.
3. CSS:

```css
.balance-card--inline { display: none; }
@media (max-width: 700px) {
  .right-rail { display: none; }
  .balance-card--inline { display: block; margin-bottom: var(--space-5); }
}
```

Then delete the rail's ≤700px rules that no longer apply (`globals.css:1243-1258`).

**Done when.** At or below 700px, no `.right-rail` is visible on any tab, Balances shows the group balance above "Settle up", and the Expenses page is about 839px shorter. Above 700px nothing changes.

#### Fix 9. Statement links lose alignment (M6)

**Finding.** `.statement-link` (`globals.css:1490-1516`; markup `trip-app.tsx:1673`) is a wrapping flex row. When a name wraps ("Maximiliana Konstantinopoulou"), "View statement" drops to the left under it, while every other row right-aligns it. See `05-statements-travellers-downloads.png`.

**Change.** Replace `display: flex; flex-wrap: wrap; justify-content: space-between;` with `display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--space-4);`. Add `white-space: nowrap` to `.statement-link > span:last-child`.

**Done when.** At 320–430px, the right edge of "View statement" is identical (±1px) on every row, including the long name.

#### Fix 12. Traveller rows break emails mid-word (M11)

**Finding.** In `trip-app.tsx:1805-1820`, `.member-account` is capped at 46% width with `overflow-wrap: anywhere` (`globals.css:1841-1851`, `1984-1987`). So "sam.longer-address@example.invalid" ends "…invali / d". "Invite to join" is green, the success colour, but is not tappable.

**Change.** Use this markup:

```tsx
<div className="member" key={m.id}>
  <span className={"avatar color" + (i % 5)}>…</span>
  <span className="member-identity">
    <b>{m.name}</b>
    {m.email && <small>{m.email}</small>}
  </span>
  <span className={"member-status" + (m.userId ? " connected" : "")}>{m.userId ? "Account connected" : "Not linked"}</span>
</div>
```

```css
.member { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; column-gap: var(--space-3); }
.member-identity { min-width: 0; }
.member-identity b { display: block; font-size: var(--text-s); overflow-wrap: break-word; }
.member-identity small { color: var(--muted); overflow-wrap: anywhere; }
.member-status { font-size: var(--text-xs); color: var(--muted); white-space: nowrap; }
.member-status.connected { color: var(--green); }
@media (max-width: 480px) {
  .member { grid-template-columns: 34px minmax(0, 1fr); align-items: start; }
  .member-status { grid-column: 2; }
}
```

Delete `.member b` (`775-778`, `1994-1996`), `.member-account` and its `small` (`1841-1851`, `1984-1987`), `.member .muted` (`1313-1315`) and `.member { align-items: flex-start }` (`1981-1983`).

Optional, only if it stays small: make "Not linked" a text button, "Invite", that scrolls to the Invite a traveller card (`trip-sharing.tsx:96`) and focuses its "Invite as" select. Skip it if that needs new props threaded through `TripSharing`.

**Done when.** At 390px, a 34-character email sits on one line. At 320px, names never split mid-word (an email may still split, since it is one long token). The status sits under the email at or below 480px, and right-aligned and centred above.

### Phase 3: Long lists (Fixes 7, 10, 11, 16)

#### Fix 7. Pagination with "Show more" (Gary's suggestion)

**Finding.** Only History is paged (20 per request, `activity-panel.tsx:462`). Everything else renders in full, while the schema allows 1,000 expenses, 1,000 payments and 100 drafts (`lib/model.ts:320-321`):

| List | Where | Measured at 390px | Page size |
| --- | --- | --- | ---: |
| Your expenses | `trip-app.tsx:1572` | 24 rows, 3,046px | 20 |
| Statement expenses | `member-statement.tsx:73-74` | 24 entries, 4,540px inside the dialog | 10 |
| Statement payments | `member-statement.tsx:92-93` | 5 entries, 433px | 10 |
| Recorded payments | `trip-app.tsx:1679` | 9 rows, 1,470px | 5 |
| Receipt inbox | `trip-app.tsx:1723` | 6 drafts, 655px | 10 |
| Activity | `activity-panel.tsx:453-462` | 20 events, 2,951px | Keep server paging (Fix 16 restyles it) |

The whole ledger is already in the browser, so this is a rendering change only, with no API work.

**Pattern.** A "Show more" button adds the next page in place. Do not use numbered pages: Show more keeps the scroll position, gives one large tap target, and matches Load older changes.

**Implementation.**

1. **New `components/paged-list.tsx`** exporting a footer component:

   ```tsx
   export function ShowMore({ shown, total, step, noun, onMore }: {
     shown: number; total: number; step: number; noun: string; onMore: () => void;
   }) {
     if (shown >= total) return null;
     return <div className="list-more">
       <p className="muted" aria-live="polite">Showing {shown} of {total} {noun}</p>
       <button type="button" className="quiet" onClick={onMore}>Show {Math.min(step, total - shown)} more</button>
     </div>;
   }
   ```

2. **State lives in `Home`** (rule 7). Use one map, so counts survive tab switches and each holiday starts fresh:

   ```tsx
   const [shownCounts, setShownCounts] = useState<Record<string, number>>({});
   const shownCount = (key: string, step: number) => shownCounts[key] ?? step;
   const showMore = (key: string, step: number) => setShownCounts(c => ({ ...c, [key]: (c[key] ?? step) + step }));
   ```

   Keys are `${trip.id}:expenses`, `${trip.id}:payments` and `${trip.id}:drafts`. `MemberStatement` is its own component, mounted per open, so a local `useState` per section is fine there.

3. **Render** `list.slice(0, shownCount(key, step))`. Put `<ShowMore>` inside the list's `.panel`, after the last row, so it reads as part of the list.

4. **Order, so a new entry is never hidden.** Expenses are already newest first (`trip-app.tsx:1254` prepends). Payments (`1371`) and drafts (`912`, `1176`) are appended, so a new one would land beyond page one. Render both reversed: `[...trip.payments].reverse()` and `[...trip.drafts].reverse()`. Do not change the stored order. Add "Newest first" to the Recorded payments and Receipt inbox headings, as Expenses has (`trip-app.tsx:1568`).

5. **Focus.** After Show more, move focus to the first newly revealed row's main control (`.expense-open`, a draft's Review button, a payment's Edit button). Store the previous count in a ref, and focus in a `useEffect` after the new rows render.

6. **CSS** in `globals.css`:

   ```css
   .list-more { display: grid; gap: var(--space-2); justify-items: center; padding: var(--space-4); border-top: 1px solid var(--line); text-align: center; }
   .list-more .muted { margin: 0; }
   @media (max-width: 700px) { .list-more { justify-items: stretch; } }
   ```

**Not in this fix:** search, filters, server paging, and date headers on Expenses (see Open question).

**Done when.** With the Appendix A fixture:

- Expenses shows 20 rows, "Showing 20 of 24 expenses" and "Show 4 more". Pressing it shows 24 rows, hides the footer and focuses row 21.
- Switching to Balances and back still shows 24 rows. Switching holiday resets to 20.
- A newly saved expense, payment or draft appears first.
- Recorded payments shows 5 of 9, and Receipts shows all 6 with no footer.
- The statement dialog shows 10 of 24 expenses.

#### Fix 10. Payment rows take three lines and show raw dates (M7)

**Finding.** Each row (`trip-app.tsx:1679-1705`) puts "Jordan paid Alex", the raw ISO date `2026-07-10` and the method on separate lines. On phones it adds a second grid row for the amount and buttons (`globals.css:1700-1722`), so rows are 163px each. See `06-payments-history.png`.

**Change.** Use this markup (the class `payment-actions` is already taken by the payment dialog, `globals.css:1481`):

```tsx
<div className="payment" key={p.id}>
  <span className="payment-summary">{name(p.from)} paid {name(p.to)}</span>
  <b className="payment-amount">{money(p.amount, trip.currency)}</b>
  <small className="payment-meta">{formatCalendarDate(p.date)}{p.time ? ` · ${p.time}` : ""}{p.method ? ` · ${p.method}` : ""}</small>
  <span className="payment-row-actions">{/* Edit, Undo recorded payment: unchanged */}</span>
  {p.note && <small className="payment-note">{p.note}</small>}
</div>
```

```css
.payment {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "summary amount" "meta actions" "note note";
  column-gap: var(--space-3);
  row-gap: var(--space-1);
  align-items: center;
}
.payment-summary { grid-area: summary; overflow-wrap: break-word; }
.payment-amount { grid-area: amount; text-align: right; font-variant-numeric: tabular-nums; }
.payment-meta { grid-area: meta; color: var(--muted); }
.payment-row-actions { grid-area: actions; display: flex; gap: var(--space-2); justify-content: flex-end; }
.payment-note { grid-area: note; color: var(--muted); overflow-wrap: break-word; }
```

Delete the old `.payment` rules (`724-738`, `1517-1520`) and the ≤480px block (`1700-1722`).

**Done when.** At 390px a row without a note is at most 110px. Dates read "10 Jul 2026". The order is newest first (Fix 7).

#### Fix 11. One date format (G3)

**Finding.** Dates are formatted in seven places, three different ways:

| Where | Output |
| --- | --- |
| `trip-app.tsx:94-98` (`expenseDate`), `member-statement.tsx:14-17` (`displayDate`) | "28 Jul 2026" (en-GB), duplicated |
| `trip-app.tsx:1683` (payments) | Raw `2026-07-10` |
| `activity-panel.tsx:169-174` (`auditTimestamp`, not exact), `account-activity-panel.tsx:47`, `restoration-notice.tsx:7` | Device locale, `timeStyle: "long"`: seconds and a zone name, e.g. "28 Jul 2026, 18:00:00 BST", and US order on en-US devices |
| `trip-sharing.tsx:124`, `receipt-chat.tsx:32` | Device locale, short time |

**Change.** Add two helpers to `lib/dates.ts` and use them everywhere above:

```ts
const calendarFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** "28 Jul 2026" for a stored YYYY-MM-DD calendar date. */
export function formatCalendarDate(value: string): string {
  return validCalendarDate(value) ? calendarFormat.format(new Date(`${value}T00:00:00Z`)) : 'Invalid date';
}
const instantFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** "28 Jul 2026, 18:00" for an instant, in the viewer's own time zone. */
export function formatInstant(value: string | Date): string { /* invalid → 'Date unavailable' */ }
```

Keep `auditTimestamp(value, true)`, the exact ISO form, unchanged. Activity details and exports rely on it.

**Done when.** No component calls `toLocaleString` or `toLocaleDateString` for display, apart from the vendored `components/ui/*`. Unit tests in `tests/` cover both helpers, including invalid input.

#### Fix 16. History heading, spacing and paging button (G5, M15)

**Finding.** The holiday Activity section (`activity-panel.tsx:445-463`) is the only tab without `.sectionheading`. It stacks `margin-top: 24px` and `padding-top: 24px` with an orphan `border-top` (`globals.css:1563-1569`), plus `.subheading`'s `margin-top: 28px` (`721-723`). That is 76px above "Activity". Events sit directly on the page background, not in a card. "Load older changes" is a small left-aligned button.

**Change.** Change only the holiday-wide variant (`!scope`). The receipt-history variant (`.receipt-activity`) inside the editor stays as it is.

- Use the same heading markup as the other tabs: `div.sectionheading` > `h2` + `span.muted` ("Updates automatically").
- Remove the top margin, padding and border for `.activity-panel:not(.receipt-activity)`.
- Put the event list in a `.panel` with `padding: 0 var(--panel-padding)`. The last event has no bottom border.
- Group events under day headings: an `h3` with the date of `createdAt` in the viewer's time zone (add a `formatDay` helper beside Fix 11's, e.g. "Tue 28 Jul 2026"). Show only the time ("18:00") on each event row. Keep `li.activity-event` (tests use it).
- On phones, make "Load older changes" full width (Fix 13's `.phone-wide`).

**Done when.** "Activity" starts at the same y as "Your expenses" does on the Expenses tab (±2px). Events sit in a card under day headings. Load older changes still loads page 2.

### Phase 4: Button rows and dialogs (Fixes 13, 14, 15, 18, 19, 20)

#### Fix 13. One shared button-row pattern

**Rule for phones.** Two related actions split the row into equal halves. A single main action is full-width. Below 360px, pairs stack.

**Add to `globals.css`:**

```css
.button-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.button-row > :is(button, a) { min-height: 44px; min-width: 0; max-width: 100%; white-space: normal; }
@media (max-width: 700px) {
  .button-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .button-row > :is(button, a) { width: 100%; }
  .button-row > :last-child:nth-child(odd) { grid-column: 1 / -1; }
  .phone-wide { width: 100%; }
}
@media (max-width: 359px) { .button-row { grid-template-columns: minmax(0, 1fr); } }
```

**Apply it to these rows:**

| Row | File | Change |
| --- | --- | --- |
| Download buttons (2 rows) | `data-export.tsx:73`, `:91` | Add `button-row` beside `data-export-actions`. Delete `data-export.css:8-12`. |
| Create invite link | `trip-sharing.tsx:106` | `phone-wide` |
| Replace link · Revoke | `trip-sharing.tsx:~127` | Already a 2-column grid (`globals.css:2848-2852`); switch it to `button-row` and delete that rule |
| Save holiday details | `trip-details.tsx:114-117` | Make it `primary` and `phone-wide`. Move the "saved" `<p>` out of the row, below it. |
| Load older changes | `activity-panel.tsx:462` | `phone-wide` |

**Done when.** On the Travellers tab at 390px, every button in a `.button-row` is exactly the width of its grid column, and a single button is full width. Above 700px the buttons look as they do today.

#### Fix 14. Six disabled Save buttons under display names (M12)

**Finding.** Each traveller has its own form and its own Save button (`trip-details.tsx:30-62`, button at `61`). The button is disabled until that name changes, so the card shows six greyed-out buttons, about 60px each.

**Change (recommended, small).** Render Save only when `value.trim() !== member.name`, while `submitting`, or while an error is showing. Pressing Enter still submits. Keep the per-row forms, validation and messages exactly as they are. Do **not** merge them into one Save: that would change duplicate-name checking and error handling, and Gary hasn't asked for it.

**Done when.** With no edits, the card shows no Save buttons. Typing in one name shows one Save button for that row. Saving works as before.

#### Fix 15. Record payment: Save is below the fold (M16)

**Finding.** The payment dialog (`payment-editor.tsx:88-182`) has nine single-column fields on phones: `.payment-editor .fieldpair` collapses at 480px (`globals.css:1676`). "Review payment" sits below the fold and does not stick, unlike the expense editor's footer.

**Change.**

1. Make `.payment-editor .payment-actions` stick to the bottom of the scrolling `.modal`:

   ```css
   .payment-editor .payment-actions {
     position: sticky; bottom: 0; z-index: 1;
     margin: var(--space-5) -28px 0; padding: var(--space-3) 28px;
     background: var(--surface); border-top: 1px solid var(--line);
   }
   @media (max-width: 700px) { .payment-editor .payment-actions { margin-inline: -22px; padding-inline: 22px; } }
   .payment-editor { scroll-padding-bottom: 96px; }
   ```

   The negative margins match `.modal`'s padding (`globals.css:923`, `1320`).

2. Keep Date and Time side by side down to 360px. Add `fieldpair--keep` to that pair (`payment-editor.tsx:159`), then add a global rule: `@media (max-width: 480px) { .fieldpair.fieldpair--keep { grid-template-columns: repeat(2, minmax(0, 1fr)); } }` and stack it below 360px. Leave Paid by / Paid to stacked, since long names truncate in a half-width select.

**Done when.** At 390×844 the main button is visible without scrolling, in both the details and review steps. A focused field is never hidden behind the footer (mirror the editor test, `quick-expense.spec.ts` "a focused field is never left behind the pinned footer"). The keyboard tests on `/balances` in `expense-layout.spec.ts` still pass.

#### Fix 18. Add a receipt: capture buttons stack early; "optional" wraps (M17)

**Finding.** In the inbox dialog, Scan receipt and Choose image (`receipt-upload-dialog.tsx:52`) stack below 480px (`globals.css:2349-2354`). The editor keeps the same pair side by side down to 360px (`expense-editor.css:462-464`, `1311-1316`). Under "Receipt location" (`receipt-upload-dialog.tsx:51`), the `<small>optional</small>` drops to its own line because of the global `small { display: block }` (`globals.css:117-121`).

**Change.** Replace `globals.css:2349-2354` with a 359px rule that stacks `.receipt-capture-inputs`. Add `.receipt-upload-place summary small { display: inline; margin-left: var(--space-1); }` to `receipt-upload.css`.

**Done when.** At 390px both dialogs show the pair side by side, and at 320px both stack. "Receipt location optional" is on one line. `expense-progressive.spec.ts` "the inbox and the editor offer the same capture actions and wording" still passes.

#### Fix 19. The holiday drawer has no backdrop (M18)

**Finding.** When the drawer opens below 900px (`trip-app.tsx:2070-2146`, `menu` state), the page beside it stays bright and looks tappable.

**Change.** After `</aside>`, render `{menu && <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setMenu(false)} />}`.

```css
.sidebar-backdrop { display: none; }
@media (max-width: 900px) {
  .sidebar-backdrop { display: block; position: fixed; inset: 0; z-index: 35; background: #19213f70; }
  .sidebar.visible { z-index: 40; }
}
@media (prefers-color-scheme: dark) { .sidebar-backdrop { background: #040812b8; } }
```

The z-order is: topbar 25, tab bar 30, backdrop 35, drawer 40, dialogs 50. The colours match `.overlay` (`globals.css:888`, `2238`).

**Done when.** Tapping the backdrop closes the drawer, and the tab bar is dimmed under it. `sidebar-assistant.spec.ts` still passes.

#### Fix 20. Main actions in dialogs on phones (M19)

**Finding.** Create holiday uses a full-width primary button (`.primary.wide`, `trip-app.tsx:2525`). Profile & app settings uses small left-aligned secondary buttons: "Save profile" (`account-panel.tsx:141`) and "Add password" (`account-panel.tsx:235`).

**Change.** Add `phone-wide` (Fix 13) to those two buttons. Leave the other account buttons (unlink, sign out, links) as they are.

**Done when.** At 390px, Save profile and Add password are full width.

### Phase 5: Structure and cleanup (Fixes 21–25)

#### Fix 21. Shorten the Travellers tab (M14). Check with Gary before starting.

**Finding.** The tab is 5,960px at 390px. Measured section heights: Holiday details with display names 2,126px, Invite 824px, Travellers 567px, Download 517px, Language 284px.

**Proposal.** Keep the travellers list and Invite open. Make each of the following its own card, as a `<details>` that is closed by default, with the card heading as the `<summary>`:

- Holiday details
- Traveller display names (split out of the Holiday details card)
- Your receipt language preferences
- Download your data

Open a section automatically while it shows an error, a success message or unsaved edits. Reuse the editor's chevron (`expense-editor.css:822-829`). This is a UX change, so confirm it with Gary first.

#### Fix 22. One padded card pattern (G4)

**Finding.** Card padding is set per component, and at different breakpoints: `.sharing-panel` is 24px, or 20px at or below 700px (`globals.css:1815`, `1977-1980`). `.trip-details-panel` is 24px, or 20px at or below 480px (`2632-2637`, `2831-2834`). The language card had none (Fix 2). "Download your data" is not a card at all: it is an open section with a top rule (`.account-section`, `2581-2588`).

**Change.** Add `--panel-padding: 24px` to `:root` and set it to 20px at or below 700px. Use it in all of these cards. When `DataExport` is `compact` (on the Travellers tab), render it as a `.panel` card. In the account dialog it stays an `.account-section`.

#### Fix 23. The desktop rail doesn't line up (G7)

**Finding.** At 768px and 1440px, the group balance card starts 42px above the expense list (y 513 vs 556, and 530 vs 572). The list has a `.sectionheading` above it; the rail's heading is inside its card. Heading heights also vary by tab: a heading with a 44px button is taller than one with muted text.

**Change.** Give `.sectionheading` `min-height: 44px` (`globals.css:482-488`). Move "The group balance" and its icon out of the card into a `.sectionheading` above it.

**Done when.** The rail heading and the section heading share the same top and height on every tab. On Expenses and Receipts, the rail card and the list card start at the same y (±1px).

#### Fix 24. Remove dead CSS (G6, G8)

Make these deletions, each verified with `grep` in `components/` and `app/` before removing:

| Lines in `globals.css` | What | Why it is dead |
| --- | --- | --- |
| 984, 1045, 1088, 1337, 1348, 1735, 1754, 2349 (preceding runs), 1324-1336, 2243-2245, 2271, 2280-2283, 2335-2348, 2887-2892 | 145 blank lines in runs of up to 33 | Left over from earlier removals |
| 2871-2877 | Empty `@media (max-width: 480px)` | Has no rules |
| 1183-1188 | `.topbar .quiet` and its `span` | The top bar has no `.quiet` |
| 747-753 | `.draft > img` | The image is now inside `.draft-visual` |
| 788-803, 1348-1353, and `.settingspanel` in 1977 | `.settingspanel` | No markup uses it |
| 632-637, 1754-1772, and `label.upload-label` in 66 and 2221 | `.upload-label` | No markup uses it |
| 2861-2866 | `.textbutton` declared twice | Merge into one rule |

Also:

- Replace the 8 hard-coded `background: #fff` declarations (`129`, `198`, `312`, `382`, `411`, `494`, `921`, `1938`) with `var(--surface)`, and drop the dark-mode overrides that only existed to undo them (`2119-2126`).
- Merge the three `.tabs` blocks for ≤700px (`1225-1237`, `1932-1970`, `2028-2030`) into one.
- Merge the two `.topbar` blocks for ≤700px (`1165-1188`, `1922-1928`) into one.

**Done when.** Screenshots of all five tabs at 390px and 1440px, in both themes, are pixel-identical before and after this fix alone. Run Fix 24 as a separate commit so the diff is reviewable.

#### Fix 25. Move `globals.css` onto the tokens (G1)

Collapse the 23 font sizes (0.65rem to 1.9rem) to the scale: 0.75, 0.875, 1, 1.25, 1.5, and 2rem for the page title. Add `--text-2xl: 2rem`. Replace raw spacing with `--space-*`, rounding to the nearest token; where a value sits between two tokens (18px, 22px), pick by eye at 390px and 1440px. Do it component by component, one commit each, with a screenshot pair per commit. This is the largest fix and the least urgent. Do it last, and do not mix it with behaviour changes.

## Fix 17: the layout spec to write first

Create `tests/browser/main-layout.spec.ts`, using the Appendix A fixture and `fixtures()` routing. Run it at 320×740, 375×667, 390×844 and 430×932 (touch), plus 768×1024 and 1440×900. Repeat the checks marked † in dark mode at 390px. Playwright already runs both Chromium and WebKit.

| # | Assertion | Covers |
| --- | --- | --- |
| 1 | On each tab, `scrollWidth <= clientWidth` for the document † | Fix 4 |
| 2 | **No word split across lines** in `.expense-details b`, `.draft` text, `.member-identity b`, `.statement-link > span:first-child`, `.payment-summary`. For each word (split on whitespace; skip tokens over 24 characters and emails), create a `Range` over it; `getClientRects()` must return exactly 1 rect † | Fixes 1, 6, 10, 12 |
| 3 | `.expense-entry-actions` from 360px to 700px: buttons equal width (±1px), spanning the row edge to edge; below 360px stacked, each full width; above 700px natural width | Fix 3 |
| 4 | Every `.button-row` child at or below 700px equals its column width; a lone child is full width | Fix 13 |
| 5 | `.personal-language-settings`, `.sharing-panel` and `.trip-details-panel` have `padding-left` of at least 20px, and their headings share one x (±1px) | Fixes 2, 22 |
| 6 | "View statement" right edges are equal (±1px) on all rows | Fix 9 |
| 7 | **Contrast:** for every visible text element in `main`, `.tabs` and `.topbar`, the contrast of its colour against the nearest opaque ancestor background is at least 4.5:1 (3:1 for 24px+, or 18.66px+ bold) † | Fix 5 |
| 8 | All visible buttons, links and summaries on the five tabs are at least 44×44px | Ground rule 4 |
| 9 | Pagination: the "Done when" list in Fix 7 | Fix 7 |
| 10 | At or below 700px, `.right-rail` is hidden and Balances shows `.balance-card--inline`; above 700px the reverse | Fix 8 |
| 11 | At 320px, the draft text column is at least 120px and the expense title column at least 125px; average expense row height at most 140px | Fixes 1, 6 |
| 12 | The drawer backdrop closes the drawer | Fix 19 |

Measure, don't screenshot-compare: the existing specs measure geometry, and so should this one.

## Rules that must not regress

- Money and splits: no change to `lib/model.ts`, the calculations, or any value displayed apart from formatting.
- One tap on an expense row opens that expense. The icon picker stays its own control.
- The existing layout specs pass unchanged, in Chromium and WebKit: `expense-layout.spec.ts` (no clipping, one scroll area, 44px targets, keyboard), `quick-expense.spec.ts`, `expense-confirmation.spec.ts`, `expense-progressive.spec.ts`, `receipt-upload.spec.ts` (`.draft-visual .expense-icon-trigger` at line 125) and `sidebar-assistant.spec.ts`.
- Dark mode has no light-only colours. `expense-progressive.spec.ts` checks receipt borders in dark mode; extend the same idea to the new spec's † checks.
- iOS: fields in overlays stay at 16px or more; the iOS keyboard handling (`visual-viewport.ts`, `html[data-keyboard-open]`) is untouched.
- Stored data order never changes. Reversed lists (Fix 7) are reversed at render time only.

## Decisions taken in this brief (Gary can overrule)

- Payments and receipt drafts render newest first, to match Expenses, so paging never hides a new entry.
- Display names keep per-row saving; Save simply hides until it is needed (Fix 14).
- Phones lose the "Snap it. Check it. Split it." card (Fix 8): Scan receipt and the Receipts tab already cover it.

## Open question for Gary (do not act on it)

"Newest first" on Expenses means newest *entered*, not newest transaction date. Date headings on Expenses only make sense if it is sorted by transaction date. Keep the current order, and add no date headings to Expenses until Gary answers. History's day headings (Fix 16) are unaffected, because events are already in time order.

## Run before pushing

`npx tsc --noEmit`, `npm run lint`, `npm test`, then build with a local `RECEIPT_AI_OWNER_EMAIL` and run `npm run test:layout`, which runs Chromium and WebKit (see README, "Local development"). Check a real iPhone in Safari for Fixes 3, 6 and 15 before marking the brief implemented. If a test fails, check it against base `60b39a5` before treating the failure as yours.

## Appendix A: audit fixture

This is the data behind every number above. Route `/api/**` as in `tests/browser/expense-layout.spec.ts:28-44`, returning this trip from `/api/ledger`, a profile with `id: 'audit-owner'`, and the activity pages below. Unlike the audit's own run, payments here never have the same payer and payee.

```ts
const members = [
  { id: 'm-alex', name: 'Alex', userId: 'audit-owner', email: 'alex@example.invalid' },
  { id: 'm-sam', name: 'Sam', userId: 'audit-sam', email: 'sam.longer-address@example.invalid' },
  { id: 'm-jordan', name: 'Jordan' },
  { id: 'm-max', name: 'Maximiliana Konstantinopoulou' },
  { id: 'm-priya', name: 'Priya' },
  { id: 'm-lee', name: 'Lee' },
];
const ids = members.map(m => m.id);
const titles = ['Dinner by the harbour', 'Taxi from the airport', 'Pastéis de Belém', 'Groceries for the flat',
  'Sintra day trip train tickets', 'Fado night', 'Sunscreen', 'Museum of Ancient Art (Museu Nacional de Arte Antiga) entry',
  'Coffee', 'Tram 28', 'Beach umbrellas', 'Seafood lunch at Cervejaria Ramiro', 'Wine shop', 'Boat tour', 'Pharmacy',
  'Ice cream', 'Breakfast', 'Cascais bus', 'Souvenirs', 'Late-night snacks', 'Laundry', 'Bike hire', 'Rooftop bar', 'Farewell dinner'];
const pad = (n: number) => String(n).padStart(2, '0');
const expenses = titles.map((title, i) => {
  const foreign = i % 4 === 1, share = ids.filter((_, j) => (i + j) % 3 !== 0);
  return {
    id: `e-${i}`, title, date: `2026-07-${pad(28 - i)}`, time: `${pad(9 + (i % 12))}:${pad((i * 7) % 60)}`,
    timezone: 'Europe/Lisbon', currency: foreign ? 'USD' : 'EUR', payer: ids[i % ids.length], tax: 0, tip: 0, discount: 0,
    ...(i % 5 === 0 ? { source: 'ai' } : {}),
    ...(foreign ? { fx: { rate: 0.92, asOf: '2026-07-20', source: i % 8 === 1 ? 'manual' : 'reference' } } : {}),
    items: i % 3 === 0
      ? [{ id: `e-${i}-a`, name: 'Main', amount: 1800 + i * 137, members: share },
         { id: `e-${i}-b`, name: 'Extra', amount: 600 + i * 31, members: [ids[0], ids[1]] }]
      : [{ id: `e-${i}-a`, name: title, amount: 950 + i * 411, members: share }],
  };
});
const payments = Array.from({ length: 9 }, (_, i) => {
  const from = ids[(i + 2) % ids.length];
  return { id: `p-${i}`, from, to: from === ids[0] ? ids[1] : ids[0], amount: 2500 + i * 730,
    date: `2026-07-${pad(10 + i)}`, method: i % 2 ? 'Bank transfer' : 'Revolut',
    ...(i === 3 ? { note: 'For the boat tour and the two dinners we split on Tuesday' } : {}) };
});
const drafts = ['Pingo Doce', 'Restaurante O Tasco do Chico — late supper', 'Continente', 'Farmácia', 'Uber', 'A Vida Portuguesa']
  .map((title, i) => ({ id: `d-${i}`, receiptId: `r-${i}`, title, status: i % 2 ? 'review' : 'pending', currency: 'EUR',
    date: '2026-07-20', time: '12:00', timezone: 'Europe/Lisbon', payer: 'm-alex', tax: 0, tip: 0, discount: 0,
    items: Array.from({ length: 2 + i }, (_, j) => ({ id: `d-${i}-${j}`, name: `Item ${j + 1}`, amount: 300 + j * 120, members: [] })) }));
export const trip = { id: 'audit-trip', ownerId: 'audit-owner', name: 'A week in Lisbon', currency: 'EUR', receiptLanguage: 'pt',
  startDate: '2026-07-04', endDate: '2026-07-28', members, expenses, payments, drafts };
// /api/activity: first page 20 events with nextCursor 180; ?before= returns 20 more with nextCursor null.
// Each event: { id, sequence, tripId, actorId, actorName, createdAt (hourly steps back from 2026-07-28T18:00Z),
//   revision, source: 'web', entityType: 'expense', entityId, action: create|update|delete in turn, before, after }.
// /api/invite?mode=list → { invitations: [{ id: 'inv-1', memberId: 'm-jordan', memberName: 'Jordan',
//   email: 'jordan@example.invalid', createdAt, expiresAt, status: 'pending' }], hasMore: false }
// Note: /api/invite must return `invitations`; any other shape crashes the Travellers tab.
```

The audit's ledger response also included a second, empty holiday ("Weekend in Porto"), so that the drawer lists two trips.

## Appendix B: evidence

| File | Shows |
| --- | --- |
| [`01-action-row.png`](layout-css-2026-10-09/01-action-row.png) | Top bar and Add expense / Scan receipt, before and after, at 320px and 430px (Fixes 3, 4) |
| [`02-expense-rows.png`](layout-css-2026-10-09/02-expense-rows.png) | Expense rows before and after, at 320px and 390px (Fixes 5, 6) |
| [`03-receipt-rows.png`](layout-css-2026-10-09/03-receipt-rows.png) | Receipt inbox rows before and after, at 320px and 390px (Fix 1) |
| [`04-language-panel.png`](layout-css-2026-10-09/04-language-panel.png) | Language preferences card before and after (Fix 2) |
| [`05-statements-travellers-downloads.png`](layout-css-2026-10-09/05-statements-travellers-downloads.png) | Statement links, traveller rows and download buttons, before (Fixes 9, 12, 13) |
| [`06-payments-history.png`](layout-css-2026-10-09/06-payments-history.png) | Recorded payments and History rows, before (Fixes 10, 16) |
| [`preview.css`](layout-css-2026-10-09/preview.css) | The CSS injected to make the "After" images |
