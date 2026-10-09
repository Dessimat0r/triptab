# Brief for Sol: even, readable layouts on phones

9 October 2026 · Base: `60b39a5` · Follows Claude's "TripTab Layout & CSS Audit" (same date)

> **Status: implementation added in PR 48.** See [the implementation audit](layout-css-implementation-2026-10-09/review.md) for fixes, verification and the remaining product/device checks. File and line references below describe the original base `60b39a5`. This brief is self-contained; you do not need the audit document. Evidence is in [`layout-css-2026-10-09/`](layout-css-2026-10-09/). Labels such as M4 or G2 are the finding IDs used in the audit document.

## What Gary asked for

> I want you to fully audit the layout and css of triptab. See if everything lines up evenly and can be clearly read. Particularly in mobile view. Some suggestions include making buttons in the same row like add expense and scan receipt spaced across the entire row. Also, pagination would be useful on panels with long lists or potential lists, for example your expenses.

The audit confirmed both suggestions and found more. This brief turns the findings into 25 fixes in five phases, preceded by a Phase 0 that adds the layout tests. Each fix gives the files to change, the change itself and a measurable test of when it is done.

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
| Right rail height below every tab | — | 839px | Hidden on phones and narrow tablets (Fix 8) |
| Payment row height, average | 168px | 163px | ≤ 120px at 390px (Fix 10) |
| Travellers tab height | 6,321px | 5,960px | Fix 21 reduces it |
| Expense date line contrast | 2.79:1 | 2.79:1 | ≥ 4.5:1 |

The "After" images in the evidence folder came from injecting [`preview.css`](layout-css-2026-10-09/preview.css) into the running app. With it, the title column went from 82px to 131px at 320px, the draft text column from 67px to 132px, and the buttons to 173px each at 390px.

## Ground rules for every phase

1. **Use the tokens.** Write new or edited rules with `--space-1`…`--space-6` (4–32px), `--text-xs`…`--text-xl` and `--radius-s`/`--radius-m` (`globals.css:27-40`). Two values are deliberately not tokens: 20px panel padding on phones (Fix 22 adds `--panel-padding`) and 44px tap targets.
2. **Reuse the existing breakpoints.** Use 700px for the phone layout, 480px for narrow phones and 359px for "stack pairs". The editor already stacks pairs at 359px (`expense-editor.css:1311-1316`). The only new widths are the two rail thresholds in Fix 8 (815px and 901–1015px), which come from measurements.
3. **Never hide overflow to pass a test.** The layout suite asserts that containers do not clip (`expense-layout.spec.ts`, the `clipping` checks). Fix the layout instead.
4. **Keep tap targets at 44×44px or larger**, and keep text in overlays at 16px or more so iOS does not zoom (`globals.css:2015-2023`).
5. **Do not add hard-coded colours.** Use `var(--surface)`, `var(--muted)`, `var(--line)` and the other variables, so dark mode needs no override. Check every change in both themes.
6. **Keep accessible names.** Tests find buttons by role and name: `Add expense`, `Scan receipt`, `Add receipt`, `Record payment`, `Record paid`, `Review`, `Remove draft`, `Open holidays`, `View statement`, `Load older changes`. Keep those names.
7. **Do not call hooks inside `renderSection`.** It is a plain function called from `TripTabSection`'s render (`components/trip-routing.tsx:20-22`), and the section it renders changes with the route. Keep new state in `Home` (`trip-app.tsx:223`), which persists across tab changes.
8. **One phase per PR.** Each PR must pass the checks in "Run before pushing".

## Implementation plan

Start with a **Phase 0 PR** that adds the Fix 17 spec and nothing else. Then follow this protocol, so that every PR is green and nothing is silently left out:

1. **Tag every case with its phase and fix**, e.g. `test('[P1·F3] action row fills the row', …)`. Commit cases for later phases as `test.fixme(…)`, with a comment naming the fix that activates them.
2. **Record a baseline.** Before marking anything `fixme`, run the spec on base `60b39a5` in both engines. List every case that fails on base, with the reason, in the Phase 0 PR description. A case that fails on base but is not on that list is a bug in the test, not a known failure.
3. **Each phase PR activates its own cases.** It turns its `test.fixme` into `test`, and must pass every active case plus the rest of `npm run test:layout`. It may never mark an already-active case `fixme`.
4. **The last phase closes the gate.** Phase 5 adds a unit test in `tests/` that reads `tests/browser/main-layout.spec.ts` and fails if any `test.fixme(` remains. If Gary declines a fix (for example Fix 21), delete its cases rather than leaving them pending.

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

#### Fix 8. The right rail squeezes the list on phones and narrow tablets (M5)

**Finding on phones.** Below 700px, the rail (`aside.right-rail`, `trip-app.tsx:2342-2403`) stacks under every tab. It holds the group balance card (533px at 390px) and the "Snap it. Check it. Split it." card (290px): 839px in all. On Expenses it starts 3,538px down at 390px (4,715px at 320px). Its Upload receipt button repeats Scan receipt.

**Finding at tablet and small-desktop widths.** Whenever the layout has two columns, the rail is 270–280px wide. Measured with the Appendix A fixture:

