# TripTab: independent review of the UX audit

**Reviewer:** Opus, second opinion. **Repository:** `Dessimat0r/triptab`. **Commit under test:** `963d7c84b1a8` (`main`, PR #87 merged). **Date:** 27 November 2026.
**Original audit:** Sol, *TripTab — Comprehensive Layout, UX and Usability Audit* (21 findings: 6 P1, 11 P2, 4 P3; overall 6/10).
**Companion documents:** [`CONSOLIDATED_FINDINGS.md`](CONSOLIDATED_FINDINGS.md) (authoritative register) · [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) · [`MANUAL_ACCEPTANCE_TESTS.md`](MANUAL_ACCEPTANCE_TESTS.md) · [`00-INDEPENDENT_FIRST_IMPRESSIONS.md`](00-INDEPENDENT_FIRST_IMPRESSIONS.md) · `evidence/`.

This was an audit only. No application code was changed, nothing was merged or deployed, no production system was contacted, and all data was synthetic and local.

---

## 1. Executive summary

- **Original findings validated: 21 of 21 reproduced.**
  - **9 Confirmed** as reported: TT-04, 05, 08, 10, 13, 16, 17, 20, 21.
  - **12 Confirmed with amendments**: TT-01, 02, 03, 06, 07, 09, 11, 12, 14, 15, 18, 19. The amendments correct scope, root cause, severity or the recommended fix.
  - **0 Duplicates, 0 Not reproduced, 0 Disputed.** Sol's evidence held up wherever I checked it, and my independent measurements match Sol's to within a few pixels.
- **Severity changes:** two downgrades and no upgrades of the label.
  - **TT-11** P2 → Low: it only misleads when the receipt reader is unavailable.
  - **TT-15** P2 → Low: empty names are already blocked natively; only whitespace-only names reach the raw error.
- **Greater risk than originally reported** (severity label unchanged at High):
  - **TT-07** is not just a re-authentication problem. Edits to saved expenses, **receipt drafts** and **payments** are memory-only, so any reload, crash or OS tab discard loses them. Only new manual expenses are offered for *Resume*.
  - **TT-09** probably affects the **hosted** app, not just the packaged local Worker. It comes from the default Workers Static Assets HTML handling in the generated config. A one-line staging check confirms it (MAT-01).
  - **TT-02:** closing the payment editor from its **Review** step also discards silently, so a user can believe a transfer was recorded when it wasn't.
  - **TT-03:** editing an **existing** discount and pressing Save also drops the edit.
  - **TT-01** affects **every** long modal (shared focus trap), including reverse Tab in the expense editor.
- **Genuinely new findings: 11.** 1 High, 3 Medium, 7 Low.
  - **OP-01 (High):** a reload or relaunch silently switches to the *first* holiday instead of the one in use. This risks expenses being recorded in the wrong ledger.
  - **OP-02 (Medium):** two discount paths stack silently.
  - **OP-03 (Medium):** raw, misrouted operation errors.
  - **OP-04 (Medium):** manual receipt lines are hard to add.
  - Several smaller overlaps were folded into Sol's findings rather than counted as new.
- **Consolidated register:** 32 findings, **7 High, 12 Medium, 13 Low**. Still no Critical: no saved data was corrupted and no balance was miscalculated in any exercised case.
- **Revised overall quality score: 6/10.** I **agree with Sol's 6/10**, reached independently rather than by averaging. My category profile differs: I score mobile usability, navigation, expense entry and the receipt experience lower, and perceived performance higher (§9).
- **Ready for implementation: yes.** Every finding has a reproduced defect, a verified root cause in source, and a PR-sized brief. Three conditions:
  1. Run MAT-01 on staging (TT-09 hosted exposure).
  2. Write a short design note on draft retention and privacy before PR-07 (TT-07).
  3. Get independent review for the PRs flagged in the plan. Most are financial-record paths; the rest are the service worker, the shared focus trap, history handling and broad layout.
- **Do first** (all small): **PR-01** (TT-03 pending discount blocks Save), **PR-02** (TT-02 payment dirty guard), **PR-03** (OP-01 remember the active holiday), **PR-04** (TT-09 offline fallback), **PR-08** (TT-04 invite handoff), and in parallel **PR-12** (TT-01 one-line focus reveal in the shared trap).

---

## 2. Inputs, method and independence

### Inputs and integrity

| Input | Location used | SHA-256 |
|---|---|---|
| `AUDIT.md` (Sol) | Uploaded by the owner (the brief's `/workspace` path was not present in this cloud session) | `96e10f7afb7f68c7c33c677e8243d6572af17d63fb7ca7d747db7eef86259d13` |
| `triptab-audit.zip` (Sol, 82 entries, including an identical `AUDIT.md`) | Uploaded by the owner; extracted read-only to a scratch directory | `db6d08a16d9780f76e877672402f2f719725bb21fa10a55b428810d7db7f8715` |

The originals were not modified and are **not committed** to this repository. This review restates each original finding in the register, so it stands alone.

### Environment

- Node 24.22.3, `npm run install:ci`, `npm run build` (synthetic `RECEIPT_AI_OWNER_EMAIL`), all 20 migrations applied to local D1, and the built Worker served by `npm start` on `127.0.0.1:8787` with local R2. `/healthz` returned `ready`.
- Chromium 1243 through Playwright 1.63 (headless), at 390×844 (touch/mobile), 320×640, 320×568, 1280×860 and 1440×900, plus dark mode and 200% root text. **WebKit was not available** in this environment (installing browsers is disallowed here), so WebKit-specific behaviour relies on Sol's captures and the repository CI.
- **Baseline health:** CI on this branch's head (docs-only change on top of `963d7c8`), run `46001537238`, was green: quality, regression, browser (chromium), browser (webkit), verify.
- Receipt AI was not configured (no key), and the daily FX provider was unreachable from the sandbox. Both are environment limitations, not app defects.

### Sequence (verifiable in git history)

1. **Independent pass first.** I explored the app with synthetic accounts and two "devices", and recorded observations IO-01…IO-26 with 39 screenshots. Committed as `6d487f2` *before* Sol's report was available.
2. **Validation.** I read Sol's report and evidence, then reproduced each of the 21 findings natively or with fault injection, and inspected the cited source.
3. **Supplementary audit.** I explored areas and sequences Sol's method didn't cover (below).
4. **Clean-room confirmation.** A standalone script (`evidence/repro/opus-repro.mjs`) created a fresh synthetic account and reproduced 9 key defects end to end (`evidence/repro/sample-output/results.json`).

**Independence caveat.** The brief summarised five of Sol's high-priority topics. I explored those knowing they had been flagged; they are marked **[primed]** in the first-impressions file. Everything else was unprompted. TT-01's broader scope, TT-07's broader trigger and all OP findings came from my own exploration.

### Techniques that differ from Sol's

- **Two real devices on one account:** concurrent expense and payment edits, and session revocation through *Sign out other browsers* (a realistic TT-07 trigger, versus clearing cookies).
- **"Fresh tab in the same browser context"** to simulate OS tab discard and reveal which editor states are persisted.
- **Fault injection** with Playwright routing: initial 503, image 404, upload abort, and 4-second held saves.
- **Service worker enabled** with offline emulation and Cache Storage inspection.
- **DevTools protocol:** full accessibility tree while modals are open, installability errors, and the parsed manifest.
- **Keyboard Tab-walks** recording the geometry and scroll state of every focus stop.
- **Data volume:** a 300-row synthetic CSV import, then list paging, search and balance timing.
- **Source inspection** of every cited root cause (line references are in the register).

---

## 3. Independent first impressions, by perspective

Full notes: [`00-INDEPENDENT_FIRST_IMPRESSIONS.md`](00-INDEPENDENT_FIRST_IMPRESSIONS.md).

- **First-time user.** Sign-up and *Create your first holiday* are clear. "Holiday" versus "Split a bill" isn't explained. The create dialog leads with an advanced receipt-language setting and a comma-separated traveller box ("List yourself first"). Signed-out visitors see signed-in chrome (OP-09). An invitee who registers is left looking at "Create your first holiday" while the real Join card is offscreen (TT-04).
- **Regular user on a trip.** Quick entry is fast, "Saved · Add another" is excellent, and balances, statements, delete-with-impact and Undo are trustworthy. The friction is at state changes: the active holiday resets on relaunch (OP-01), Back doesn't close editors (TT-12), edits vanish on reload (TT-07), and the payment editor discards on close (TT-02).
- **Mobile UX designer.** The visual system is coherent and dark mode is polished. But the repeated summary header pushes every tab's content below the fold on small phones (TT-06). Primary actions sit at the top, and nothing stays reachable after scrolling (TT-06 amendment). The drawer's action row wraps awkwardly (OP-08). Travellers is a 7-screen catch-all (OP-06).
- **Accessibility specialist.** Dialog semantics are good: `aria-modal`, the background is removed from the accessibility tree, focus starts sensibly, and confirmations focus *Keep editing*. Touch targets are ≥44 px. The shared focus trap breaks focus visibility in long dialogs (TT-01). Some names don't match visible labels (OP-02). Focus is lost after some actions (TT-04, OP-04). There is no skip link (OP-07).
- **QA / financial correctness.** No calculation defect was found: shares, settlements and penny allocation were correct, and conflict handling for expenses and payments is strong. But in several workflows the saved record can differ from what the user saw or intended: an unapplied discount preview (TT-03), stacked discount paths (OP-02), combined import names (TT-21), and the wrong-holiday risk (OP-01).

---

## 4. Validation of the 21 original findings

### Summary

| ID | Sol | Verdict | Final | How reproduced | Key amendment |
|---|---|---|---|---|---|
| TT-01 | P1 | Confirmed w/ amendments | High | Native keyboard walk; Repro | All `useModalLayer` dialogs; reverse/wrap Tab in expense editor; one-line fix |
| TT-02 | P1 | Confirmed w/ amendments | High | Native; Repro | × too; Review-step close risks an unrecorded payment |
| TT-03 | P1 | Confirmed w/ amendments | High | Native; Repro | Editing an existing discount also dropped; use existing blocker list |
| TT-04 | P1 | Confirmed | High | Native, two accounts | — |
| TT-07 | P1 | Confirmed w/ amendments | High | Native (Sign out other browsers; fresh tab); Repro | Any reload or tab discard; receipt drafts and payments; misleading copy |
| TT-09 | P1 | Confirmed w/ amendments | High | Native SW + offline; Repro | Probably hosted too; canonical `/offline` + cache bump; SW-enabled test |
| TT-05 | P2 | Confirmed | Medium | 200% root text, 320 and 390 | (768 px overflow not re-measured) |
| TT-06 | P2 | Confirmed w/ amendments | Medium | 320×568 geometry | No add action after scrolling |
| TT-08 | P2 | Confirmed | Medium | Image 404 injection | — |
| TT-10 | P2 | Confirmed | Medium | Initial 503 injection | — |
| TT-11 | P2 | Confirmed w/ amendments | **Low** | Native (no reader) | Conditional on reader status; two-tap scan; "Add receipt" inconsistency confirmed |
| TT-12 | P2 | Confirmed w/ amendments | Medium | Native | Payment editor too; combined loss path with TT-07 |
| TT-13 | P2 | Confirmed | Medium | French UI | (Also ISO date in review, minor) |
| TT-14 | P2 | Confirmed w/ amendments | Medium | French UI | Most of the discount/charge form plus "Remind {name}" |
| TT-15 | P2 | Confirmed w/ amendments | **Low** | Native | Whitespace-only edge; duplicated into page banner (OP-03) |
| TT-16 | P3 | Confirmed | Low | Computed contrast 4.43:1 | — |
| TT-17 | P3 | Confirmed | Low | Native bill | — |
| TT-18 | P2 | Confirmed w/ amendments | Medium | 30 manual lines | Manual lines stay expanded: 12,087 px |
| TT-19 | P3 | Confirmed w/ amendments | Low | Native | Subjective enhancement; state-insensitive green card |
| TT-20 | P3 | Confirmed | Low | DOM check | — |
| TT-21 | P2 | Confirmed | Medium | Native CSV import | — |

**Partially reproduced aspects (not reproduced ≠ disproved).** Sol's WebKit-specific observations (no WebKit here), the 768 px document overflow at 200% text (TT-05), 844×390 landscape positions (TT-06), and Sol's perceived-performance timings were not re-measured. Sol's WebKit screenshots corroborate TT-01, 03, 05, 08 and 12, and I found nothing contradicting them.

### Per-finding assessment

Each entry gives reproduction, evidence examined, root cause, impact and severity, the proposed fix, regression risks and test sufficiency. Full fields (files, complexity, tests, dependencies) are in the register.

**TT-01 · Scrollable dialogs move focus offscreen (High, Confirmed with amendments).**
- **Reproduced:** In Settings at 1280×860, focus reached y = 997–4,246 px in an 860 px window while `scrollTop` stayed 0. At 390×844 the worst case was y = 1,898 (Repro). In the expense editor, forward Tab is rescued by `useStickyFooterReveal`, but wrap-around and Shift+Tab land at y = −222 because the hook only scrolls down (`editor-footer-reveal.ts:32`). Sol said the editors have their own reveal hook, which is true for forward Tab only.
- **Evidence:** Sol's JSON measurements and WebKit capture agree. The screenshot alone can't show invisible focus.
- **Root cause:** Correct (`modal-accessibility.tsx:92`, `preventScroll: true`).
- **Impact:** Keyboard and switch users lose track of focus in settings, including destructive controls (WCAG 2.4.7/2.4.11). High is right.
- **Fix:** Sol's direction is sound, but a generic "reveal within container" layer is unnecessary. One `scrollIntoView({ block: 'nearest' })` after the Tab-branch focus, with scroll padding the editors already set, fixes every dialog. Keep `preventScroll` for initial and restored focus, where the earlier iOS defect lived.
- **Tests:** Sol's matrix is good. Add reverse Tab in the expense editor and assert "inside the dialog minus the sticky footer", not just "inside the viewport".

**TT-02 · Payment close loses details (High, Confirmed with amendments).**
- **Reproduced:** Escape *and* × discard, and the Review step's × also discards with no "not recorded" message.
- **Root cause:** Correct (`payment-editor.tsx:92,99`).
- **Impact:** Beyond re-typing, closing what looks like a confirmation sheet leaves a real transfer unrecorded, and balances keep showing the debt. That supports High.
- **Fix:** Agree: reuse the confirmation pattern. Build it as a reusable `useDirtyClose` so TT-12 can share it. A tap outside the panel is already ignored, so it needs no change.
- **Tests:** Sol's list is sufficient once the Review-step case is added.

**TT-03 · Save bypasses an open discount preview (High, Confirmed with amendments).**
- **Reproduced:** Native and Repro: "New total €54.00" in the form, €60.00 saved. Variant: editing an existing discount from €6 to €9 (preview €36.00) saves €39.00.
- **Root cause:** Correct, and more precisely located: `submitExpense` computes blockers through `expenseSaveBlockers(…)` (`lib/expense-readiness.ts:58`), which never receives the draft state (`trip-app.tsx:323,1631-1641`).
- **Impact:** A materially wrong financial record without warning, under a "Saved" banner. High, and the first PR.
- **Fix:** Sol offers "an inline blocker or an explicit Apply/Discard choice". The existing *Before saving* blocker list is that inline blocker, which minimises new UI. Agree with Sol not to auto-apply.
- **Tests:** Add the existing-discount edit, the empty-draft (must not block) and the receipt reconciliation path.

**TT-04 · Invitation above the viewport after registration (High, Confirmed).**
- **Reproduced:** Independently, with matching geometry (§5). Root cause and fix are correct.
- **Note:** Adjacent friction, now in the same PR as OP-05: the invite CTA "Create an account or sign in" opens *Sign in*.
- **Tests:** Sufficient.

**TT-07 · Re-authentication loses saved-expense edits (High, Confirmed with amendments).**
- **Reproduced:** With a realistic trigger (*Sign out other browsers* from device 2) and with a fresh tab. Receipt-draft corrections and payments are also memory-only. Only new manual expenses are persisted (`trip-app.tsx:1910-1918`). The 401 banner promises the form "has been kept separate" (`:2941`), but `accountAuthenticated` discards it (`:663-664`).
- **Impact:** OS tab discards on phones are far more frequent than session expiry, so the exposure is higher than Sol described. High stands.
- **Fix:** Sol's "keep dirty edits behind the auth gate" covers only re-authentication. Generalising the existing F-18 store (`lib/unsaved-entry.ts`) and reusing the conflict merge covers every trigger with less new machinery. It needs a privacy decision for shared devices.
- **Tests:** Add the reload, tab-discard and receipt-draft cases.

**TT-09 · Cold offline fallback fails (High, Confirmed with amendments).**
- **Reproduced:** Identical to Sol: the cached `/offline.html` has `redirected: true` and `url: /offline`, and every offline navigation, including *Open capture form*, gives `ERR_FAILED`.
- **Root cause:** Correct. Sol framed it as "packaged local Worker", but the redirect comes from Workers Static Assets' default HTML handling in the generated `wrangler.json`. That is the same mechanism a Sites deployment of this output would use, so production is probably affected (unverified; MAT-01).
- **Fix:** Agree with Sol. Concretely: precache `/offline`, bump `CACHE_NAME`, and update the link in `offline-capture.tsx:290`.
- **Tests:** Sol's recommendation of a service-worker-enabled test is essential. The CI suite blocks service workers, which is why this escaped.

**TT-05 · Enlarged navigation labels overlap (Medium, Confirmed).**
- **Reproduced:** 3 overlapping pairs at 320 px and 2 at 390 px, "Expenses" at x = −18, and `scrollWidth` unchanged.
- **Note:** On iOS, Safari's text-size control zooms rather than enlarging the root, so verify per platform (MAT-06).
- **Fix and tests:** Fine, including repairing the existing enlargement test.

**TT-06 · Shared header delays content (Medium, Confirmed with amendments).**
- **Reproduced:** At 320×568 every section heading starts below the tab bar (y = 492).
- **Amendment:** After scrolling a long list, no add action is reachable.
- **Fix:** Sol's compact header is right. I'd avoid automatically scrolling to headings on every tab change, which can feel jumpy; a compact header makes it unnecessary. Add a persistent add action within thumb reach.

**TT-08 · Missing image opens an empty viewer (Medium, Confirmed).**
- **Reproduced:** With a 404: zoom controls, instructions and a zero-size image, with no message.
- **Impact:** Transient network failures and purged images on restored expenses (documented behaviour) make this more than an edge case.
- **Fix:** Fine.

**TT-10 · First-load failure shows onboarding (Medium, Confirmed).**
- **Reproduced:** As described. Retry recovers.
- **Fix:** Fine. Combine it with OP-03, which shares the global error channel (RC-E).

**TT-11 · Scan wording overstates (Low, Confirmed with amendments).**
- **Reproduced:** With no reader configured, and the "Add receipt" inconsistency between Inbox and Bill confirmed.
- **Severity:** Lowered because a configured deployment makes "Scan" accurate. It only misleads when the reader is unavailable.
- **Addition:** The main *Scan receipt* takes two taps.
- **Fix:** Fine. Don't over-engineer readiness states.

**TT-12 · Back leaves the dialog open (Medium, Confirmed with amendments).**
- **Reproduced:** In both the expense and payment editors.
- **Risk:** Combined with TT-07, repeated Back in an installed PWA can lose edits, because `beforeunload` is unreliable there.
- **Fix:** A history entry per dialog is right. It depends on the dirty guards (PR-02, PR-07), and deep links make it the riskiest UX PR, so it needs independent review and device testing.

**TT-13 · Payment review notation (Medium, Confirmed).**
- **Reproduced:** `67,33 €` on Balances versus `€67.33` in Review.
- **Severity:** Kept at Medium because the language picker doesn't mark ES/FR/DE as previews (only the README does).
- **Fix:** Correct (`formatMoney`). S.

**TT-14 · Offer builder untranslated (Medium, Confirmed with amendments).**
- **Amendment:** Broader than offer rules: most of the discount/charge form, plus "Remind {name}".
- **Fix:** Correct. Add a locale smoke test so new literals are caught.

**TT-15 · Raw schema error (Low, Confirmed with amendments).**
- **Severity:** Lowered because only whitespace-only names reach it.
- **Addition:** The message is duplicated into the page banner with "Retry updates" (OP-03).
- **Fix:** Fine. `setCustomValidity` after trimming is the simplest approach.

**TT-16 · Verification contrast (Low, Confirmed).** 4.43:1 measured. Fine.

**TT-17 · Bill tabs (Low, Confirmed).** Measured. Fine.

**TT-18 · Long receipt navigation (Medium, Confirmed with amendments).**
- **Amendment:** Manually added lines stay expanded: 30 lines → 12,087 px, about twice Sol's scanned sample.
- **Fix:** Collapse lines on blur first (simple, large gain), then add Sol's jump links.

**TT-19 · Group-first emphasis (Low, Confirmed with amendments).**
- **Classification:** A subjective design enhancement; the data is correct and present.
- **Addition (objective):** The "Still to settle" card is green whatever the state.

**TT-20 · Dangling `aria-controls` (Low, Confirmed).** Verified in the DOM. Fine.

**TT-21 · CSV import split (Medium, Confirmed).**
- **Reproduced:** The preview lists "Avery Gray, Jo Smith" as one traveller, and the importer's share is £0.00.
- **Fix:** Fine. Don't change the CSV grammar without a decision.

---

## 5. High-priority findings: precise circumstances and risk

| ID | Exact circumstances | Who is affected | Greater risk than reported? |
|---|---|---|---|
| **TT-03** | An adjustment form (Add discount / Add charge / Edit {adjustment}) is open with **valid** input showing a preview, and the user presses the pinned *Save expense* (or Enter) without the inline *Add/Update*. An empty draft is irrelevant. | Anyone using discounts or charges: offers, coupons, service charges, receipts with BOGOF. | **Yes, in scope:** edits to *existing* adjustments are also dropped. A "Saved" banner reinforces the wrong belief. Typically small amounts, but it directly affects what people pay. |
| **TT-02** | The payment editor is open and changed (or on the Review step), and the user presses Escape or ×. A tap outside the panel is safe. | Anyone recording or editing a payment, especially partial transfers with notes. | **Yes:** closing from Review ("Bob paid Alice €10.00") looks like dismissing a confirmation, yet records nothing, so a real transfer can go unrecorded. |
| **TT-04** | A signed-out user opens an invite, registers or signs in from the form further down the page, and the app keeps that scroll position. The Join card renders above it. Focus is on `<body>`. | Every new invitee on a phone. Less so on desktop, where more of the page fits. | Same as reported. The visible primary CTA ("Create your first holiday") actively invites the wrong action, a parallel ledger. |
| **TT-07** | Any loss of in-memory state while editing a **saved expense**, **receipt draft** or **payment**: session revoked (another device's *Sign out other browsers*, password change), expiry, page reload, crash, OS tab discard, or Back-exit. New manual expenses are protected. | Phone users switching apps mid-edit (camera, banking app, messages), and multi-device users. | **Yes:** the trigger set is much wider than re-authentication. Receipt corrections, often the longest edits, are included. On-screen copy promises preservation. |
| **TT-09** | Offline capture enabled, the service worker controlling the page, then any navigation while offline (reload, cold open, the *Open capture form* link). | Everyone who relies on offline capture, which is the feature's whole purpose. | **Probably:** if the hosted Site uses the same static-asset handling, production is affected today. Verify with MAT-01. |
| **TT-01** | Keyboard Tab inside any `useModalLayer` dialog whose content is taller than its scroll area. Forward Tab in Settings, Create holiday, or the payment editor on short screens; reverse or wrap-around Tab in the expense editor. | Keyboard, switch and some screen-magnifier users; tablet users with hardware keyboards. | **Yes, in scope:** all long modals, not only Settings. |

**None reaches Critical.** In every case the saved data stays internally consistent, nothing is corrupted, and users can recover by re-entering. The High rating reflects silent divergence between what users see or believe and what is recorded (TT-03, TT-02, OP-01), loss of user work (TT-07), a broken core feature (TT-09), or an access barrier (TT-01, TT-04).

---

## 6. Supplementary findings (new)

Full detail is in the register (`OP-01`…`OP-11`).

| ID | Severity | Summary | Found by |
|---|---|---|---|
| OP-01 | High | Reload or relaunch opens the first-created holiday; the selected trip lives only in memory (`trip-app.tsx:266,393`) | Exploring reload with several holidays and bills |
| OP-02 | Medium | Flat Tax/Tip/Discount fields and structured discounts stack (€60 − €6 − €6 = €48) with no combined summary; flat-field accessible names don't match labels | Comparing both discount paths |
| OP-03 | Medium | Upload and validation errors are raw ("Failed to fetch", schema paths), duplicated into the page banner with "Retry updates", and placed below the fold in editors | Fault injection on upload |
| OP-04 | Medium | On a receipt, *Add item* disappears after the first manual line (needs *By item*); focus drops to `<body>` | Manual correction without AI |
| OP-05 | Low | Invite CTA opens Sign in; post-session-loss screen defaults to Create account; informational states use error-styled alerts | Invite and re-auth flows |
| OP-06 | Low | Travellers tab is a catch-all (6,264 px at 390 px); History starts with the invite form | First impressions |
| OP-07 | Low | No skip link (9 sidebar stops before main content) | Keyboard walk |
| OP-08 | Low | Drawer/sidebar action row wraps into 2–3-line text buttons | Visual review |
| OP-09 | Low | Signed-out chrome looks signed-in; 3–15 console 401s per visit | First impressions |
| OP-10 | Low | Offline save alert persists after reconnection | Offline/reconnect |
| OP-11 | Low | Conflict UI copy and duplicate choices; false dirty state after "Keep their version" | Two-device concurrency |

### Areas explored where nothing needed reporting

These were checked deliberately, and the existing behaviour is worth preserving:

- **Repeated actions:** a double-clicked *Save expense* creates one expense, and a double-clicked *Confirm payment* records one payment.
- **Slow saves** (4 s hold): Save shows "Saving…" and is disabled, Close is disabled, Escape is ignored, and exactly one record is written.
- **Concurrency:** stale expense saves show a field-by-field merge, and stale payment saves show "Compare changed payment". Cancel preserves the local edit. Background refresh never overwrote an open editor.
- **Connectivity loss in a running app:** a clear banner, Save blocked with a message, the draft retained, and retry after reconnect works.
- **Modal semantics:** with the editor open, background content is absent from the Chromium accessibility tree. Confirmations are proper `role="dialog"` with focus on *Keep editing*.
- **PWA basics:** no installability errors from the DevTools protocol, the manifest parses cleanly, and the service worker registers and controls the page.
- **Large data:** a 300-row import in ~0.9 s, lists page with "Show 20 more", search and tab switches respond in milliseconds.
- **Recoverability:** the delete confirmation states the settlement impact, a persistent Undo shows the balance delta, and History records before/after.
- **Layout robustness:** no horizontal overflow at 320 px or in dark mode, and visible focus rings, including the `:focus-within` ring on transparent file inputs.

---

## 7. Coverage gaps: what was reduced and what remains

| Gap in Sol's audit | What this review did | Remaining |
|---|---|---|
| Physical mobile devices | **Nothing physical.** All mobile results are Chromium emulation (viewport, touch, `isMobile`). No physical-device claims are made. | MAT-03 to MAT-07, MAT-09, MAT-12 |
| Installed PWA behaviour | DevTools installability check (no errors), manifest parse, service worker registration and control, Cache Storage inspection, offline navigation with the service worker active, and a clean-room repro of TT-09. | True standalone launch, iOS home-screen behaviour, update lifecycle: MAT-01, MAT-02, MAT-12 |
| Live receipt recognition | Not attempted: it needs the owner's funded OpenAI key, and bypassing that is out of scope. Exercised instead: unconfigured state, manual correction (found OP-04), long-receipt editing (TT-18), image 404 (TT-08), upload failure (OP-03). Mocked recognition pipelines are covered by the repository regression suite (green in CI). | MAT-08, MAT-09 |
| (New gap) WebKit | **Not available here.** I relied on Sol's WebKit captures and CI's WebKit job (existing suite green). No new WebKit claims. | MAT-05 and MAT-06 on Safari |
| (New gap) Hosted asset routing | Inferred from the generated `wrangler.json`; production deliberately not contacted. | MAT-01 |
| (New gap) Daily FX provider | Unreachable from the sandbox. Manual rate and bank-charge fallbacks were seen to work. | Staging check of reference-rate lookup |

---

## 8. Evaluation of the proposed fixes

### Where a simpler fix exists

| Finding | Sol's proposal | Recommended instead | Why |
|---|---|---|---|
| TT-01 | Reveal within the scroll container after keyboard moves, honouring sticky chrome and nested layers | One `scrollIntoView({ block: 'nearest' })` in the shared trap's Tab branch | Fixes every dialog in one place. Editors already provide scroll padding. Leaves pointer, initial and restored focus untouched. |
| TT-03 | Intercept Save with an inline blocker or an Apply/Discard choice | Add `adjustmentPending` to the existing *Before saving* blockers | Reuses the existing announcement, focus routing and footer list. No new modal. |
| TT-07 | Keep dirty edits behind the auth gate, then rehydrate | Generalise the F-18 store to every editor type, and reuse the existing merge UI | Covers reload, tab discard and Back-exit as well as re-auth, with less new machinery. |
| TT-09 | Canonical asset, or a normal fallback response | Precache `/offline`, bump `CACHE_NAME`, update the capture link | Smallest change. The version bump evicts the poisoned entry on existing installs. |
| TT-15 | Validate the trimmed name, map server errors | Trim plus `setCustomValidity` / `aria-invalid`, and solve the duplicate banner in OP-03 | Native validation already handles empty names. |
| TT-18 | Jump to photo/totals and back to the last line | Collapse lines on blur first, then add the jump | Halves the editor length for manual entry before adding navigation. |

### Agreed as proposed

TT-02, TT-04, TT-05, TT-08, TT-10, TT-12, TT-13, TT-14, TT-16, TT-17, TT-20, TT-21. I add the shared `useDirtyClose` helper for TT-02/TT-12, an i18n literal check for TT-14, and corrections to the existing text-enlargement test for TT-05.

### Effects on financial calculations

None of the recommended fixes changes the calculation, allocation, rounding, conversion or saved financial format. Three touch financial *workflows* and need independent review:

- **TT-03** changes when Save is allowed.
- **TT-21** changes the import preview only.
- **OP-02** is a display-only summary in its minimal form. The longer-term unification of the two discount models *would* change data and is explicitly deferred to a product and finance decision.

### Accessibility and responsive regression risks

- **TT-01:** don't revive the earlier iOS keyboard "pointer jump". The change is limited to keyboard Tab, but MAT-05 is still required.
- **TT-12:** history entries interact with deep links and nested confirmations.
- **TT-06 and OP-06:** moving surfaces must not hide features; keep them discoverable from the holiday header.
- **TT-05:** test all four locales, because German labels are longest.

### Shared components and architecture (no large refactor needed)

- `useDirtyClose` (dirty comparison plus confirmation) for TT-02, TT-12 and future editors.
- A generalised draft store in `lib/unsaved-entry.ts` for TT-07 (and TT-12's exit path).
- Split error channels (`ledgerError` / `operationError`) for TT-10, OP-03 and TT-15.
- The persisted active holiday (OP-01) is the first step towards trip-scoped URLs, which would later simplify TT-12 and sharing links.

### Objective versus subjective

- **Objective defects:** TT-01, 02, 03, 04, 05, 07, 08, 09, 10, 12, 13, 14, 15, 16, 17, 20, 21; OP-01, 02, 03, 04, 05, 07, 10.
- **Partly subjective** (information architecture or design preference, with objective components noted): TT-06, TT-11, TT-18, TT-19, OP-06, OP-08, OP-09, OP-11.

---

## 9. Independent quality scorecard

These are my own scores. Sol's are shown for comparison only.

| Category | Opus | Sol | Justification (evidence) |
|---|---:|---:|---|
| Visual design | **8** | 8 | Coherent cobalt/indigo/mint system, polished dark mode, clear money typography (`58-expenses-390-dark.png`, `35-expenses-desktop-1280.png`). Deductions: cramped drawer row (OP-08), inconsistent disclosure styling (`33-history-390-top.png`), state-insensitive green card (TT-19). |
| Layout consistency | **7** | 7 | Shared cards, rows, dialogs and footers are consistent. Exceptions: repeated trip chrome (TT-06), catch-all Travellers (OP-06), bill tab grid (TT-17). |
| Mobile usability | **5** | 6 | Good touch targets, a pinned editor footer and a reachable tab bar. But at 320×568 every tab's heading is below the fold (TT-06), Back doesn't close editors (TT-12), invite handoff (TT-04), cold offline broken (TT-09), relaunch opens the wrong holiday (OP-01), edits lost on tab discard (TT-07), and top-only actions. |
| Desktop usability | **7** | 8 | Sidebar, rail and split receipt layout use space well. Keyboard focus disappears in long dialogs (TT-01) and there is no skip link (OP-07); both matter most on desktop. |
| Navigation | **5** | 6 | Real section routes and an accessible drawer. But the active holiday isn't in the URL or storage (OP-01), Back and dialogs are decoupled (TT-12), and IA is overloaded (OP-06). |
| Expense entry | **6** | 7 | The quick form, live shares, Save blockers, "Add another" and conflict merge are strong. The unapplied discount is silently dropped (TT-03), the two discount paths stack (OP-02), and saved-expense edits are memory-only (TT-07). |
| Receipt scanning experience | **6** | 7 | Photo evidence, totals reconciliation and the review-first design are good. Manual multi-line entry is hidden (OP-04), long receipts are very long (TT-18), failures are unexplained (TT-08, OP-03), and wording is reader-agnostic (TT-11). **Live recognition was not assessed.** |
| Financial information clarity | **7** | 7 | Excellent statements, delete-impact text, payment review "before" balances and Undo deltas (`56-…`, `57-…`, `09-…`). Deductions: preview versus footer totals (TT-03), stacked discounts (OP-02), French notation (TT-13), group-first emphasis (TT-19). |
| Accessibility | **5** | 5 | Strong dialog semantics and the background is hidden from assistive technology; ≥44 px targets. Focus visibility broken across modals (TT-01), 200% text overlap (TT-05), label-name mismatch (OP-02), focus loss (TT-04, OP-04), small contrast and ARIA issues (TT-16, TT-20). |
| Error handling | **5** | 5 | Conflict handling, offline-in-session handling and save locking are exemplary. First-load failure shows onboarding (TT-10), raw and misrouted errors (OP-03, TT-15), missing image (TT-08), and re-auth and tab-discard loss (TT-07). |
| Perceived performance | **8** | 7 | Local: a 300-row import renders in ~0.9 s, tab switches in ~50 ms, search is instant, and there is immediate "Saving…" feedback with locking. Hosted and device performance not sampled. |
| **Overall polish** | **6** | 6 | See below. |

**Do I agree with Sol's overall 6/10? Yes.** I reached it independently, not by averaging. The core is genuinely strong: correct money handling, careful conflict and recovery design, thoughtful financial copy. But the defects cluster at state transitions (relaunch, Back, re-auth, offline start, unapplied previews, invite handoff), and those are exactly the moments that decide whether a traveller trusts the app on a phone. My profile is harsher than Sol's on mobile, navigation, expense entry and receipts, and kinder on performance. With Wave 1 and Wave 2 of the plan done, I would expect 7.5–8.

---

## 10. Outstanding testing limitations

- **No physical devices:** iOS Safari, Android Chrome, safe areas, system Back and swipe, OS text scaling, camera and HEIC, tab discard under real memory pressure.
- **No WebKit in this environment:** WebKit claims rest on Sol's captures and CI's existing-suite pass.
- **No installed-PWA standalone launch, push delivery, share-target dispatch or update lifecycle.**
- **No live receipt recognition** (funded key required) and no FX provider access.
- **No real assistive technology:** VoiceOver, TalkBack and NVDA were not run. Findings rest on the accessibility tree, DOM semantics, keyboard geometry and computed contrast.
- **No hosted environment:** TT-09's production exposure is an inference from the build output (MAT-01).
- **Chromium 1243 headless only.** Firefox not tested.
- **Timings are local single-run observations** on a shared CPU.
- **Sol's materials were provided by upload,** not at the `/workspace` paths named in the brief; their checksums are recorded in §2.

Each limitation maps to a test in [`MANUAL_ACCEPTANCE_TESTS.md`](MANUAL_ACCEPTANCE_TESTS.md).

---

## 11. Deliverables and evidence index

| Path | Contents |
|---|---|
| `INDEPENDENT_REVIEW.md` | This document |
| `CONSOLIDATED_FINDINGS.md` | Authoritative register of 32 findings with reproduction, root cause, fix, files, tests and dependencies |
| `IMPLEMENTATION_PLAN.md` | 17 PR-sized briefs in priority waves, with acceptance criteria and review requirements |
| `MANUAL_ACCEPTANCE_TESTS.md` | 12 device and infrastructure tests plus a results template |
| `00-INDEPENDENT_FIRST_IMPRESSIONS.md` | Pre-validation observations (committed before reading Sol's report) |
| `evidence/independent/` | 39 screenshots from the independent pass |
| `evidence/validation/` | 18 screenshots reproducing Sol's findings and amendments |
| `evidence/supplementary/` | 6 screenshots for new findings and sound areas |
| `evidence/repro/opus-repro.mjs` | Standalone, local-only reproduction script (9 scenarios); run before and after fixes |
| `evidence/repro/sample-output/` | `results.json` and screenshots from a clean run on a fresh synthetic account |
