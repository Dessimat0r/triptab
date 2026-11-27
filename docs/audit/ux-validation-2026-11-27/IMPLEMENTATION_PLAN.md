# TripTab: prioritised implementation plan

Hand-off briefs for an implementation agent, based on `CONSOLIDATED_FINDINGS.md` (32 findings). Commit baseline: `963d7c8`.

## Ground rules for every PR

1. **Financial invariants are out of scope for change.** Keep integer hundredths, allocation, penny ordering, offer-rule evaluation, conversion semantics, saved financial format, revision checks and audit history exactly as they are. Any PR touching `lib/model.ts`, `lib/adjustments.ts`, `lib/receipt-scan.ts`, `lib/import-ledger.ts` or saved-data shapes needs independent review.
2. **Run the full gates:** `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `npm run test:layout` in **both** Chromium and WebKit (CI already does this).
3. **Use the repro script as acceptance evidence.** `node docs/audit/ux-validation-2026-11-27/evidence/repro/opus-repro.mjs http://127.0.0.1:8787 <out>` must change the PR's scenario from `DEFECT PRESENT` to `not observed`, while the others are unchanged. Convert the scenario into a permanent Playwright test in the PR.
4. **Small PRs.** One finding group per PR. Don't redesign surfaces beyond the stated scope, and keep the existing visual identity.
5. **Device checks.** Items marked 📱 need the matching manual test in `MANUAL_ACCEPTANCE_TESTS.md` before release (not before merge).

## Overview and order

| Wave | PR | Findings | Severity | Size | Independent review before merge |
|---|---|---|---|---|---|
| 1 · Data integrity, financial correctness, recoverability | **PR-01** Block Save while a discount/charge is pending | TT-03 | High | S–M | **Yes** (financial) |
| | **PR-02** Payment editor dirty guard | TT-02 | High | S | **Yes** (financial records) |
| | **PR-03** Remember the active holiday | OP-01 | High | S | Standard |
| | **PR-04** Repair the offline fallback 📱 | TT-09 | High | S (+M test infra) | **Yes** (service worker reaches every client) |
| | **PR-05** One clear discount summary | OP-02 | Medium | S | **Yes** (financial UI) |
| | **PR-06** CSV import participant preview | TT-21 | Medium | S–M | **Yes** (financial import) |
| | **PR-07** Durable editor drafts and re-auth resume 📱 | TT-07 | High | M–L | **Yes** (+ privacy review) |
| 2 · High-impact functional usability | **PR-08** Invitation handoff and auth entry | TT-04, OP-05 | High / Low | S | Standard |
| | **PR-09** Back closes the top dialog 📱 | TT-12 | Medium | M | **Yes** (history and deep links) |
| | **PR-10** Error states that explain and recover | TT-10, OP-03, TT-15, TT-08 | Medium / Low | M | Standard |
| | **PR-11** Receipt capture and manual lines | OP-04, TT-11 | Medium / Low | S–M | Standard |
| 3 · Accessibility | **PR-12** Keyboard focus stays visible in modals 📱 | TT-01 | High | S (+M tests) | **Yes** (shared modal primitive, iOS keyboard history) |
| | **PR-13** Accessibility quick wins | TT-16, TT-20, OP-07 | Low | S | Standard |
| 4 · Mobile and responsive | **PR-14** Mobile chrome, navigation and text scaling 📱 | TT-05, TT-06, TT-17, OP-08 | Medium / Low | M | **Yes** (broad layout) |
| 5 · Workflow efficiency | **PR-15** Localisation completeness | TT-13, TT-14 | Medium | M | Standard |
| | **PR-16** Long receipt navigation | TT-18 | Medium | M | Standard |
| 6 · Visual consistency and polish | **PR-17** Balance emphasis, IA and polish | TT-19, OP-06, OP-09, OP-10, OP-11 | Low | M (may split) | Standard |

**Parallelism.** PR-01, 02, 03, 04, 08 and 12 are independent quick wins and can start on day one. PR-07 should begin with a short design note (draft keys, retention, privacy) while the quick wins land. PR-09 waits for PR-02 and PR-07.