| Viewport | Sidebar | List width | Narrowest title | Average row | Tallest row |
| --- | --- | ---: | ---: | ---: | ---: |
| 701px | drawer | 355px | 129px | 150px | 223px |
| 768px | drawer | 422px | 196px | 129px | 173px |
| 820px | drawer | 474px | 248px | 124px | 137px |
| 900px | drawer | 554px | 328px | 120px | 137px |
| 901px | 210px | 355px | 129px | 150px | 223px |
| 1024px | 210px | 478px | 252px | 124px | 137px |
| 1150px | 210px | 604px | 378px | 120px | 137px |
| 1440px | 248px | 776px | 550px | 119px | 119px |

At 701px and 901px the list is as narrow as a 390px phone before Fix 6. Rows settle at about 124px once the list is about 470px wide. So the rail should give way whenever the list would be narrower than about 470px: up to 815px, and from 901px to 1015px.

**Change.**

1. In `Home`, build the balance card JSX once (`2343-2382`), as `const groupBalance = (inline: boolean) => …`. Render `groupBalance(false)` in the rail as now.
2. At the top of the `"balances"` case (`1632`), render `groupBalance(true)`. Give it the extra class `balance-card--inline`, and leave out its "View settlements" button, since you are already on that tab. Once Fix 7's `<ShowMore>` exists (Phase 3), show 8 travellers in the inline card and then Show more (list key `balance`).
3. CSS. These widths follow from the table: the sidebar is a drawer up to 900px and takes 210px from 901px.

   ```css
   .balance-card--inline { display: none; }
   @media (max-width: 815px), (min-width: 901px) and (max-width: 1015px) {
     .content-grid { display: flex; flex-direction: column; gap: 24px; }
     .right-rail { display: none; }
     .balance-card--inline { display: block; margin-bottom: var(--space-5); }
   }
   ```

   A container query on a wrapper around `.content-grid` would express "content narrower than X" directly, and is acceptable: the icon picker portals its overlay to `document.body` (`expense-icon.tsx:81`). Never put `container-type` on `main`, though. It contains the fixed tab bar, and containment can turn `main` into the tab bar's containing block.
4. Delete the rail's ≤700px rules that no longer apply (`globals.css:1243-1258`).

**Done when.**
- In those ranges (phones, 701–815px, 901–1015px), no `.right-rail` is visible on any tab, and Balances shows the group balance above "Settle up".
- At 816–900px and from 1016px, the rail shows and the list is at least 470px wide.
- At 768px the narrowest expense title is at least 250px.
- From Phase 3, with 50 travellers, the inline card shows 8 travellers and Show more.
- Measure at 701, 768, 815, 816, 820, 900, 901, 1015, 1016 and 1024px, and in landscape at 844×390.

#### Fix 9. Statement links lose alignment (M6)

**Finding.** `.statement-link` (`globals.css:1490-1516`; markup `trip-app.tsx:1673`) is a wrapping flex row with `overflow-wrap: anywhere`. When a name wraps ("Maximiliana Konstantinopoulou"), "View statement" drops to the left under it, while every other row right-aligns it. See `05-statements-travellers-downloads.png`.

**Change.** Keep the wrapping flex row, and push the link right whether it wraps or not:

```css
.statement-link { overflow-wrap: break-word; }   /* was anywhere: split a word only when it is wider than the whole row */
.statement-link > span:last-child { margin-left: auto; white-space: nowrap; }
```

Do not use a two-column grid here. At 320px an `auto` column for "View statement" leaves about 120px for the name, and "Konstantinopoulou" would split. With the flex row, a long name takes the first line, and "View statement" wraps to a second line that is still right-aligned.

These results come from injecting this CSS, with the Appendix A fixture. At 100% and 200% text, every row's right edge is identical (281px at 320px, 351px at 390px), with no split words and no overflow. At 200% text, all 6 rows wrap at 320px and 2 wrap at 390px, and they stay aligned.

**Done when.** At 320–430px and at 200% text, the right edge of "View statement" is identical (±1px) on every row, and no word is split unless that word alone is wider than the row.

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

**Finding.** Only the two activity histories are paged: holiday History (`activity-panel.tsx:462`) and private account history in Profile & app settings (`account-activity-panel.tsx:63`, "Load older account changes"). Both fetch 20 events at a time from the server. Everything else renders in full, while the schema allows 50 travellers, 1,000 expenses, 1,000 payments and 100 drafts (`lib/model.ts:319-321`). The whole ledger is already in the browser, so paging these is a rendering change, with no API work.

