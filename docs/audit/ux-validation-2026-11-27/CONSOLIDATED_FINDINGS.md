# TripTab: consolidated findings register

The single authoritative register combining Sol's audit (21 findings, `TT-xx`) and this independent review (11 new findings, `OP-xx`). Commit under test: `963d7c84b1a8` (`main`). Review date: 27 November 2026.

- **Origin:** *Sol* (original audit only), *Opus* (this review only) or *Both* (found independently by both, or Sol's finding with material additions from this review).
- **Verdict** applies to Sol's findings: Confirmed · Confirmed with amendments · Duplicate · Not reproduced · Disputed. New findings are marked *New (reproduced)*.
- **Severity:** High · Medium · Low. Sol's P1/P2/P3 map to High/Medium/Low, and the original is shown where it changed. No finding is Critical: no saved data was corrupted and no balance was miscalculated in any exercised case.
- **Complexity:** S (contained change), M (shared primitive or workflow plus regression coverage), L (multi-surface state or deployment work).
- **Evidence paths** are relative to this folder. "Sol bundle" refers to Sol's `triptab-audit.zip` (`evidence/…`), which is not committed here; SHA-256 checksums are recorded in `INDEPENDENT_REVIEW.md` §2. "Repro" refers to `evidence/repro/opus-repro.mjs`, a standalone script that reports whether each scripted defect is present. Line numbers refer to commit `963d7c8`.

## Summary register

| ID | Origin | Verdict | Final severity | Title | PR |
|---|---|---|---|---|---|
| TT-03 | Both | Confirmed with amendments | **High** | Save silently drops a valid, previewed discount or charge that has not been applied, including edits to an existing discount | PR-01 |
| TT-02 | Both | Confirmed with amendments | **High** | Closing a dirty payment editor (Escape, ×, even from Review) discards it without confirmation | PR-02 |
| OP-01 | Opus | New (reproduced) | **High** | Reload or relaunch switches to the first holiday instead of the one in use | PR-03 |
| TT-09 | Both | Confirmed with amendments | **High** | Offline navigation always fails: the service worker serves a redirected cached response | PR-04 |
| TT-07 | Both | Confirmed with amendments | **High** | Edits to saved expenses, receipt drafts and payments are memory-only and are lost on reload, tab discard or reauthentication | PR-07 |
| TT-04 | Both | Confirmed | **High** | After registering from an invite, the Join confirmation is above the viewport and focus is lost | PR-08 |
| TT-01 | Both | Confirmed with amendments | **High** | Every long modal moves keyboard focus outside the visible area (shared focus trap uses `preventScroll`) | PR-12 |
| OP-02 | Opus | New (reproduced) | Medium | Flat Tax/Tip/Discount fields and structured discounts stack silently; flat fields' accessible names don't match their labels | PR-05 |
| TT-21 | Sol | Confirmed | Medium | CSV import treats a comma-separated "Shared by" as one participant, with no share preview | PR-06 |
| TT-12 | Both | Confirmed with amendments | Medium | Browser/system Back changes the section under an open expense or payment editor instead of closing it | PR-09 |
| TT-10 | Sol | Confirmed | Medium | A first-load failure shows "Create your first holiday" to a returning user | PR-10 |
| OP-03 | Opus | New (reproduced) | Medium | Operation errors are raw ("Failed to fetch", schema paths), duplicated into the page banner with an unrelated "Retry updates", and shown below the fold in editors | PR-10 |
| TT-08 | Sol | Confirmed | Medium | A missing receipt image opens an empty zoom viewer with no explanation or retry | PR-10 |
| OP-04 | Opus | New (reproduced) | Medium | Manual receipt entry hides "Add item" after the first line (needs "By item"); focus is lost after Add item | PR-11 |
| TT-14 | Sol | Confirmed with amendments | Medium | Discount, charge and offer controls (and "Remind {name}") are largely untranslated in French | PR-15 |
| TT-13 | Sol | Confirmed | Medium | Payment review switches French currency notation to UK notation | PR-15 |
| TT-05 | Sol | Confirmed | Medium | Bottom-navigation labels overlap and clip at 200% text | PR-14 |
| TT-06 | Both | Confirmed with amendments | Medium | Repeated trip header pushes the selected section below the fold on small phones; no add action after scrolling | PR-14 |
| TT-18 | Sol | Confirmed with amendments | Medium | Long receipts have no persistent way back to the photo or totals; manual lines stay expanded and double the length | PR-16 |
| TT-11 | Both | Confirmed with amendments | Low (was P2) | "Scan receipt" promises scanning when the reader is unavailable; inconsistent "Add receipt"; scan takes two taps | PR-11 |
| TT-15 | Sol | Confirmed with amendments | Low (was P2) | A whitespace-only holiday name shows a raw schema error, unlinked to the field and duplicated in the page banner | PR-10 |
| TT-16 | Sol | Confirmed | Low | "Email not verified" text contrast 4.43:1 (below 4.5:1) | PR-13 |
| TT-17 | Sol | Confirmed | Low | Two bill tabs are packed into the left of a five-column bar | PR-14 |
| TT-19 | Both | Confirmed with amendments | Low | Balances emphasise group totals over "my position"; "Still to settle" card is green regardless of state (design enhancement) | PR-17 |
| TT-20 | Sol | Confirmed | Low | Receipt History button's `aria-controls` points to an absent element while closed | PR-13 |
| OP-05 | Opus | New (reproduced) | Low | Auth entry defaults: invite CTA opens Sign in; signed-out-after-session-loss screen defaults to Create account; normal states use error-styled alerts | PR-08 |
| OP-06 | Opus | New (reproduced) | Low | Travellers tab is a catch-all (≈6,300 px at 390 px); History tab opens with the invite form | PR-17 |
| OP-07 | Opus | New (reproduced) | Low | No skip link; 9 sidebar tab stops precede the main content on desktop | PR-13 |
| OP-08 | Opus | New (reproduced) | Low | Drawer/sidebar action row wraps into 2–3-line text buttons ("Split / a / bill") | PR-14 |
| OP-09 | Opus | New (reproduced) | Low | Signed-out visitors see signed-in chrome; 3–15 console 401s per visit | PR-17 |
| OP-10 | Opus | New (reproduced) | Low | "You're offline. Reconnect to save" persists after reconnection | PR-17 |
| OP-11 | Opus | New (reproduced) | Low | Conflict-resolution polish: "Another traveller" for the same account, duplicate Name/Description choice, false dirty state after "Keep their version" | PR-17 |

Totals: **32 findings. 7 High, 12 Medium, 13 Low.** Sol's 21: 6 High, 9 Medium, 6 Low after review. New: 1 High, 3 Medium, 7 Low.

## Shared root causes

| Code | Root cause | Findings |
|---|---|---|
| RC-A | Editor state is memory-only, and the close, Back and re-auth paths do not share one dirty guard | TT-02, TT-07, TT-12 |
| RC-B | A pending sub-form (discount/charge) is invisible to the Save blockers | TT-03 |
| RC-C | Shared focus trap moves focus with `preventScroll: true` | TT-01 |
| RC-D | Navigation state (active holiday, open dialog) is in neither the URL, history nor storage | OP-01, TT-12 |
| RC-E | One global error channel mixes ledger-refresh failures with operation errors and empty states | TT-10, OP-03, TT-15 |
| RC-F | Literal UI strings and a hardcoded `en-GB` formatter bypass localisation | TT-13, TT-14 |
| RC-G | Layout assumes normal text size and full trip chrome on every route | TT-05, TT-06, TT-17, OP-08 |
| RC-H | Service worker caches a redirected asset response | TT-09 |
| RC-I | Two discount entry models with no combined summary | OP-02, TT-03 |

---

## High

### TT-03 · Save silently drops a valid, previewed discount or charge that has not been applied

- **Origin:** Both. Independently reproduced as IO-01; this area was flagged in the brief, so the discovery was primed.
- **Verdict:** Confirmed with amendments. Amendment: the same loss happens when **editing an existing discount** (preview "New total €36.00", Save keeps €39.00). Recommended fix narrowed to the existing blocker mechanism.
- **Severity:** High (unchanged). Recommend it as the first PR.
- **Affected:** Expense editor (quick and itemised), receipt review → *Tip, tax or discount* → *Add discount / Add charge*, and *Edit {discount}*.
- **Reproduce:** 390×844. *Add expense* → name "Groceries", amount 60 → *Tip, tax or discount* → *Add discount* → amount 6, *Whole receipt* → the form shows "New total €54.00 · −€2.00 each". Do **not** press the inline *Add*. Press the pinned *Save expense*. Variant: save a discount of 6, reopen the expense, *Edit Student*, change it to 9 (preview "New total €36.00"), press *Save expense*.
- **Observed:** The editor closes with a "Saved" banner. The expense is saved at €60.00 / €20.00 each (variant: €39.00, old discount). No prompt or warning. The footer said "Total €60.00" while the form said "New total €54.00".
- **Evidence:** `evidence/independent/19-discount-filled-not-added-390.png`, `20-…`, `21-…`; `evidence/validation/66-edit-existing-discount-pending-390.png`; Repro `TT-03`, `TT-03b` (`evidence/repro/sample-output/results.json`, `TT-03-pending-preview.png`); Sol bundle `TT-03-chromium-unapplied-discount.png`, `TT-03-webkit-unapplied-discount.png`.
- **Root cause:** The discount form state lives in `AdjustmentForm` local state (`components/adjustment-editor.tsx:96-136`). The parent only holds `adjustmentDraft` (`components/trip-app.tsx:323`). `submitExpense` (`trip-app.tsx:1631-1641`) builds blockers from `expenseSaveBlockers(…)` without any knowledge of an open draft, so Save proceeds.
- **Fix:** While `adjustmentDraft` is non-null, add a Save blocker to the existing "Before saving" list: "Add or cancel the discount you're editing". It should focus the form's *Add/Update* button. Label the inline result "Preview — not applied yet" and make the footer show "Total €60.00 (preview €54.00)" until applied. An untouched, empty draft can be silently cancelled on Save. Do **not** auto-apply (Sol's caution is right). Keep ordered rules, offer-rule evaluation, allocation and reconciliation unchanged.
- **Source:** `components/adjustment-editor.tsx`, `components/trip-app.tsx` (`submitExpense`, `adjustmentDraft`), `lib/expense-readiness.ts` (`expenseSaveBlockers` at `:58` takes an `ExpenseSaveState`; add an `adjustmentPending` flag beside `conflict`, `offline` and `uploading`).
- **Complexity:** S–M.
- **Regression tests:** Valid pending new discount blocks Save and focuses Add. Valid pending edit of an existing discount blocks Save. An empty untouched draft does not block. An invalid pending draft blocks with its own error. Keyboard Enter-to-save path. After Add, Save posts exactly the previewed total (integer hundredths). After Cancel, Save posts the original total. Offer-rule (BOGOF) and charge variants. Receipt-review path with printed-total reconciliation. Existing `tests/adjustments.test.ts`, `tests/adjustment-preview.test.ts` and offer-rule suites stay green.
- **Dependencies:** None. Pair with OP-02 (PR-05) for overall discount clarity.