**Quick wins (≤ half a day each, high value):** PR-01, PR-02, PR-03, PR-04 (code part), PR-08, PR-12 (code part), TT-13 (can be split out of PR-15), TT-16, TT-20, TT-17.

**Shared building blocks to create once:**
- `useDirtyClose(initial, current, onClose)`: dirty comparison plus `ConfirmationDialog`, reused by the payment editor (PR-02), Back handling (PR-09) and any future editor.
- **Generalised draft store**: extend `lib/unsaved-entry.ts` from new-expense drafts to saved-expense, receipt-draft and payment drafts (PR-07).
- **Split error channels**: `ledgerError` (page banner with Retry updates) versus `operationError` (scoped to the dialog) (PR-10).

**Dependency graph**

```
PR-01 ─► PR-05
PR-02 ─┐
PR-07 ─┴► PR-09
PR-03 ··► (URL follow-up later helps PR-09)
PR-10 (TT-15 depends on OP-03's error split, same PR)
PR-11 ─► PR-16
PR-14 ◄─► PR-17 (OP-06 moves offline setup and holiday admin; coordinate)
```

---

## Wave 1 · Data integrity, financial correctness and recoverability

### PR-01 · Block Save while a discount or charge is pending (TT-03)

- **Scope:** `lib/expense-readiness.ts` (add `adjustmentPending?: boolean` to `ExpenseSaveState` and a blocker "Add or cancel the discount you're editing" targeting the form's Add/Update button). `components/trip-app.tsx` (pass `!!adjustmentDraft` and whether the form is non-empty). `components/adjustment-editor.tsx` (label the result "Preview — not applied yet"; report "non-empty" to the parent via `onDraft`). Footer total shows "(preview €X)" while pending.
- **Out of scope:** auto-applying the preview; any change to `previewAdjustment` or adjustment maths.
- **Acceptance criteria:**
  - A valid pending new discount or charge (amount, percent, offer rule) blocks Save. The "Before saving" list names it and focus moves to *Add*.
  - A pending **edit** of an existing discount blocks Save the same way.
  - An untouched, empty draft is cancelled silently and does not block.
  - After *Add*, Save persists exactly the previewed total. After *Cancel*, it persists the original.
  - Repro `TT-03` and `TT-03b` report `not observed`.
- **Regression tests:** Unit tests for the new blocker. Browser tests (Chromium + WebKit, 390 and 1440): the cases above plus the receipt-review path with printed-total reconciliation, BOGOF rule and keyboard Enter. Existing `adjustments`, `adjustment-preview`, `receipt-offer-rules` and `expense-readiness` suites green.
- **Risks:** Over-blocking if "non-empty" detection is wrong. Test the empty-draft case explicitly.
- **Review:** Independent (financial intent).

### PR-02 · Payment editor dirty guard (TT-02)

- **Scope:** `components/payment-editor.tsx` (dirty comparison against `initial`; the Review step always counts as dirty; Escape and × go through `ConfirmationDialog`: "Discard this payment? It hasn't been recorded." with *Keep editing* focused). Introduce the reusable `useDirtyClose`. Optional `beforeunload` while dirty.
- **Acceptance criteria:** Untouched close is immediate. Dirty entry and the Review step ask first. *Keep editing* preserves every field. *Discard* writes nothing. *Confirm payment* still writes exactly once. The in-flight lock disables close. Repro `TT-02` reports `not observed`.
- **Regression tests:** Escape and × in each state; failed save keeps the form; edit-existing payment and the "Compare changed payment" conflict flow unchanged; double-click Confirm records once.
- **Review:** Independent (records money movements; small diff).

### PR-03 · Remember the active holiday (OP-01)

- **Scope:** `components/trip-app.tsx`. Persist `selected` per account through `safeStorage()` (key `triptab:selected:{accountId}`). On load, use it if the trip is still in the ledger and accessible, otherwise fall back as today. Clear it on sign-out and when a trip is removed, archived or left. Invitation join, import and sample creation keep setting `selected` explicitly. *Follow-up (separate PR):* encode the trip in the URL.
- **Acceptance criteria:** Reload, a new tab and a relaunch keep the current holiday or bill. A different account on the same browser starts at its own default. Deep links with `receiptTrip` win. Repro `OP-01` reports `not observed`.
- **Regression tests:** Two-holiday reload; bill selection; archived or deleted trip fallback; account switch; storage unavailable (private mode) falls back to `trips[0]`.
- **Review:** Standard.

### PR-04 · Repair the offline fallback (TT-09) 📱

- **Scope:** `public/sw.js` (precache and serve `/offline`, the canonical non-redirecting URL, or store a non-redirected copy; bump `CACHE_NAME` to `triptab-public-v8`). `components/offline-capture.tsx:290` (link to `/offline`). Add a Playwright project with `serviceWorkers: 'allow'` running one cold-offline spec against the built Worker.
- **Acceptance criteria:** `caches.match(OFFLINE_URL).redirected === false`. Offline reload, cold navigation to `/expenses` and *Open capture form* all render "You're offline" and the capture form. One expense queued offline syncs exactly once after reconnect. No authenticated route or API response appears in Cache Storage. Repro `TT-09` reports `not observed`.
- **Before release:** On TripTab Staging, `curl -I https://<staging>/offline.html` and `/offline` (MAT-01). Cold-open an installed PWA offline on iOS and Android (MAT-02).
- **Risks:** Old v7 caches persist until the new worker activates; the version bump handles this. Share-target POST must still work, so keep its test.
- **Review:** Independent.

### PR-05 · One clear discount summary (OP-02)

- **Scope:** `components/trip-app.tsx` and `components/adjustment-editor.tsx`. List flat tax/tip/discount amounts inside the "Discounts and charges" summary with a combined total. Show an inline notice when both a flat discount and a structured discount exist ("2 discounts applied: −€12.00"). Rename the accessible labels to match the visible text ("Added tax", "Tip / service", "Discount").
- **Out of scope:** removing or migrating the flat fields; that needs a product decision and a data-model review.
- **Acceptance criteria:** The summary total equals the posted total in every combination. The notice appears only for double discounts. Accessible names match the labels (WCAG 2.5.3). Repro `OP-02` still shows €48 (the arithmetic is intended), but the screen now shows the combined summary and notice.
- **Review:** Independent (financial UI wording).

### PR-06 · CSV import participant preview (TT-21)

- **Scope:** `components/import-holiday.tsx` (separator guidance; a preview table of the first N rows with parsed people and exact shares; a warning when a participant name contains a comma and matches two known names). No grammar change in `lib/import-ledger.ts` unless approved.
- **Acceptance criteria:** Sol's comma row shows a warning and a preview of one combined participant. The semicolon row previews two people at £5.00. Splitwise and JSON imports are unchanged.
- **Review:** Independent (financial import).

### PR-07 · Durable editor drafts and re-auth resume (TT-07) 📱

- **Design note first (short):** draft key (`account / trip / kind / recordId`), stored baseline (revision plus financial snapshot), retention (until save, discard, sign-out or 7 days), and shared-device privacy (drafts are cleared on sign-out; never shown to another account).
- **Scope:** `lib/unsaved-entry.ts` (generalise to `expense-edit`, `receipt-draft` and `payment`). `components/trip-app.tsx` (write drafts for saved-expense and receipt-draft editors; on load and after same-account sign-in, offer *Resume*; rehydrate through the existing conflict comparison and merge UI; stop discarding drafts in `accountAuthenticated` (`:663-664`); correct the "kept separate" banner copy at `:2941`). `components/payment-editor.tsx` (persist a dirty payment).
- **Acceptance criteria:** For each editor type, a fresh tab after edits offers *Resume*, and resuming restores every field. If the server record changed, the merge UI appears. Same-account re-auth after *Sign out other browsers* offers *Resume*. A different account never sees the draft. Revoked membership drops it. Repro `TT-07` reports `not observed`.
- **Regression tests:** The above, plus: storage unavailable degrades gracefully; saving clears the draft; new-expense F-18 behaviour unchanged; no draft content in exports, history or logs.
- **Risks:** Stale drafts resurrecting old values are mitigated by the baseline comparison. There is a privacy risk on shared devices, so independent and privacy review are required.

---

## Wave 2 · High-impact functional usability

### PR-08 · Invitation handoff and auth entry (TT-04, OP-05)

- **Scope:** `components/trip-app.tsx` / `components/trip-sharing.tsx`. When a `JoinTrip` preview first appears after authentication, scroll it into view below the sticky header (respect reduced motion) and focus its heading, once per invitation. `components/auth-panel.tsx`: invite CTA defaults to *Create account*; the session-loss screen defaults to *Sign in*; informational states use `role="status"` with neutral styling.
- **Acceptance criteria:** After registering or signing in from an invite at 390×844, 320×568 and 844×390, the "Join {holiday}" heading is visible and focused. A background refresh doesn't re-scroll. A brand-new invitee sees the account-creation form after one tap. A returning, signed-out user sees Sign in.
- **Review:** Standard.

### PR-09 · Back closes the top dialog (TT-12) 📱

- **Scope:** `lib/trip-navigation.ts`, `components/trip-app.tsx`, `components/payment-editor.tsx`. Push a history entry when a user opens an editor. `popstate` requests the normal close path (dirty guard from PR-02 and the expense editor). *Keep editing* restores the entry. A programmatic close pops the entry only if it is current. Deep-link dialogs keep their URLs.
- **Acceptance criteria:** Back closes an untouched editor without changing the section. Back on a dirty editor asks first. Forward, nested confirmation, holiday switching and deep links behave as before.
- **Depends on:** PR-02, PR-07.
- **Review:** Independent; physical Android Back and iOS swipe (MAT-03).

### PR-10 · Error states that explain and recover (TT-10, OP-03, TT-15, TT-08)

- **Scope:** `components/trip-app.tsx`. Split `ledgerError` from `operationError`. Show `initialLoad` pending or failed states instead of onboarding (TT-10). Show operation errors next to the failing control or footer, announced, in plain language, with a retry that repeats the operation (OP-03). Trim and validate the holiday name client-side with `aria-invalid` and focus (TT-15). `components/receipt-photo-viewer.tsx` plus the thumbnail: loading, loaded and failed states with *Try again* (TT-08).
- **Acceptance criteria:** An initial 503 shows a retry panel and no enabled *Create your first holiday*. An upload failure shows a visible, scoped "Upload failed…" with a working *Try again*, and the page banner is untouched. A whitespace holiday name shows a field-level error. A 404 image shows an explanation, and zoom controls are disabled. Repro `OP-03` reports `not observed`.
- **Review:** Standard.

### PR-11 · Receipt capture and manual lines (OP-04, TT-11)

- **Scope:** Keep receipts in itemised mode after the first manual line, or show *Add another line*, and focus the new line (OP-04). Label capture by reader status and use one verb set across Expenses, Inbox and Bill (TT-11). Optional: open the file picker directly from the main *Scan receipt*.
- **Acceptance criteria:** Ten lines can be added to an unprocessed receipt without touching the split method. When the reader is unavailable, entry points say "Add receipt photo" and explain that manual entry follows. The configured path keeps its one-step scan.
- **Review:** Standard.

---

## Wave 3 · Accessibility

### PR-12 · Keyboard focus stays visible in modals (TT-01) 📱

- **Scope:** `components/modal-accessibility.tsx:81-93`. After `elements[next].focus({ preventScroll: true })`, call `elements[next].scrollIntoView({ block: 'nearest', inline: 'nearest' })`. Keep `preventScroll` for initial focus and focus restoration. Confirm `scroll-padding-bottom` uses `--editor-footer-height` in every editor scroller.
- **Acceptance criteria:** For forward and reverse Tab through Settings, the expense/receipt editor, the payment editor and Create holiday, at 390×844, 844×390 and 1280×860 in Chromium and WebKit, every focused element is inside the dialog's visible area and not under the sticky footer. The page behind doesn't scroll. Repro `TT-01` reports `not observed`.
- **Regression tests:** New cross-engine focus-visibility spec. Existing simulated-keyboard geometry and drawer focus-restoration specs stay green.
- **Risks:** Reviving the earlier iOS keyboard pointer-jump defect. The change only affects the keyboard Tab path, but verify on a physical iPhone (MAT-05).
- **Review:** Independent (shared primitive).

### PR-13 · Accessibility quick wins (TT-16, TT-20, OP-07)

- **Scope:** Higher-contrast token for "Email not verified" (≥ 4.5:1). Set `aria-controls` only when the Receipt history panel exists (or render a hidden target). Add a visible-on-focus skip link to the main content.
- **Acceptance criteria:** axe reports no violations for these three in light and dark. Skip link is the first Tab stop and moves focus to the holiday heading.
- **Review:** Standard.

---

## Wave 4 · Mobile and responsive

### PR-14 · Mobile chrome, navigation and text scaling (TT-05, TT-06, TT-17, OP-08) 📱

- **Scope:** Bottom bar allows label wrap or truncation and height growth at large text (TT-05). Compact context header on non-Expenses mobile routes, plus a persistent add action above the tab bar (TT-06). Two flexible columns for bill tabs (TT-17). Drawer/sidebar actions as icons with single-line labels in a 2×2 grid (OP-08). Fix the existing enlargement test so it asserts computed font size and per-label rectangles.
- **Acceptance criteria:** At 320×568 each section heading is visible above the tab bar after switching tabs. At 200% text no nav labels overlap or clip (320/390/768, EN/FR/DE). The bill bar uses its full width. Desktop rail unchanged.
- **Coordinate with:** PR-17 (OP-06 moves offline setup and holiday administration).
- **Review:** Independent (broad visual surface); manual MAT-06 and MAT-07.

---

## Wave 5 · Workflow efficiency

### PR-15 · Localisation completeness (TT-13, TT-14)

- **Scope:** `components/payment-editor.tsx:50` uses `formatMoney` and localised dates (TT-13; split out as a quick win if useful). Wrap the discount, charge and offer strings and "Remind {name}" in `uiText` with ES/FR/DE translations (TT-14). Add a locale smoke test that fails on known English literals in these components.
- **Acceptance criteria:** French payment review shows `67,33 €`. The French discount/charge/offer form has no English strings. Saved rule identities don't change with language.

### PR-16 · Long receipt navigation (TT-18)

- **Scope:** Collapse manually added lines when focus leaves them. Add a compact "Photo & totals" jump plus "Back to line N".
- **Acceptance criteria:** 30 manual lines produce roughly the same height as 30 scanned lines (compact). The jump and return preserve focus. No change to line order or calculations.
- **Depends on:** PR-11.

---

## Wave 6 · Visual consistency and polish

### PR-17 · Balance emphasis, IA and polish (TT-19, OP-06, OP-09, OP-10, OP-11)

- **Scope:** "You owe / You're owed / You're settled" in the balance summary, and state-aware card colour (TT-19). Move holiday administration (details, language, archive/transfer/delete, export, offline setup) from Travellers to a *Holiday settings* sheet, and remove the invite form from History (OP-06). Minimal signed-out chrome, with data requests gated on the profile check (OP-09). Clear offline save errors on `online` (OP-10). Conflict copy, merged identical choices and a baseline reset after *Keep their version* (OP-11).
- **May split** into: (a) TT-19, (b) OP-06, (c) OP-09/10/11.
- **Acceptance criteria:** The Travellers page at 390 px roughly halves in height. History opens on Activity. No `401` console errors on a signed-out landing. Closing after *Keep their version* doesn't prompt.

---

## After all PRs: release checklist

- Repro script: all scenarios `not observed`; permanent Playwright equivalents exist.
- `MANUAL_ACCEPTANCE_TESTS.md`: MAT-01 to MAT-12 executed on the stated devices, with results recorded in the release note.
- Staging deploy of the candidate SHA, following `docs/testing-and-staging.md`; production only after owner approval.