| List | Where | Measured at 390px | Decision |
| --- | --- | --- | --- |
| Your expenses | `trip-app.tsx:1572` | 24 rows, 3,046px | Page by 20 |
| Statement expenses | `member-statement.tsx:73-74` | 24 entries, 4,540px inside the dialog | Page by 10 |
| Statement payments | `member-statement.tsx:92-93` | 5 entries, 433px | Page by 10 |
| Recorded payments | `trip-app.tsx:1679` | 9 rows, 1,470px | Page by 5 |
| Receipt inbox | `trip-app.tsx:1723` | 6 drafts, 655px | Page by 10 |
| Travellers | `trip-app.tsx:1805` | 6 rows, 567px; **50 travellers: 3,603px** | Page by 10; the add-traveller form stays visible below |
| Traveller display names | `trip-details.tsx:120-125` | 6 forms; **50 travellers: 9,821px** | Page by 10; Fix 14 also removes the idle Save buttons |
| Group balance, inline on phones | Fix 8 | 6 rows, 533px; **50 travellers: 3,393px** | Show 8, then Show more (Fix 8) |
| Holiday History | `activity-panel.tsx:453-462` | 20 events, 2,951px | Keep server paging; restyle (Fix 16) |
| Account history | `account-activity-panel.tsx:63` | — | Keep server paging; full-width button on phones (Fix 13) |
| Active invitations | `trip-sharing.tsx:119-144` | 1 | **Out of scope.** The list API returns the first 200 rows and a `hasMore` flag, with no cursor (`app/api/invite/route.ts:139`), so the UI can only show "More older invitations exist". Paging needs API work. Track it as a follow-up. |

With 50 travellers the Travellers tab is 20,369px tall at 390px, which is why both of its lists are paged.

**Order: "Recently added".** Payments and drafts are appended when saved (`trip-app.tsx:1371`, `912`, `1176`), and neither has a recorded-at field (`lib/model.ts:309-312`). Reversing them at render time therefore means "most recently added first". That is what this fix needs, because it guarantees a just-saved entry is on the first page. It is **not** date order: a backdated payment recorded today comes first, and a ledger whose stored order is not entry order (an import, or MCP writes) shows its stored order reversed.

- Render `[...trip.payments].reverse()` and `[...trip.drafts].reverse()`. Never change the stored order.
- Label these lists "Recently added", not "Newest first".
- Expenses already prepend on save (`trip-app.tsx:1254`), so their current "Newest first" label means the same thing. Relabel it "Recently added", so all three lists say what they do. Do not change the Expenses order: whether it should sort by transaction date is Gary's open question.
- Test: a backdated payment appears first; editing a payment keeps its position; a newly uploaded draft appears first; a stored order that isn't entry order renders exactly reversed.

**Pattern.** A "Show more" button adds the next page in place. Do not use numbered pages: Show more keeps the scroll position, gives one large tap target, and matches Load older changes.

**Implementation.**

1. **New `components/paged-list.tsx`** with the footer:

   ```tsx
   export function ShowMore({ shown, total, step, noun, onMore }: {
     shown: number; total: number; step: number; noun: string; onMore: () => void;
   }) {
     if (shown >= total) return null;
     return <div className="list-more">
       <p className="muted">Showing {shown} of {total} {noun}</p>
       <button type="button" className="quiet" onClick={onMore}>Show {Math.min(step, total - shown)} more</button>
     </div>;
   }
   ```

2. **State lives in `Home`** (rule 7), scoped to the account *and* the holiday. Use the derived-state pattern of `useActivityPages` (`activity-panel.tsx:61`):

   ```tsx
   const pageScope = `${profile?.id ?? ""}:${trip?.id ?? ""}`;
   const [paging, setPaging] = useState<{ scope: string; counts: Record<string, number> }>({ scope: "", counts: {} });
   const counts = paging.scope === pageScope ? paging.counts : {};
   const shownCount = (list: string, step: number) => counts[list] ?? step;
   const showMore = (list: string, step: number) => setPaging(previous => {
     const current = previous.scope === pageScope ? previous.counts : {};
     return { scope: pageScope, counts: { ...current, [list]: (current[list] ?? step) + step } };
   });
   ```

   The resulting behaviour:
   - Switching tabs within a holiday keeps every count.
   - Switching holiday, or account (including sign-out and sign-in), starts every list on its first page. Returning to a holiday (A→B→A) also starts on the first page.
   - A background refresh keeps the count. Display `Math.min(count, total)`, so deleted entries never leave a stale "Showing 20 of 18".

   `MemberStatement` keeps its own `useState` per section; it remounts each time it opens.

3. **Render** `list.slice(0, shownCount(key, step))`, with `<ShowMore>` inside the list's `.panel` after the last row. Give each row `data-entry-id={entry.id}`.

4. **Focus and scroll.**
   - On Show more, read the ID of the first entry about to appear (index `shown`). After the render, focus that entry's main control by ID with `focus({ preventScroll: true })`. The entry renders where the button was, so the page does not move. Then call `scrollIntoView({ block: "nearest" })`, which only scrolls if the focus ring is off-screen.
   - Do this for keyboard and touch alike. It also stops focus falling to `<body>` when the button disappears on the final batch.
   - If that entry has gone by the time it renders (a refresh removed it), focus the entry now at that index, or the list's heading if none remains.
   - A background refresh that inserts a row at the top shifts the slice by one. It must not move focus or announce anything.
   - Announce "Showing 40 of 57 expenses" through one visually hidden `role="status"` element, updated only by a Show more press. The visible count line is not a live region, so refreshes stay silent.

