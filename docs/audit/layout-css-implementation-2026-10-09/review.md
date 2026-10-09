# PR 48 implementation audit

The PR originally added a mobile layout brief and injected-CSS illustrations, without changing the app. This review checked the implementation against the brief, reproduced defects on `60b39a5`, implemented the functional layout fixes, and exercised the actual production Worker in Chromium and WebKit with synthetic accounts and ledgers.

## Implemented

- Receipt drafts use a two-row grid on narrow phones, keeping readable title/status space and 44px remove controls. Main expense actions fill equal columns, stacking below 360px. Mobile top-bar status no longer crowds the breadcrumb.
- Expense titles, payer details, transaction metadata and share information use the available row width. Payment rows wrap names, amounts and actions without splitting ordinary words. Statement actions align, and traveller identities keep names and emails together.
- Language, sharing, holiday-details and compact-export cards share padding. Mobile export/invitation actions use equal columns or full width. Idle traveller-name Save buttons appear only when needed.
- Expenses, payments, drafts, traveller identities, traveller display names, inline balances and statement entries have bounded rendering and Show more. Expansion retains counts across tabs, resets across holiday/account scopes, focuses the next entry by ID, and announces only user-requested expansion. Payment/draft display order is reversed without changing ledger storage order.
- The independent review also found two long lists omitted from the original pagination table: suggested transfers and traveller statement links. Both now show 10 at a time, using the same persistent paging and focus behavior.
- The rail yields at measured narrow widths; Balances retains the group balance inline. Rail/list headings align.
- Payment actions use the existing sticky-footer reveal hook. Date/time fields stay paired down to 360px. Receipt capture actions share that breakpoint, optional labels stay inline, and receipt upload controls have 44px targets.
- The holiday drawer uses the shared modal focus/scroll behavior, a backdrop, inert background, Escape handling, and focus restoration. Widening the viewport releases it.
- Shared calendar/instant display helpers reject invalid values and preserve the distinction between calendar dates and instants. Exact audit timestamps and export formats stay unchanged. Calendar dates were already preserved by the original local-noon expense formatter; UTC now expresses that rule explicitly.
- Secondary text uses theme tokens. The independent contrast scan additionally found low-contrast purple/blue avatar initials and the desktop receipt-card paragraph; these now use the label token.
- Unused selectors, empty media blocks and redundant whitespace were removed. The Tailwind import is retained. A scripted inventory records 702 raw lengths and 220 exact token matches; those matches were migrated without rounding. Geometry checks compare the tokenized rules with literal expansions at 320, 390, 768 and 1440px, both themes and 200% text.

## Baseline and regression evidence

The new receipt-width assertion fails on `60b39a5`: **67.890625px**, against the 120px minimum. The new drawer assertion also fails there because the workspace is not inert while navigation is open.

Diff review caught a pagination implementation error that would reverse saved drafts on an icon edit. The new browser regression reproduced the reversed POST order, and the handler was corrected to update the original stored array. The compact-receipt tests also caught a temporary CSS cleanup error that removed the Tailwind import; restoring it preserves visually hidden labels and compact item rows.

The browser spec covers all tabs, nine viewport widths, both themes, enlarged text, text contrast/word splits, pagination scope and focus, 50 travellers, statement pagination, history server paging, payment footer/keyboard geometry, draft-icon storage order, and exact token geometry.

## Verification

- `npm test`: **1,224 passed**, no failures or skips.
- `npx tsc --noEmit`: passed. Production build: passed with `RECEIPT_AI_OWNER_EMAIL=owner@example.test`.
- `npm run lint`: no errors; three existing warnings (internal `location.assign`, receipt `<img>`, and an unused import in historical audit evidence).
- The full browser run passed **301 of 304** checks. Two new assertions were corrected: the day label includes an Intl comma, and the payment selects need role-based locators because their labels include option text. The third failure was an existing Chromium keyboard test's positioning precondition, before keyboard simulation. All three scenarios then passed in both engines (**6/6**); that existing test also passed on the baseline. This is recorded as a timing-sensitive precondition, rather than claiming a clean full-suite run.
- After adding paging to suggested transfers and traveller statement links, the final production build passed the entire new audit spec: **50/50**, Chromium and WebKit, two workers. This includes both corrected assertions and the 50-traveller fixture.
- Visual inspection covered 320px Expenses/Receipts and 1440px Expenses. Receipt images in the synthetic fixture were unavailable; image loading was not validated by those captures.
- `git diff --check`: passed.

Browser commands used `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` and `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`. WebKit's missing shared libraries were extracted locally from Debian packages; the actual browser launched and executed the checks. API responses were fixtures, served against the local production Worker. These tests establish layout and client interaction behavior, not live backend integration.

Reproduce the final audit with a production build and `npm run test:layout -- tests/browser/main-layout.spec.ts --workers=2` (both configured engines). The baseline receipt-width and drawer checks are intentionally failing negative controls, not changes to the baseline branch.

## Deliberately unchanged

Fix 21 is a proposed product change to collapse settings cards, explicitly reserved for a separate decision in the brief. Cards remain expanded, with their long traveller lists paged. Expense transaction-date ordering and expense day headings remain unchanged. Invitation server pagination still needs a cursor API. Token values between exact matches remain unchanged; the inventory identifies them rather than silently rounding typography or spacing.

A physical iPhone/VoiceOver check cannot be performed in this environment. WebKit and visual-viewport keyboard emulation cover the automated portion; they do not establish real-device Safari or VoiceOver behavior.