### TT-02 · Closing a dirty payment editor discards it without confirmation

- **Origin:** Both (IO-02, primed).
- **Verdict:** Confirmed with amendments. Amendments: the × button behaves like Escape, and **closing from the Review step** (which shows "Bob paid Alice €10.00") also discards silently, with no "not recorded" notice. A user can believe a real transfer was recorded, which raises the risk from re-typing to an unrecorded payment. Back (TT-12) and re-auth (TT-07) are further loss paths.
- **Severity:** High (unchanged).
- **Affected:** Balances → *Record paid* / *Record payment*, *Edit* on a recorded payment; `PaymentEditor` entry and review states.
- **Reproduce:** Balances → *Record paid* → change the amount and add a note → Escape (or ×). Reopen: the defaults are back. Variant: → *Review payment* → × → the dialog closes and the payments list is unchanged.
- **Evidence:** `evidence/independent/10-record-paid-390.png`; `evidence/validation/61-payment-review-before-close-390.png`; Repro `TT-02`; Sol bundle `TT-02-payment-dirty.png`, `TT-02-payment-reopened.png`.
- **Root cause:** `components/payment-editor.tsx:92` (`ModalA11y onClose={() => { if (!locked) onClose(); }}`) and `:99` (× `onClick={onClose}`) close with no dirty comparison. The expense editor's guard is not shared.
- **Fix:** Compare the current fields (and review state) with the initial payment. If dirty, reuse `ConfirmationDialog` ("Discard this payment? It hasn't been recorded."). Treat the Review step as always dirty. Keep the in-flight lock. Optional: register `beforeunload` while dirty, like the expense editor.
- **Source:** `components/payment-editor.tsx`, `components/confirmation-dialog.tsx`, `components/trip-app.tsx` (payment editor state).
- **Complexity:** S.
- **Regression tests:** Escape and × on untouched (closes), dirty entry (confirm), and Review step (confirm). Keep editing restores fields. Discard closes with no write. Confirm payment writes exactly once (double-click). Failed save keeps the form. Edit-existing-payment conflict path ("Compare changed payment") unchanged.
- **Dependencies:** Shares the guard with TT-12 (PR-09) and TT-07 (PR-07). Build it as a reusable `useDirtyClose` helper.