5. **CSS** in `globals.css`:

   ```css
   .list-more { display: grid; gap: var(--space-2); justify-items: center; padding: var(--space-4); border-top: 1px solid var(--line); text-align: center; }
   .list-more .muted { margin: 0; }
   @media (max-width: 700px) { .list-more { justify-items: stretch; } }
   ```

**Not in this fix:** search, filters, server paging, invitation paging, and date headings on Expenses.

**Done when.** With the Appendix A fixture:

- Expenses shows 20 rows, "Showing 20 of 24 expenses" and "Show 4 more". Pressing it shows 24 rows, hides the footer and focuses row 21. The scroll position is unchanged (±2px), whether pressed by pointer or keyboard.
- Switching to Balances and back keeps 24. A→B→A and an account switch both reset to 20.
- A background refresh that adds an expense keeps the count, moves no focus and announces nothing.
- A newly saved expense, payment or draft appears first.
- Recorded payments shows 5 of 9; Receipts shows all 6 with no footer.
- The statement dialog shows 10 of 24 expenses and follows the same focus rules.
- With 50 travellers, Travellers and Display names each show 10, and the inline group balance shows 8.

#### Fix 10. Payment rows take three lines and show raw dates (M7)

**Finding.** Each row (`trip-app.tsx:1679-1705`) puts "Jordan paid Alex", the raw ISO date `2026-07-10` and the method on separate lines. On phones it adds a second grid row for the amount and buttons (`globals.css:1700-1722`), so rows are 163px each. See `06-payments-history.png`.

**Change.** Two flex lines per row. The class `payment-actions` is already taken by the payment dialog (`globals.css:1481`), so the row's buttons get a new name.

```tsx
<div className="payment" key={p.id} data-entry-id={p.id}>
  <div className="payment-line">
    <span className="payment-summary">{name(p.from)} paid {name(p.to)}</span>
    <b className="payment-amount">{money(p.amount, trip.currency)}</b>
  </div>
  <div className="payment-line">
    <small className="payment-meta">{formatCalendarDate(p.date)}{p.time ? ` · ${p.time}` : ""}{p.method ? ` · ${p.method}` : ""}</small>
    <span className="payment-row-actions">{/* Edit and Undo recorded payment, unchanged */}</span>
  </div>
  {p.note && <small className="payment-note">{p.note}</small>}
</div>
```

```css
.payment { display: block; padding: var(--space-4) 22px; }
.payment-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); min-width: 0; }
.payment-line + .payment-line { margin-top: var(--space-1); }
.payment-line > :first-child { flex: 1 1 12em; min-width: 0; overflow-wrap: break-word; }
.payment-line > :last-child { flex: 0 1 auto; min-width: 0; margin-left: auto; }
.payment-amount { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right; }
.payment-meta { color: var(--muted); margin: 0; }
.payment-row-actions { display: flex; gap: var(--space-2); }
.payment-note { margin-top: var(--space-1); color: var(--muted); overflow-wrap: break-word; }
```

Delete the old `.payment` rules (`724-738`, `1517-1520`) and the ≤480px block (`1700-1722`).

Why flex rather than a grid: the `12em` basis grows with text size. At 320px, below 360px, or at 200% text, the amount and then the buttons wrap onto their own lines, still right-aligned, without a breakpoint. A grid with an `auto` column for the buttons squeezes the name instead.

These results come from rebuilding the rows in the browser with this markup and CSS. The first row carries the worst case: a 50-character name ("Bartholomew Alexander Fitzgerald-Montgomery Smythe"), an 80-character method, the maximum amount (€1,000,000.00, `MAX_AMOUNT`, `lib/model.ts:51`) and a 300-character note.

| Viewport | Text | Worst-case row | Other rows, average | Overflow | Split words | Buttons |
| --- | --- | ---: | ---: | --- | --- | --- |
| 320px | 100% | 338px | 148px | None | None | 44px, right-aligned |
| 320px | 200% | 1,148px | 337px | None | None | 44px, right-aligned |
| 390px | 100% | 265px | 114px | None | None | 44px, right-aligned |
| 390px | 200% | 831px | 297px | None | None | 44px, right-aligned |

Today the average is 168px at 320px and 163px at 390px. "Split words" counts only a word that fits the line but was broken anyway; a break after a hyphen ("Fitzgerald-" / "Montgomery") is allowed. 200% text was approximated by setting the root font size to 32px, so the few px-sized texts did not scale. Check real browser text zoom in WebKit.

**Done when.** At 320px and 390px, at 100% and 200% text, and with the worst-case row above: no overflow, no split words, buttons at least 44px and right-aligned. A row without a note is at most 120px at 390px. Dates read "10 Jul 2026", and the order is Recently added (Fix 7).

#### Fix 11. One date format (G3)

**Finding.** Dates are formatted in ten places, four different ways. Keep two kinds strictly apart: **calendar dates** (stored `YYYY-MM-DD`: expense, payment, holiday and FX dates), which must never shift with the viewer's time zone; and **instants** (ISO timestamps: activity, refresh, messages, invitations), which show in the viewer's zone.

| Call site | Shows today | Kind | Replace with |
| --- | --- | --- | --- |
| `trip-app.tsx:94-98` `expenseDate` (used at `1594`, `2716`) | "28 Jul 2026" | Calendar | `formatCalendarDate` |
| `member-statement.tsx:14-17` `displayDate` (used at `77`, `86`, `98`) | "28 Jul 2026" | Calendar | `formatCalendarDate` |
| `trip-app.tsx:1683` recorded payments | Raw "2026-07-10" | Calendar | `formatCalendarDate` |
| `trip-app.tsx:2220` holiday start in the page heading | "4 Jul" (`toLocaleDateString("en-GB")`) | Calendar | `formatCalendarDate(value, { year: false })` |
| `trip-app.tsx:2223` "Refreshed 08:00" | `toLocaleTimeString("en-GB")` | Instant | `formatClockTime` |
| `activity-panel.tsx:169-174` `auditTimestamp` without `exact` (used at `457`) and `account-activity-panel.tsx:47` | Device locale, seconds and zone name: "28 Jul 2026, 18:00:00 BST" | Instant | `formatInstant`; History rows show the time only, under day headings (Fix 16) |
| `restoration-notice.tsx:7` | Device locale, seconds and zone name | Instant | `formatInstant` |
| `trip-sharing.tsx:124` invitation expiry | Device locale, short | Instant | `formatInstant` |
| `receipt-chat.tsx:28-38` `messageTime` | Device locale, no year: "Jul 28, 06:00 PM" | Instant | `formatInstant(value, { year: false })`. Text only; the editor layout is out of scope. |

**Exceptions, which stay as they are:**
- `auditTimestamp(value, true)`, the exact ISO form with "(UTC)" used in activity details and records (`activity-panel.tsx:244`, `266`, `315`, `363`, `377`, `409`; `account-activity-panel.tsx:51`).
- Export and CSV formats.
- Time-zone detection with `Intl.DateTimeFormat().resolvedOptions().timeZone` (`trip-app.tsx:693`, `740`, `1358`; `payment-editor.tsx:37`).
- Number formatting with `toLocaleString` (`share-split.tsx:205`, `activity-panel.tsx:375`).
- The vendored `components/ui/*`.

**Change.** Add these to `lib/dates.ts` and use them at every site in the table:

```ts
/** "28 Jul 2026" (or "28 Jul") for a stored YYYY-MM-DD calendar date; never shifted by the viewer's zone. */
export function formatCalendarDate(value: string, options: { year?: boolean } = {}): string
/** "28 Jul 2026, 18:00" (or "28 Jul, 18:00") for an instant, in the viewer's zone or `timeZone`. */
export function formatInstant(value: string | Date, options: { year?: boolean; timeZone?: string } = {}): string
/** "18:00" for an instant, in the viewer's zone or `timeZone`. */
export function formatClockTime(value: string | Date, options: { timeZone?: string } = {}): string
/** "Tue 28 Jul 2026" for an instant's local day (History day headings, Fix 16). */
export function formatInstantDay(value: string | Date, options: { timeZone?: string } = {}): string
```

Format calendar dates as `${value}T00:00:00Z` with `timeZone: 'UTC'`, as `member-statement.tsx` does now. Use `en-GB` for all four, with `hourCycle: 'h23'`. Invalid input returns "Invalid date" (calendar) or "Date unavailable" (instants), matching the current wording.

**Done when.**
- No display code outside the exceptions calls `toLocaleString`, `toLocaleDateString` or `toLocaleTimeString`, or builds its own `Intl.DateTimeFormat`.
- Unit tests in `tests/` cover:
  - invalid input for each helper;
  - a calendar date formatted with the process in `Pacific/Kiritimati` (UTC+14) and in `Pacific/Pago_Pago` (UTC−11), each still giving the same day;
  - an instant near midnight UTC passed with explicit `timeZone` values on either side of midnight, giving different days;
  - `auditTimestamp(value, true)` output unchanged.

#### Fix 16. History heading, spacing and paging button (G5, M15)

**Finding.** The holiday Activity section (`activity-panel.tsx:445-463`) is the only tab without `.sectionheading`. It stacks `margin-top: 24px` and `padding-top: 24px` with an orphan `border-top` (`globals.css:1563-1569`), plus `.subheading`'s `margin-top: 28px` (`721-723`). That is 76px above "Activity". Events sit directly on the page background, not in a card. "Load older changes" is a small left-aligned button.

**Change.** Change only the holiday-wide variant (`!scope`). The receipt-history variant (`.receipt-activity`) inside the editor stays as it is.

- Use the same heading markup as the other tabs: `div.sectionheading` > `h2` + `span.muted` ("Updates automatically").
- Remove the top margin, padding and border for `.activity-panel:not(.receipt-activity)`.
- Put the event list in a `.panel` with `padding: 0 var(--panel-padding)`. The last event has no bottom border.
- Group events under day headings: an `h3` with the date of `createdAt` in the viewer's time zone, via `formatInstantDay` from Fix 11 ("Tue 28 Jul 2026"). Show only the time ("18:00") on each event row. Keep `li.activity-event` (tests use it).
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
| Load older changes, Load older account changes | `activity-panel.tsx:462`, `account-activity-panel.tsx:63` | `phone-wide` |