### OP-01 · Reload or relaunch switches to the first holiday instead of the one in use

- **Origin:** Opus (new).
- **Verdict:** New (reproduced). Repro `OP-01`.
- **Severity:** High. For any user with two or more holidays or bills (bills are trips too), every reload, PWA relaunch, OS tab discard or session restore silently opens `ledger.trips[0]`, the first-created trip. Travellers are often shared between trips, so the quick form looks plausible, and an expense can be recorded in the wrong (possibly already-settled) ledger.
- **Affected:** All holiday routes (`/expenses`, `/balances`, …), the holiday drawer, and any deep link without `receiptTrip`.
- **Reproduce:** Have two holidays. Open the second (newest, or the one with the most recent activity). Reload. The first-created holiday is shown, and the URL (`/expenses`) is unchanged.
- **Evidence:** `evidence/repro/sample-output/OP-01-after-reload.png`, Repro `OP-01` (`before: "Second Trip", after: "Repro Trip"`). The session log also showed recency doesn't matter: the switch happens even after adding an expense to the second holiday.
- **Root cause:** `components/trip-app.tsx:266` (`[selected, setSelected] = useState("")`) is never persisted. `:393` falls back to `ledger.trips[0]`. Routes (`lib/trip-routes.ts`) don't encode the trip.
- **Fix:** Persist the selected trip ID per account (e.g. `localStorage` key `triptab:selected:{accountId}`, read through the existing `safeStorage()`), validated against the current ledger on load and cleared when the trip is removed. A trip-scoped URL (`?trip=` or `/t/{id}/…`) is the more robust follow-up because it also fixes shared links and TT-12 history, but it's larger.
- **Source:** `components/trip-app.tsx`, `lib/trip-navigation.ts`, `lib/trip-routes.ts`.
- **Complexity:** S (storage) / M (URL).
- **Regression tests:** Reload, a new tab and a relaunch keep the selected holiday or bill. An archived, deleted or left trip falls back gracefully. A different account on the same device doesn't inherit the selection. Invitation join and import still select the new trip. Deep links with `receiptTrip` still win.
- **Dependencies:** None. Complements TT-12 (PR-09).

### TT-09 · Offline navigation always fails: the service worker serves a redirected cached response