**Done when.** On the Travellers tab at 390px, every button in a `.button-row` is exactly the width of its grid column, and a single button is full width. Above 700px the buttons look as they do today.

#### Fix 14. Six disabled Save buttons under display names (M12)

**Finding.** Each traveller has its own form and its own Save button (`trip-details.tsx:30-62`, button at `61`). The button is disabled until that name changes, so the card shows six greyed-out buttons, about 60px each.

**Change (recommended, small).** Render Save only when `value.trim() !== member.name`, while `submitting`, or while an error is showing. Pressing Enter still submits. Keep the per-row forms, validation and messages exactly as they are. Do **not** merge them into one Save: that would change duplicate-name checking and error handling, and Gary hasn't asked for it.

**Done when.** With no edits, the card shows no Save buttons. Typing in one name shows one Save button for that row. Saving works as before.

#### Fix 15. Record payment: Save is below the fold (M16)

**Finding.** The payment dialog (`payment-editor.tsx:88-182`) has nine single-column fields on phones: `.payment-editor .fieldpair` collapses at 480px (`globals.css:1676`). "Review payment" sits below the fold and does not stick, unlike the expense editor's footer.

**Change.**

1. **Reuse the editor's sticky-footer hook.** `useStickyFooterReveal(scroller)` (`components/editor-footer-reveal.ts`) already does the hard part for the expense editor:
   - it publishes the footer's live height as `--editor-footer-height` on the scrolling dialog;
   - it scrolls a focused control back into view when the footer would cover it;
   - it re-reveals the focused control when a phone keyboard shrinks the dialog.

   Attach it to the payment dialog's actions: `const footerRef = useStickyFooterReveal(".payment-editor")` and `<div className="payment-actions" ref={footerRef}>`. Do not rely on a fixed `scroll-padding-bottom`.
2. **CSS**, following `.editor-footer` (`expense-editor.css:998-1010`):

   ```css
   .payment-editor { scroll-padding-bottom: calc(var(--editor-footer-height, 96px) + var(--space-3)); }
   .payment-editor .payment-actions {
     position: sticky; bottom: 0; z-index: 1;
     margin: var(--space-5) -28px 0; padding: var(--space-3) 28px;
     background: var(--surface); border-top: 1px solid var(--line);
   }
   @media (max-width: 700px) { .payment-editor .payment-actions { margin-inline: -22px; padding-inline: 22px; } }
   ```

   The negative margins match `.modal`'s padding (`globals.css:923`, `1320`). The dialog keeps its single scroll area, and `.modal`'s `max-height` already follows `--viewport-height` (`globals.css:925`, `1322`).
3. **Keep Date and Time side by side down to 360px.** Add `fieldpair--keep` to that pair (`payment-editor.tsx:159`). Then add global rules: `.fieldpair.fieldpair--keep` gets two columns at or below 480px and stacks below 360px. Leave Paid by / Paid to stacked, because long names truncate in a half-width select.

**Done when.** At 320×568 and 390×844, in both the details step and the review step:
- The main button is visible without scrolling, with the keyboard closed.
- With the keyboard open (use the visual-viewport harness in `expense-layout.spec.ts` "phone keyboard"), focusing the Note textarea leaves it fully visible above the footer, and the footer stays above the keyboard.
- An error message shown after Review payment is visible, with the button reachable.
- Exactly one element scrolls, and the page does not show behind the dialog (`html[data-keyboard-open]` still hides `.shell`).
- The existing tests "keeps a centred dialog above the keyboard" and "landscape payment" still pass.

#### Fix 18. Add a receipt: capture buttons stack early; "optional" wraps (M17)

**Finding.** In the inbox dialog, Scan receipt and Choose image (`receipt-upload-dialog.tsx:52`) stack below 480px (`globals.css:2349-2354`). The editor keeps the same pair side by side down to 360px (`expense-editor.css:462-464`, `1311-1316`). Under "Receipt location" (`receipt-upload-dialog.tsx:51`), the `<small>optional</small>` drops to its own line because of the global `small { display: block }` (`globals.css:117-121`).

**Change.** Replace `globals.css:2349-2354` with a 359px rule that stacks `.receipt-capture-inputs`. Add `.receipt-upload-place summary small { display: inline; margin-left: var(--space-1); }` to `receipt-upload.css`.

**Done when.** At 390px both dialogs show the pair side by side, and at 320px both stack. "Receipt location optional" is on one line. `expense-progressive.spec.ts` "the inbox and the editor offer the same capture actions and wording" still passes.

#### Fix 19. The holiday drawer is not a proper drawer (M18)

**Finding.** Below 900px the sidebar opens as a drawer (`trip-app.tsx:2070-2146`, `menu` state), but it does not behave like one:
- there is no backdrop, so the page beside it stays bright and looks tappable;
- Escape does nothing, focus stays on "Open holidays", and Tab moves through the page behind;
- closing the drawer does not restore focus;
- the page behind can still scroll.

**Change.** Treat the open drawer as a modal navigation layer.

1. **Share the modal behaviour.** `ModalA11y` (`components/modal-accessibility.tsx:41-120`) already provides:
   - Escape to close;
   - a Tab trap;
   - focus moved inside on open and restored on close;
   - scroll locking on `html` and `body`;
   - stacking with other modals.

   Extract that effect into a hook, `useModalLayer(rootRef, { active, onClose })`, with `ModalA11y` calling it unchanged. Then call it from `Home` for the sidebar, with `active: menu && narrow`.
2. **`narrow`** comes from `matchMedia("(max-width: 900px)")`. If the window widens past 900px while the drawer is open, close it (`setMenu(false)`), so nothing stays locked.
3. **Make the page inert.** While the drawer is open, set `inert` on `.workspace` (React 19 accepts the `inert` prop, already used at `trip-app.tsx:2660`). That covers the tab bar too, since it sits inside `.workspace`.
4. **Backdrop.** After `</aside>`, render `{menu && <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setMenu(false)} />}`. It is pointer-only; keyboard users have Escape and the close button.

   ```css
   .sidebar-backdrop { display: none; }
   @media (max-width: 900px) {
     .sidebar-backdrop { display: block; position: fixed; inset: 0; z-index: 35; background: #19213f70; }
     .sidebar.visible { z-index: 40; overflow-y: auto; overscroll-behavior: contain; }
   }
   @media (prefers-color-scheme: dark) { .sidebar-backdrop { background: #040812b8; } }
   ```

   The z-order is: topbar 25, tab bar 30, backdrop 35, drawer 40, dialogs 50 (`.overlay`), icon picker 110. The colours match `.overlay` (`globals.css:888`, `2238`).
5. **Initial focus** goes to the current holiday's button, or to "Close holiday menu".

**Done when.**
- Tab and Shift+Tab stay inside the open drawer.
- Escape, the close button, the backdrop, and choosing a holiday each close it, and focus returns to "Open holidays".
- A wheel or touch scroll over the backdrop does not move the page; the drawer scrolls on its own.
- At 320×568, with the account-setup card showing, the account button at the bottom of the drawer can be scrolled to and pressed.
- `sidebar-assistant.spec.ts` still passes.
- Check manually with VoiceOver in Safari on an iPhone.

#### Fix 20. Main actions in dialogs on phones (M19)

**Finding.** Create holiday uses a full-width primary button (`.primary.wide`, `trip-app.tsx:2525`). Profile & app settings uses small left-aligned secondary buttons: "Save profile" (`account-panel.tsx:141`) and "Add password" (`account-panel.tsx:235`).

**Change.** Add `phone-wide` (Fix 13) to those two buttons. Leave the other account buttons (unlink, sign out, links) as they are.

**Done when.** At 390px, Save profile and Add password are full width.

### Phase 5: Structure and cleanup (Fixes 21–25)

#### Fix 21. Shorten the Travellers tab (M14). Gary decides; do not implement without his go-ahead.

**Finding.** The tab is 5,960px at 390px. Measured section heights: Holiday details with display names 2,126px, Invite 824px, Travellers 567px, Download 517px, Language 284px.

**Proposal.** Keep the travellers list and Invite open. Make each of the following its own card, as a `<details>` that is closed by default, with the card heading as the `<summary>`:

- Holiday details
- Traveller display names (split out of the Holiday details card)
- Your receipt language preferences
- Download your data

Open a section automatically while it shows an error, a success message or unsaved edits. Reuse the editor's chevron (`expense-editor.css:822-829`). This is a product decision, so it is Gary's to make; Fix 7 already pages both long lists either way. Another option to put to him: merge display-name editing into the traveller rows, since today the same people are listed twice.

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

This is a visual change, not a mechanical cleanup. Do it last, in its own PRs, after the functional fixes have settled.

1. **Inventory first.** Commit a table of every raw length and font size in `globals.css`: its selector, value, and the token it would map to. Do this with a script, not by eye.
2. **Map exact matches mechanically.** For example, 16px becomes `--space-4` and 0.875rem becomes `--text-s`. These commits must change no geometry.
3. **Treat values between tokens (18px, 22px, 0.95rem) as design decisions.** Either add a named token with a reason (such as `--panel-padding` or `--row-padding`), or round to a neighbour and list the visual change in the PR description. Never round silently.
4. **Make one component per commit:** top bar, stats, tabs, expense list, and so on.
5. **For each commit, compare geometry before and after.** Record the bounding boxes of that component's elements with a script, at 320px, 390px, 768px and 1440px, in light and dark mode, and at 200% text. Screenshots alone are not enough. Unintended movement over 1px fails the commit.
6. **Do not mix this with any behaviour change**, and do not let it alter the breakpoints or row heights that the earlier phases fixed. The Fix 17 spec must stay green throughout.

Collapse font sizes towards 0.75, 0.875, 1, 1.25 and 1.5rem, plus 2rem for the page title (add `--text-2xl`), only where step 3 accepts the change.

## Fix 17: the layout spec to write first