- **Origin:** Both (IO-04, primed).
- **Verdict:** Confirmed with amendments. Amendment: **probably not limited to the "packaged local Worker"**. The generated Wrangler config uses Workers Static Assets with default HTML handling (`dist/server/wrangler.json`: `assets: { directory }`), which issues `307 /offline.html → /offline`. If Sites deploys this output on Workers Static Assets (likely, not verified), hosted users who enabled *Offline expense capture* get a blank browser error page whenever they open TripTab offline. The fix is safe either way. Verify on staging first (see `MANUAL_ACCEPTANCE_TESTS.md` MAT-01).
- **Severity:** High (unchanged; potentially broader than reported).
- **Affected:** Service worker navigation fallback, `/offline.html` capture form, the *Open capture form* link, and installed-PWA cold start.
- **Reproduce:** Enable *Offline expense capture* (Travellers), wait for SW control, confirm `caches.match('/offline.html')` returns `{redirected: true, url: '/offline'}`, go offline, then reload or open `/expenses` or the *Open capture form* link. The result is `net::ERR_FAILED` and a blank error page.
- **Evidence:** `evidence/independent/49-offline-open-app-error-390.png`; Repro `TT-09`; Sol bundle `TT-09-offline-chromium.png`, `offline-service-worker.json` (Sol's control: the same bytes without the redirect flag load correctly).
- **Root cause:** `public/sw.js:3-14,19-22` precaches `'/offline.html'` with `cache.addAll`, which stores the final redirected response. `:65` returns it for navigations, and browsers reject redirected responses for navigation requests. The CI browser suite runs with `serviceWorkers: 'block'` (`tests/browser/playwright.config.ts`), so nothing exercises this.
- **Fix (simplest):** Precache and serve the canonical, non-redirecting URL `/offline` (and point `components/offline-capture.tsx:290` at it). Alternatively, store `new Response(await res.blob(), { headers: res.headers, status: 200 })`. Bump `CACHE_NAME` to `triptab-public-v8` so existing installs replace the poisoned entry. Keep authenticated data out of Cache Storage. Add one Playwright project with service workers **enabled** for a cold-offline test.
- **Source:** `public/sw.js`, `components/offline-capture.tsx`, `tests/browser/playwright.config.ts`.
- **Complexity:** S (fix) + M (SW-enabled test project and staging verification).
- **Regression tests:** Cache entry `redirected === false`. Offline reload, cold navigation and *Open capture form* show the capture form. A queued offline expense syncs exactly once after reconnect. An updated SW replaces v7 caches. Authenticated routes are never served from cache. Share-target POST still works.
- **Dependencies:** None. Manual device check MAT-01/MAT-02.

### TT-07 · Edits to saved expenses, receipt drafts and payments are memory-only

- **Origin:** Both. Sol found the re-auth trigger; this review found the broader scope.
- **Verdict:** Confirmed with amendments. Amendments:
  1. **Trigger scope:** not only session expiry. Any page reload, crash, OS tab discard (common on phones when switching to the camera or a banking app) or Back-exit loses edits. Reproduced realistically via *Sign out other browsers* from a second device, and via a fresh page in the same browser context.
  2. **Affected editors:** saved expenses, **receipt drafts** (manual corrections aren't autosaved: a fresh page shows the draft untouched) and **payments**. Only *new* manual expenses are persisted (F-18) and offered for *Resume*.
  3. **Misleading copy:** after a 401 the banner says the open form "has been kept separate", but `accountAuthenticated` then discards it.
- **Severity:** High (unchanged; broader).
- **Affected:** Expense editor (saved expenses), receipt review drafts, payment editor, session-loss screen.
- **Reproduce:** (a) Open a saved expense, change the name and amount, then open TripTab in another tab: no resume. Compare a new unsaved expense, which shows "Unsaved expense … Resume / Discard". (b) With edits open, another device uses *Sign out other browsers*. Device 1 shows "no longer available in this view… kept separate". Sign in again: the editor is closed and the reopened expense has its old values.
- **Evidence:** `evidence/validation/63-device1-after-session-revoked-390.png`, `64-device1-after-reauth-390.png`, `65-new-expense-resume-offer-390.png`; Repro `TT-07` (`resumeExisting: 0`, `resumeNewControl: 1`); Sol bundle `TT-07-session-expiry.png`, `native-supplement.json`.
- **Root cause:** `components/trip-app.tsx:1910-1918` persists only new manual expenses (it explicitly skips `receiptId`, `draftId`, `receiptScan` and saved IDs). `:663-664` (`accountAuthenticated`) unconditionally calls `setEditing(null)` and `setPaymentEditor(null)`. The banner at `:2941` promises preservation.
- **Fix:** Generalise the F-18 store (`writeUnsavedEntry`) to cover saved-expense edits, receipt-draft edits and payments. Key them by account, trip and record, and store the baseline revision or financial snapshot. On load or after same-account sign-in, offer *Resume* and rehydrate. If the server record changed, route through the existing conflict merge (`reportEditorConflict` / "Compare changed payment"). Never offer a draft to a different account or after access is revoked. Delete drafts on save, discard and sign-out. Correct the banner copy ("You were signed out. Sign in again to continue your edits."). This is simpler than a new "auth gate" mechanism because it reuses existing persistence and merge code.
- **Source:** `components/trip-app.tsx`, `lib/unsaved-entry.ts` (`writeUnsavedEntry` / `readUnsavedEntry`), `components/payment-editor.tsx`.
- **Complexity:** M–L.
- **Regression tests:** Reload, a new tab or a killed page for each editor type offers Resume. Resume after a remote change shows the merge UI. Same-account re-auth resumes. Different-account sign-in never sees the draft. Revoked membership drops it. Saving clears it. Storage unavailable (private mode) degrades to the current behaviour. No financial values appear in exports or logs.
- **Dependencies:** Enables safe TT-12 (PR-09). Shares the dirty-state helper with TT-02. Needs privacy review (financial drafts stored on shared devices).

### TT-04 · After registering from an invite, the Join confirmation is above the viewport

- **Origin:** Both (IO-14, primed).
- **Verdict:** Confirmed. Measurements match Sol's (this review: `scrollY 1252`, heading top −1,027 px, CTA top −139 px; Sol: 1,241 / −1,016 / −84 to −128).
- **Severity:** High (unchanged). The visible primary CTA is "Create your first holiday", which invites a parallel ledger. Focus is on `<body>`.
- **Affected:** `?invite=` landing → registration → `JoinTrip` preview.
- **Reproduce:** Open a valid invite while signed out (390×844) → *Create an account or sign in* → *Create an account* → submit from the bottom of the form.
- **Evidence:** `evidence/independent/43-after-register-viewport-390.png`, `44-after-register-full-390-top.png`; Sol bundle `TT-04-invite-after-registration.png`, `native-supplement.json`.
- **Root cause:** `accountAuthenticated` (`components/trip-app.tsx:662-682`) loads data but performs no scroll or focus management. `JoinTrip` (`components/trip-sharing.tsx:159-225`) renders above the retained scroll position.
- **Fix:** When an invitation preview first becomes available after authentication, `scrollIntoView({ block: 'start' })` (respecting reduced motion and the sticky header) and focus the "Join {holiday}" heading (`tabIndex=-1`) once per invitation. Optionally hide the empty-state onboarding while an invitation is pending.
- **Source:** `components/trip-app.tsx`, `components/trip-sharing.tsx`.
- **Complexity:** S.
- **Regression tests:** New registration and sign-in from an invite at 390×844, 320×568 and 844×390: heading in view and focused. A background refresh doesn't re-scroll. Expired or revoked invite. Confirm still requires the checkbox.
- **Dependencies:** Ship with OP-05 (PR-08).

### TT-01 · Every long modal moves keyboard focus outside the visible area

- **Origin:** Both (IO-07, primed but broader).
- **Verdict:** Confirmed with amendments. Amendments:
  1. **Scope:** every `useModalLayer` dialog, not just Profile. The expense editor's `useStickyFooterReveal` only scrolls **down** (`editor-footer-reveal.ts:32`), so wrap-around and Shift+Tab land on header controls scrolled out above (top −222 px at 390×844).
  2. **Fix:** a one-place change in the shared trap is sufficient.
- **Severity:** High (unchanged). Fails WCAG 2.2 SC 2.4.7 and 2.4.11 for keyboard users, including on destructive controls (Sign out, Delete account).
- **Affected:** Profile & app settings (all controls below the first screen), expense and receipt editor (reverse direction), payment editor, Create holiday, confirmation stacks.
- **Reproduce:** Open Profile & app settings → focus Display name → Tab ×10. Focus reaches controls at y = 997–4,246 px in an 860 px window while `section.modal.scrollTop` stays 0. Expense editor: Tab to the end, then continue (wrap) or Shift+Tab back to the top.
- **Evidence:** `evidence/independent/37-…`, `38-…`, `39-expense-editor-tab-offscreen-390.png`; Repro `TT-01`; Sol bundle `TT-01-chromium-offscreen-tab.png`, `TT-01-webkit-offscreen-tab.png`, `interactions-*.json`.
- **Root cause:** `components/modal-accessibility.tsx:81-93` intercepts Tab and calls `elements[next].focus({ preventScroll: true })`. Mouse-wheel scrolling and programmatic `focus()` without that flag work.
- **Fix:** In the Tab branch only, after focusing call `elements[next].scrollIntoView({ block: 'nearest', inline: 'nearest' })`. The editors already set scroll padding from `--editor-footer-height`, so sticky footers are respected. Keep `preventScroll` for initial focus and restoration, because that is where the earlier iOS pointer-jump defect lived. This is simpler than Sol's generic "reveal within container" mechanism and behaves the same way.
- **Source:** `components/modal-accessibility.tsx`, `components/editor-footer-reveal.ts`.
- **Complexity:** S (code) + M (cross-engine tests and device check).
- **Regression tests:** Forward and reverse Tab through Settings, expense editor, payment editor and Create holiday at 390×844, 844×390 and 1280×860 in Chromium and WebKit. Every focused element must have its rect inside the dialog's visible area minus the sticky footer. No page scroll behind the modal. Initial focus and restoration unchanged. Simulated keyboard geometry test (`expense-layout` suites) still green. Physical iOS check MAT-05.
- **Dependencies:** None.

## Medium

### OP-02 · Two discount paths stack silently; flat fields' accessible names don't match labels

- **Origin:** Opus (new).
- **Verdict:** New (reproduced). Repro `OP-02` (footer €48.00 for €60 with a €6 flat and a €6 structured discount).
- **Severity:** Medium. A single coupon can easily be applied twice: the structured list doesn't show the flat discount and vice versa, and the flat "Discount" input sits directly under *Add discount*. The calculation is correct; the user's intent is easy to misstate.
- **Affected:** Expense and receipt editor → *Tip, tax or discount* (flat *Added tax / Tip / service / Discount* fields plus the structured *Discounts and charges* list).
- **Reproduce:** Amount 60 → *Tip, tax or discount* → flat *Discount* 6 (total €54) → *Add discount* 6, Whole receipt → *Add*. The total is €48 with no combined summary.
- **Evidence:** `evidence/supplementary/85-dual-discount-mechanisms-390.png`, `evidence/repro/sample-output/OP-02-stacked-discounts.png`.
- **Root cause:** Legacy flat adjustment fields coexist with the structured adjustment model (#85/#87) without a unified summary. The flat inputs use `aria-label` "tax", "tip", "discount", which doesn't contain the visible labels (WCAG 2.5.3).
- **Fix (minimal):** Show every adjustment (flat and structured) in one "Discounts and charges" summary with the combined total, and show an inline notice when both a flat discount and a structured discount are present ("2 discounts applied: −€12.00 in total"). Fix the accessible names to match the visible labels. Longer term: present the flat fields as quick presets that create structured adjustments, so there is a single model. That needs a data-model decision and independent financial review.
- **Source:** `components/trip-app.tsx` (adjustment fields around the `AdjustmentEditor` mount, `:3613-3651`), `components/adjustment-editor.tsx`, `lib/adjustments.ts`.
- **Complexity:** S (summary, notice and labels) / L (unification).
- **Regression tests:** Combined summary equals the posted total. Notice appears only when both kinds exist. Accessible names are "Added tax", "Tip / service", "Discount". No change to the saved financial format or allocation.
- **Dependencies:** After TT-03 (PR-01).

### TT-21 · CSV import treats a comma-separated "Shared by" as one participant

- **Origin:** Sol.
- **Verdict:** Confirmed. The import preview's traveller list shows "Avery Gray, Jo Smith" as a single traveller, and the saved row gives the importer a £0.00 share.
- **Severity:** Medium (unchanged). Silently wrong imported split, but a one-time action.
- **Affected:** Holiday options → *Import holiday* (CSV).
- **Reproduce:** Import Sol's synthetic row `…,Avery Gray,"Avery Gray, Jo Smith"` and choose Avery Gray.
- **Evidence:** `evidence/validation/77-TT21-import-preview-390.png`, `78-…`; Sol bundle `native-import-preview-390.png`, `import-separator.json`.
- **Root cause:** `lib/import-ledger.ts:313` splits participants on `/[;|]/` only. The dialog doesn't state the separator or preview per-person shares.
- **Fix:** State "Separate people in *Shared by* with ; or |" next to the file control. Preview the parsed people and per-person shares for the first rows. Flag a participant whose name contains a comma and matches two known names. Don't change the CSV grammar without a decision.
- **Source:** `components/import-holiday.tsx`, `lib/import-ledger.ts`.
- **Complexity:** S–M.
- **Regression tests:** Comma and semicolon cases, a legitimate name containing a comma, multi-row preview, Splitwise and JSON imports unchanged, exact-share rounding unchanged.
- **Dependencies:** None.

### TT-12 · Back changes the section under an open editor instead of closing it

- **Origin:** Both (IO-03).
- **Verdict:** Confirmed with amendments. Amendments: the **payment editor** behaves the same way (Balances → Expenses while it stays open). Repeated Back exits the app. Desktop Chromium then shows a `beforeunload` prompt for new expense drafts, but installed PWAs and mobile browsers often don't, so in combination with TT-07 this is a loss path.
- **Severity:** Medium (unchanged; risk drops once TT-07 is fixed).
- **Affected:** Expense, receipt and payment editors; Android system Back; iOS swipe-back.
- **Reproduce:** Balances → Expenses → open an expense (or Record paid) → browser Back. The route changes and the editor stays open.
- **Evidence:** `evidence/independent/13-payment-dialog-after-back-390.png`, `16-expense-back-390.png`; Sol bundle `TT-12-chromium-browser-back.png`, `TT-12-webkit-browser-back.png`.
- **Root cause:** Dialogs don't participate in history (`lib/trip-navigation.ts` handles sections only).
- **Fix:** On opening a user-initiated editor, push a history entry such as `{ dialog: 'expense' }`. A `popstate` while it is the top dialog requests the normal close path, which goes through the dirty guard (TT-02 / expense guard). If the user keeps editing, re-push the entry. Programmatic close calls `history.back()` only if the entry is still current. Deep-linked dialogs (`?receiptDraft=`) keep their URLs.
- **Source:** `lib/trip-navigation.ts`, `components/trip-app.tsx` (editor open/close), `components/payment-editor.tsx`.
- **Complexity:** M.
- **Regression tests:** Back closes an untouched editor. Back on a dirty editor shows the confirm, and Keep editing keeps the history entry. Forward navigation. Nested confirmation. Deep links. Trip switching. Physical Android Back and iOS swipe (MAT-03).
- **Dependencies:** PR-02 (payment guard), PR-07 (drafts). Independent review recommended.

### TT-10 · A first-load failure shows "Create your first holiday" to a returning user

- **Origin:** Sol.
- **Verdict:** Confirmed (an initial `/api/ledger` 503 shows the error *and* an enabled onboarding panel; Retry restores the trip).
- **Severity:** Medium (unchanged). Travel networks make this plausible, and it can lead to a duplicate holiday.
- **Affected:** Initial load of any holiday route.
- **Evidence:** `evidence/validation/74-TT10-first-load-503-390.png`; Sol bundle `TT-10-chromium-ledger-error-empty.png`, `TT-10-webkit-ledger-error-empty.png`.
- **Root cause:** The empty-ledger render (`components/trip-app.tsx:2997-3040`) is derived from `ledger.trips.length === 0` regardless of whether the first load failed (`:506-526`).
- **Fix:** Track `initialLoad: 'pending' | 'ok' | 'failed'`. While it is pending or failed, show a loading state or a focused retry panel instead of onboarding. Keep the stale-snapshot banner for background failures.
- **Source:** `components/trip-app.tsx`.
- **Complexity:** S.
- **Regression tests:** Initial 503, timeout, 401, a true empty account, a slow success, and a background failure with a prior snapshot, in both themes.
- **Dependencies:** Same error-state work as OP-03 (PR-10).

### OP-03 · Operation errors are raw, misrouted and shown below the fold

- **Origin:** Opus (new).
- **Verdict:** New (reproduced). Repro `OP-03`.
- **Severity:** Medium. Error recovery: the user may not see the error at all, and the only visible action ("Retry updates") doesn't retry the failed operation.
- **Affected:** Receipt upload failure, create-holiday validation (TT-15), and likely any operation that calls the shared `setError`.
- **Reproduce:** Make the receipt upload POST fail (network abort) → *Add expense* → *Choose image*. The editor's alert "Failed to fetch" renders at y = 1,088 (below the fold), and a duplicate "Failed to fetch · Retry updates" goes to the page-level banner, which sits behind the full-screen editor. The same duplication appears for TT-15.
- **Evidence:** `evidence/supplementary/82-upload-failure-390.png`; Repro `OP-03` alert positions; `evidence/validation/67-TT15-create-blank-name-390.png`.
- **Root cause:** One `error` state feeds both the page banner (which carries a ledger "Retry updates" action) and the dialogs. Exceptions are displayed verbatim.
- **Fix:** Separate `ledgerError` (with Retry updates) from `operationError` (scoped to the dialog, rendered next to the footer or the failing control, focused or announced). Map network failures to plain language ("Upload failed. Check your connection and try again.") with an explicit *Try again* that repeats the operation.
- **Source:** `components/trip-app.tsx`, `components/receipt-capture.tsx`, `components/receipt-upload-dialog.tsx`.
- **Complexity:** M.
- **Regression tests:** Upload abort or 500 shows a scoped, visible, announced message with a working retry. The page banner shows only ledger-refresh errors. Validation errors map to fields (TT-15).
- **Dependencies:** PR-10 with TT-10, TT-15 and TT-08.

### TT-08 · A missing receipt image opens an empty zoom viewer

- **Origin:** Sol.
- **Verdict:** Confirmed (with an image 404: the thumbnail stays an enabled button, and the viewer shows zoom controls and "Zoom to read small print…" with `naturalWidth = 0` and no message).
- **Severity:** Medium (unchanged). Also triggered by transient network failures and by restored expenses whose image was purged (documented in the README).
- **Affected:** Receipt review thumbnail, large panel, `ReceiptPhotoViewer`.
- **Evidence:** `evidence/validation/75-TT08-missing-thumbnail-390.png`, `76-TT08-missing-image-viewer-390.png`; Sol bundle `TT-08-*`.
- **Root cause:** No load/error state in the image components (`components/receipt-photo-viewer.tsx:16-45`).
- **Fix:** Track loading, loaded and failed per image. On failure, show "The receipt photo couldn't be loaded" with *Try again*, and *Replace photo* where authorised. Disable zoom controls until loaded.
- **Source:** `components/receipt-photo-viewer.tsx`, receipt thumbnail in `components/trip-app.tsx`.
- **Complexity:** S–M.
- **Regression tests:** 404, delayed success, corrupt bytes, offline, retry success, focus return.
- **Dependencies:** PR-10.

### OP-04 · Manual receipt entry hides "Add item" after the first line

- **Origin:** Opus (new).
- **Verdict:** New (reproduced).
- **Severity:** Medium. This is the core correction path when receipt AI is unavailable, or when a scan misses lines.
- **Affected:** Receipt review (unprocessed or partial receipts), expense editor single-line mode.
- **Reproduce:** Upload a receipt with no reader → *Add item*. The editor collapses to the single-line form, *Add item* disappears, and focus moves to `<body>`. To add a second line you must open *Split equally → Change → By item*. Only *Paste itemised data / Import items* under *Receipt tools* offer bulk entry.
- **Evidence:** `evidence/independent/53-add-item-390.png`, `evidence/supplementary/79-receipt-by-item-390.png`.
- **Root cause:** Single-item expenses render in quick mode, which hides the itemised controls. *Add item* unmounts without moving focus.
- **Fix:** On receipts (`receiptId` present), stay in itemised mode once a line is added, or always show *Add another line* below the single line. Move focus to the new item's name field after *Add item*.
- **Source:** `components/trip-app.tsx` (quick-mode decision), `components/expense-item-row.tsx`.
- **Complexity:** S–M.
- **Regression tests:** Adding 1, 2 and 10 lines on an unprocessed receipt without changing the split method. Focus lands on the new line. The quick-expense path without a receipt is unchanged. Scanned receipts unchanged.
- **Dependencies:** PR-11 with TT-11. TT-18 for long lists.

### TT-14 · Discount, charge and offer controls are largely untranslated

- **Origin:** Sol.
- **Verdict:** Confirmed with amendments. Amendment: broader than offer rules. In French, most of the discount/charge form is English ("Ajouter discount", "Label (optional)", "Percent", "Chosen items", "Whole receipt", "Change split", …), as is **"Remind {name}"** on Balances.
- **Severity:** Medium (unchanged). The language picker doesn't mark ES/FR/DE as previews (the README does), so users will treat them as supported.
- **Affected:** `AdjustmentEditor`, `SettlementReminder`.
- **Evidence:** `evidence/validation/69-TT14-fr-offer-rule-390.png`; Sol bundle `TT-14-offers-fr-390.png`, `additional-rendered.json`.
- **Root cause:** Literal strings not wrapped in `uiText()` (`components/adjustment-editor.tsx:223-285`, e.g. "Offer rule", "Portions per offer", "Saving type", "Printed saving (optional)").
- **Fix:** Wrap the strings and add translations. Add a test that renders the editor in each locale and fails on known English literals, or a lint rule against JSX text outside `uiText` in these components.
- **Source:** `components/adjustment-editor.tsx`, `components/settlement-reminder.tsx`, `lib/ui-language.ts`.
- **Complexity:** M.
- **Regression tests:** Snapshot or text checks in EN/ES/FR/DE at 320 px dark. Saved rule identities don't change with language.
- **Dependencies:** PR-15 with TT-13.

### TT-13 · Payment review switches French notation to UK notation

- **Origin:** Sol.
- **Verdict:** Confirmed (French Balances `67,33 €`; Review `€67.33`, "Bob doit €67.33").
- **Severity:** Medium (unchanged). Financial confirmation step; same reasoning on "preview" status as TT-14.
- **Evidence:** `evidence/validation/68-TT13-fr-review-390.png`; Sol bundle `TT-13-fr-*`.
- **Root cause:** `components/payment-editor.tsx:50` hardcodes `Intl.NumberFormat("en-GB", …)`.
- **Fix:** Use the shared `formatMoney` (`lib/money-format.ts`). Also localise the review date (currently ISO `2026-11-27 à 13:00`).
- **Complexity:** S.
- **Regression tests:** FR EUR, EN GBP, JPY (0 decimals) in the payment row, review and recorded list.
- **Dependencies:** PR-15.

### TT-05 · Bottom-navigation labels overlap and clip at 200% text

- **Origin:** Sol.
- **Verdict:** Confirmed (root font 32px: 3 overlapping label pairs at 320 px and 2 at 390 px; "Expenses" starts at x = −18; `scrollWidth` still equals the viewport). Sol's 768 px document-width overflow was not re-measured here.
- **Severity:** Medium (unchanged), WCAG 1.4.4. Applies to users who enlarge the default font (desktop browser settings, Android text scaling). iOS Safari's AA text size zooms rather than changing the root size; see MAT-06.
- **Evidence:** `evidence/validation/70-TT05-text200-320.png`, `70-TT05-text200-390.png`; Sol bundle `TT-05-*`.
- **Root cause:** Fixed five-column grid with fixed cell widths (`app/globals.css:1733-1790`).
- **Fix:** Let labels wrap or truncate within their cells, scale icons, and allow the bar to grow in height, or switch to icon + short label under a breakpoint driven by text size. Fix the existing enlargement test so it asserts computed size and per-label rectangles.
- **Complexity:** M.
- **Regression tests:** Label rectangles don't overlap and stay inside cells at 100% and 200%, 320/390/768 px, EN/FR/DE, Chromium and WebKit.
- **Dependencies:** PR-14.

### TT-06 · Repeated trip header pushes the selected section below the fold

- **Origin:** Both (IO-17, IO-21).
- **Verdict:** Confirmed with amendments. At 320×568 the tab bar starts at y = 492 and every section heading starts **below** it (Expenses 524, Balances 524, Receipts 516, History 572, Travellers 755). Amendment: once a long list is scrolled, no add action is reachable (Add expense ends up at y ≈ −1,974).
- **Severity:** Medium (unchanged).
- **Evidence:** `evidence/validation/71-TT06-travellers-320x568.png`, `evidence/supplementary/84-scrolled-list-no-add-390.png`, `evidence/independent/32-travellers-top-390.png`; Sol bundle `matrix-320--*`.
- **Root cause:** Shared heading, stats and `OfflineCapture` render on every route (`components/trip-app.tsx:2934-3076`).
- **Fix:** Keep the full summary on Expenses only. Use a compact one-line context header elsewhere. Move offline setup into settings (see OP-06). Provide a persistent add action within thumb reach above the tab bar on mobile.
- **Complexity:** M.
- **Regression tests:** First-screen visibility of each section heading at 320×568, 375×667, 390×844 and 844×390 landscape. Desktop rail unchanged.
- **Dependencies:** PR-14. Coordinate with OP-06.

### TT-18 · Long receipts have no persistent way back to the photo or totals

- **Origin:** Sol.
- **Verdict:** Confirmed with amendments. With 30 **manually added** lines the editor is **12,087 px** tall, because added items stay expanded. Sol's scanned 40-line sample with compact rows was 6,176 px. At the tail only item controls are visible.
- **Severity:** Medium (unchanged).
- **Evidence:** `evidence/validation/80-TT18-long-receipt-tail-390.png`; Sol bundle `receipt-long-top-*.png`, `receipt-chromium.json`.
- **Fix:** Collapse a line when focus leaves it (except the active one). Add a compact jump ("Photo & totals ↑") in the footer area and "Back to line N".
- **Complexity:** M.
- **Regression tests:** 40/200 lines; jump and return focus; the pinned footer at 320/390/844 landscape; no change to line order or calculations.
- **Dependencies:** PR-16, after OP-04.

## Low

### TT-11 · "Scan receipt" overstates capability when the reader is unavailable

- **Origin:** Both (IO-20 adds the two-tap entry).
- **Verdict:** Confirmed with amendments. Amendments: **severity P2 → Low**, because in a correctly configured deployment the reader exists and "Scan" is accurate, so the mismatch only occurs when the reader is unavailable (key removed, quota, rate limit). Additions: Inbox *Add receipt* opens the upload dialog while Bill *Add receipt* opens a manual expense editor (confirmed). The main-page *Scan receipt* opens the editor rather than the camera, so scanning takes two taps.
- **Evidence:** `evidence/independent/52-after-receipt-upload-390.png`; Sol bundle `10-receipt-upload-390.png`, `11-unconfigured-scan-draft-390.png`.
- **Fix:** Label by reader status ("Add receipt photo" plus a short "Items will need entering by hand" note when unavailable). Use one verb set across Inbox, Bill and Expenses. Consider opening the file picker directly from the main *Scan receipt*.
- **Complexity:** S–M. **PR-11.**

### TT-15 · Whitespace-only holiday name shows a raw schema error

- **Origin:** Sol.
- **Verdict:** Confirmed with amendments. Amendments: **severity P2 → Low**. An *empty* name is already blocked by native validation ("Please fill out this field"), so only whitespace-only input reaches the raw message `trips → 1 → name: …`. Addition: the message appears twice, including in the page banner with an irrelevant "Retry updates" (an instance of OP-03). The field isn't marked `aria-invalid`.
- **Evidence:** `evidence/validation/67-TT15-create-blank-name-390.png`; Sol bundle `TT-15-create-error.png`.
- **Fix:** Trim before submit, use `setCustomValidity` or an inline error with `aria-invalid` and `aria-describedby`, and focus the field. Map server validation paths to fields.
- **Complexity:** S. **PR-10.**

### TT-16 · "Email not verified" contrast 4.43:1

- **Origin:** Sol. **Verdict:** Confirmed (computed `#68718a` on `#f2f4fb` = 4.43:1 at 12.8px/400; Sol 4.42:1). **Fix:** Use the higher-contrast label token. **Complexity:** S. **Source:** `components/account-panel.tsx:96-109`. **PR-13.**

### TT-17 · Two bill tabs packed into a five-column bar

- **Origin:** Sol. **Verdict:** Confirmed (Bill 10–82 px, History 84–157 px of a 390 px bar). **Fix:** Two flexible equal columns for bills. **Complexity:** S. **Source:** `components/trip-routing.tsx:59-78`, `app/globals.css:1733-1790`. **Evidence:** `evidence/validation/73-TT17-bill-view-390.png`. **PR-14.**

### TT-19 · Balances emphasise the group over "my position"

- **Origin:** Both (IO-24).
- **Verdict:** Confirmed with amendments. This is a **subjective design enhancement**, not a defect: the information is present and correct. Addition (objective): the "Still to settle" card is mint/green both when everyone is square and when €60 is owed, so colour doesn't encode state.
- **Fix:** Add "You owe / You're owed / You're settled" to the summary, and use neutral styling while debts remain.
- **Complexity:** S–M. **Source:** `components/trip-app.tsx:2210-2228`. **PR-17.**

### TT-20 · Receipt History `aria-controls` references an absent element

- **Origin:** Sol. **Verdict:** Confirmed (`aria-controls="receipt-history-view"`, element absent while closed; `components/trip-app.tsx:3353`, panel at `:3803`). **Fix:** Render a hidden container or set the attribute only when open. **Complexity:** S. **PR-13.**

### OP-05 · Auth entry defaults and alert semantics

- **Origin:** Opus (new). **Verdict:** New (reproduced).
- **Observed:** (1) On an invite link, *Create an account or sign in* switches the form to **Sign in**, so a new invitee must find "Create an account" (`evidence/independent/42-invite-cta-scrolled-390.png`). (2) After session loss, a returning user is shown **Create your TripTab account** (`evidence/validation/63-…`). (3) The normal signed-out invite state ("Sign in to TripTab to open your ledger") uses an error-styled `role="alert"` (`41-…`).
- **Fix:** Default to Create account for invitees without a session, and to Sign in after session loss. Use `role="status"` with neutral styling for informational states.
- **Complexity:** S. **Source:** `components/auth-panel.tsx`, `components/trip-app.tsx:656-661`, `components/trip-sharing.tsx`. **PR-08.**

### OP-06 · Travellers tab is a catch-all; History opens with the invite form

- **Origin:** Opus (new). **Verdict:** New (reproduced). Partly subjective information architecture; the length and duplication are objective.
- **Observed:** Travellers is 6,264 px at 390 px: roster, weights and dates, invites, payment handles, holiday details, display names, language preferences, archive/transfer/delete, data export, plus the offline promotion card. History begins with *Invite a traveller* before Activity (`evidence/independent/31-…`, `33-…`).
- **Fix:** Move holiday administration (details, language, archive/transfer/delete, export) to a "Holiday settings" sheet reachable from the holiday header menu. Remove the invite form from History, or collapse it there. No route changes needed.
- **Complexity:** M. **PR-17.**

### OP-07 · No skip link

- **Origin:** Opus (new). **Verdict:** New (reproduced): desktop Tab order visits 9 sidebar stops before the main content. Landmarks exist, so screen-reader users can bypass them. **Fix:** Add a visible-on-focus "Skip to holiday content" link. **Complexity:** S. **PR-13.**

### OP-08 · Drawer/sidebar action row wraps into multi-line text buttons

- **Origin:** Opus (new). **Verdict:** New (reproduced) at 390 px (drawer) and 1280 px (sidebar): "New / holiday", "Split / a / bill", "Activity / and / people" (`evidence/independent/34-…`, `35-…`). **Fix:** Icons plus single-line labels in a 2×2 grid, or a vertical list. **Complexity:** S. **PR-14.**

### OP-09 · Signed-out visitors see signed-in chrome

- **Origin:** Opus (new). **Verdict:** New (reproduced): breadcrumb "Holidays / Your next adventure", avatar "Y", "Updates automatically", and disabled *New holiday / Split a bill* in the sidebar for signed-out visitors (`evidence/independent/00-…`). Each visit logs 3–15 `401` console errors from data requests issued before auth is known. **Fix:** A minimal signed-out header; gate data requests on the profile check. **Complexity:** S. **PR-17.**

### OP-10 · Offline save alert persists after reconnection

- **Origin:** Opus (new). **Verdict:** New (reproduced): after reconnecting, "You're offline. Reconnect to save" stays in the editor until the next save (`evidence/independent/50-…`). **Fix:** Clear offline-specific save errors on the `online` event. **Complexity:** S. **PR-17.**

### OP-11 · Conflict-resolution polish

- **Origin:** Opus (new). **Verdict:** New (reproduced) (`evidence/independent/24-…`).
- **Observed:** (1) "Another traveller changed this expense" when the same account edited it on another device. (2) A single-line expense asks for *Name* and *Description* separately, although they are one visible field. (3) After *Keep their version*, closing prompts "Discard unsaved changes?".
- **Fix:** Say "This expense changed on another device or by another traveller". Merge identical choices for single-line expenses. Reset the baseline after accepting theirs.
- **Complexity:** S. **PR-17.**

---

## Minor observations not registered as findings

These were noted but are too small, subjective or environment-specific to justify a finding. Implementers may pick them up opportunistically.

- The holiday subtitle shows only the start date ("20 Nov"), not the range.
- The payment editor's timezone is free text, while the expense editor offers a timezone dropdown.
- *Receipt tools* shows every user a long ChatGPT prompt containing internal trip, draft and receipt UUIDs.
- The signed-out invite card doesn't name the holiday or inviter. This is probably deliberate for privacy; noted for product review.
- The coloured ▶️ disclosure marker in Sol's WebKit screenshots comes from Linux WebKit's emoji font fallback for the native `<summary>` marker, not from app CSS. Not expected on Apple platforms; covered by MAT-05.