Create `tests/browser/main-layout.spec.ts`, using the Appendix A fixture and `fixtures()` routing, in the Phase 0 PR (see "Implementation plan" for the gating protocol). Run it at 320×740, 375×667, 390×844 and 430×932 (touch), plus 768×1024 and 1440×900. Repeat the checks marked † in dark mode at 390px, and the checks marked ‡ at 200% text. Playwright already runs Chromium and WebKit.

Measure geometry; do not compare screenshots. The assertions must catch real defects without forcing awkward layouts:

| # | Phase | Assertion | Covers |
| --- | --- | --- | --- |
| 1 | P1 | On each tab, the document's `scrollWidth <= clientWidth` † ‡ | Fix 4 |
| 2 | P1–P3 | **No avoidable word splits and no clipping** in `.expense-details b`, the `.draft` text, `.member-identity b`, `.statement-link > span:first-child`, `.payment-summary` and `.payment-meta`. Split text into words on whitespace, treating a hyphen as the end of a word, since breaking after a hyphen is allowed. For each word, build a `Range` and read `getClientRects()`. A word with more than one rect fails **only if its total width is at most the element's content width**: a word wider than its whole box may break. Also, each element's `scrollWidth <= clientWidth`, and no ancestor up to the row clips it (`overflow` not hidden or clip). Activate per list as its fix lands: drafts in P1, expenses in P2, traveller names and statement links in P2, payments in P3. † ‡ | Fixes 1, 6, 9, 10, 12 |
| 3 | P1 | `.expense-entry-actions`: from 360px to 700px, buttons have equal width (±1px) and span the row edge to edge; below 360px they stack, each full width; above 700px they keep their natural width. ‡ (at 200% text, stacking is allowed) | Fix 3 |
| 4 | P1 | `.personal-language-settings` has `padding-left` of at least 20px, and its heading's x matches the Holiday details heading (±1px). P5 extends this to `.sharing-panel`, `.trip-details-panel` and the compact export card. | Fixes 2, 22 |
| 5 | P1 | **Contrast:** for each visible text element in `main`, `.tabs` and `.topbar`, its colour against the nearest ancestor with an opaque background is at least 4.5:1, or 3:1 for text that is 24px+, or 18.66px+ bold. Skip disabled controls (WCAG exempts them). † | Fix 5 |
| 6 | P2 | "View statement" right edges are equal (±1px) on all rows. ‡ | Fix 9 |
| 7 | P2 | In the rail ranges of Fix 8, `.right-rail` is hidden and Balances shows `.balance-card--inline`; outside them, the reverse | Fix 8 |
| 8 | P2 | At 320px, the expense title column is at least 125px for a same-currency row, and the average row height is at most 140px | Fix 6 |
| 9 | P3 | Pagination, order and focus: every item in the Fix 7 "Done when" list | Fix 7 |
| 10 | P4 | Every `.button-row` child at or below 700px equals its column width, and a lone child is full width | Fix 13 |
| 11 | P4 | Drawer: every item in the Fix 19 "Done when" list, except the VoiceOver check | Fix 19 |
| 12 | P4 | Record payment: every item in the Fix 15 "Done when" list | Fix 15 |
| 13 | P1 | **Tap targets:** intended tap targets are at least 44×44px. That means `button`, `.quiet`, `.primary`, `.iconbutton`, `.textbutton`, the tab bar's links, `summary` elements used as disclosure controls, and form controls. **Inline links inside a sentence are exempt**, as WCAG 2.5.8 allows (e.g. the links in `.footnote` and `.error`). For those, check instead that no two inline targets are closer than 24px edge to edge. Keep the list of exempt selectors in the spec, with the reason for each. | Ground rule 4 |

Before relying on a new assertion, prove it fails: run it against a version with the bug (base `60b39a5` for most cases) and confirm it fails for the right reason.

## Rules that must not regress

- Money and splits: no change to `lib/model.ts`, the calculations, or any value displayed apart from formatting.
- One tap on an expense row opens that expense. The icon picker stays its own control.
- The existing layout specs pass unchanged, in Chromium and WebKit: `expense-layout.spec.ts` (no clipping, one scroll area, 44px targets, keyboard), `quick-expense.spec.ts`, `expense-confirmation.spec.ts`, `expense-progressive.spec.ts`, `receipt-upload.spec.ts` (`.draft-visual .expense-icon-trigger` at line 125) and `sidebar-assistant.spec.ts`.
- Dark mode has no light-only colours. `expense-progressive.spec.ts` checks receipt borders in dark mode; extend the same idea to the new spec's † checks.
- iOS: fields in overlays stay at 16px or more; the iOS keyboard handling (`visual-viewport.ts`, `html[data-keyboard-open]`) is untouched.
- Stored data order never changes. Reversed lists (Fix 7) are reversed at render time only.

## Decisions taken in this brief (Gary can overrule)

- Payments and receipt drafts render **Recently added** first (stored order reversed at render time), so paging never hides a new entry. Expenses already work this way; all three lists are labelled "Recently added" instead of "Newest first" (Fix 7). This is entry order, not date order.
- Active invitations stay unpaged, because the API has no cursor (Fix 7).
- The rail gives way at 701–815px and 901–1015px as well as on phones, based on the measurements in Fix 8.
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
