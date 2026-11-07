# Reconciliation against the November audit

Source: *TripTab Functionality, Usability and Financial Accuracy Audit*, 6 November 2026, commit `48de3f9` (supplied by the owner on 7 November 2026). Checked against the corrected candidate on branch `claude/new-session-cus6bc` (PR #78, which builds on #77 and the implementation PRs #59 to #76).

**Method and limits.** Each audit finding's *Expected* and *Fix*, and each step of the ten acceptance tests in section F, was compared with the code and the existing tests by inspection, using the suites already run on this tree (units 1,481/1,481; Chromium 241 passed with 3 previous-bundle skips; earlier the full Chromium suite with a real previous-main preview 243/243 and CI WebKit 240/243). No new test was written for this record, and no device, hosted or paid-model check was done. "Met" means the code does what the audit expected and a test asserts it; it is not an independent review. The decisions D01 to D08 are recorded in `PROGRAMME.md`.

## Findings F-01 to F-21

| Finding | Audit expected | Built | Verdict | Gap or difference |
| --- | --- | --- | --- | --- |
| F-01 P0 BOGOF never deducted; one tap saves a wrong total | Promotion becomes an explicit discount; an unexplained difference blocks Save, with "Save anyway" plus a stored reason | #61 written-reason gate (server and MCP); #64 scanned BOGOF becomes a scoped discount and reconciles as `matched`; R01, R03 to R05 | Met | The audit's blocker label ("Resolve £3.00 difference") differs in wording; behaviour matches D02 |
| F-02 P0 receipt-wide discount only | Separate adjustments: amount or percent, scope, label, source line; shares follow scope; new rule version | #64 `adjustments[]` under `scoped-adjustments`; property tests; R03 to R05 | Met | "Give it all to one item" is reached through the manual split (D01), not a single option |
| F-03 P1 sidebar lists collapse | Every holiday and bill reachable at full row height | #59 | Met (browser) | Physical-phone check open |
| F-04 P1 bills never reach tagged people | Connected people added directly with a way to leave; invite link on the bill for others | #67, #72; R02, R08 | Met | Privacy review open |
| F-05 P1 no cross-bill history | Activity with filters (place, person, owed/owing, **date**, text) and per-currency People; bills get the search and filter bar | #67, #72 Activity and People; R08 | **Partly** | Activity has search, place, person and direction filters but **no date filter**. The **bill view still has no filter bar** (holidays only, `components/trip-app.tsx` ExpenseFilterBar). Cross-bill search is available through Activity |
| F-06 P1 deleting means hunting | ⋯ menu (Edit, Duplicate, Delete) on every row, swipe as shortcut, Undo, type-to-confirm only for whole holidays | #66, #71 | Met | WebKit/iPhone swipe on a device open |
| F-07 P1 name asked after the photo and overwritten | Scan sheet with optional name first; typed name always wins; no review tap; four entry points alike | #65 | Met for the tested entry points | The four entry points (holiday heading, bill heading, Split a bill, inbox) are not each tested; device check open |
| F-08 P1 merge reverts the other person's change | Field-level three-way merge; ask only on true clashes | #63; R10 (line order) | Met | Two-browser run against a local Worker open |
| F-09 P1 no duplicate warning | Non-blocking notice (amount within 1%, same day, similar merchant), drafts included | #68; R13 test fix | Met | None known |
| F-10 P1 discounts never tested on the real model | One rule, consistent fixtures, a recorded live run | #64 prompt, schema, corpus | **Blocked** | Live evaluation needs credentials and paid calls (owner authorization) |
| F-11 P1 interrupted scan may be lost | Reading continues after the phone sleeps; list shows Reading… then Ready to review, **with a notification** | #65, #74; R06, R07 (background runner, owner-accepted unverified), R12 | **Partly** | **No "ready to review" notification** reaches the person who started the reading: notifications always exclude the account that made the change (`lib/notifications.ts`), and the proposal is saved under that account. With R07 a reading can now finish minutes later in the background, which makes this more noticeable. Hosted and device checks open |
| F-12 P2 one payer | Optional several payers | — | Deferred (D08) | — |
| F-13 P2 settled bill reopened silently | Warn with the resulting transfer before saving or deleting | #66 | Met | None known |
| F-14 P2 Undo short and partial | Undo until next action or 30 s, over forms; draft restore; bill soft delete | #66, #73, #75; R02 | Met | Undo banner on the drawer delete path once #71 and #75 are integrated (tracker) |
| F-15 P2 misleading wording | "Delete payment", "Invite someone", kind-aware messages | #66 | Met | None known |
| F-16 P2 one global revision | Per-trip revisions, single-trip writes | #76 (0014); R11 (0015) | Met in code | Production-sized migration copy open |
| F-17 P2 bills count towards the 50 limit | Friendly message or separate limit (D07) | #68 separate limits | Met | None known |
| F-18 P2 unsaved entry lost | Autosave per account and trip, Resume | #68; R04 | Met | None known |
| F-19 P2 one photo | Add another photo | — | Deferred | Owner decision recorded in `phase-7-notes.md` |
| F-20 P2 one bad expense hides balances | Name the failing expense, show labelled partial totals | #68; R08 | Met | None known |
| F-21 P2 hygiene | Pin Node 24 or fix tests; refresh status page | #60 | Met | None known |

The review findings R01 to R14 are corrections to these implementations: R01 to R05 to F-01/F-02, R02 to F-04/F-05/F-14, R06/R07/R12 to F-11, R08 to F-05/F-20, R09 to F-01 (historical audit), R10 to F-08, R11 to F-16, R13 to the F-09 test, R14 to the R01 compatibility test. None conflicts with the audit's expectations.

## Acceptance tests (section F)

The audit asks that every scenario run on a 390×844 touch viewport in Chromium and WebKit, **with two real accounts against a local build**, asserting the stored JSON and recomputed balances. "Browser (fixture API)" below means the page runs against routes answered in the test with TripTab's own `validateLedger`, `balances` and `settlements`, not the production server; "production routes" means the real route handlers on Miniflare D1 or SQLite.

| # | Scenario | Evidence | Verdict | Gap |
| --- | --- | --- | --- | --- |
| 1 | BOGOF scan reconciles; stored 300/300/150, discount 300 scoped, total 450, no acknowledgement, `matched`, shares 375/75, Alice → Bob 375; negative case blocked | `browser/discounts.spec.ts` "scan R1" asserts every stored value and the settlement (fixture API, 390×844); `adjustments.test.ts`, `receipt-ai-promotions.test.ts`; blocked case in "a missed discount … blocks Save again" and F-01 "750 versus 450"; production-route money in `financial-format.test.ts` and `browser/cached-client.spec.ts` | Met (single account, fixture API) | Not run with two real accounts on the production server |
| 2 | Missing discount added by hand; 50% gives the same 300; removing it blocks Save again | `browser/discounts.spec.ts` "a missed discount added by hand as 50% … then removed" | Met (fixture API) | As 1 |
| 3 | One Pringles each, milk to Bob: shares 150/300, Bob → Alice 300 | `adjustments.test.ts` "acceptance R1" (`settlements` Bob → Alice 300); `adjustment-ownership.test.ts` | Met at unit level | No browser run of this split |
| 4 | Delete three ways (swipe, ⋯, keyboard); Undo snackbar; delete event with full before snapshot; Sam notified | `browser/row-actions.spec.ts` (keyboard ⋯ with Undo; swipe reveals Delete), `browser/row-menus.spec.ts`; the stored delete event with its full before snapshot and a delivered deletion notice on production routes (`expense-creator.test.ts`), deletion wording (`notifications.test.ts`), delete and restore history (`activity.test.ts`) | Met across levels | The stored delete event and Sam's notification are asserted in units, not in the browser journey |
| 5 | Undo within the window; after it, History → Review expense → Save restores amounts and reports a purged photo; Undo after reopening a form | Undo: `browser/row-actions.spec.ts`; Undo over an open form: "F-14/F-15 Undo stays visible over an open form"; draft restore with a missing photo: `browser/history-restore.spec.ts`; restore keeps rules: `receipt.test.ts` "Undo preserves the photo and trusted historical shares" | **Partly** | **History → "Review expense to restore" → Save, and its purged-photo message (`components/trip-app.tsx`, "The original receipt photo is no longer available…"), have no test** |
| 6 | Name before scanning kept ("Team lunch"), `fieldSources.title = user`, no "Add an expense name", no review tap; typing during reading; no name gives the merchant | `browser/expense-confirmation.spec.ts` F-07 (before the photo; no review tap; blocker text absent; merchant variant); during reading: `receipt-editor.test.ts` "F-07: a name typed while reading is kept" | Met across levels | The stored `fieldSources.title` is asserted in the unit test, not the browser journey |
| 7 | A bill reaches Sam; Activity shows his share; Sam notified; Sam cannot read Gary's other bills | `browser/connected-bills.spec.ts` (fixture API: link request, Activity and People); `connected-bills.test.ts` (production SQL: direct add, refusals change nothing, no access to other bills, leave); notification from the add route | Met across levels | Not a two-account browser run on the production server |
| 8 | Taxi raised to £40: Sam's £20 share, drawer chip and settlement; settled variant warns of the new transfer | Settled-change warning with the audit's rule: `browser/row-actions.spec.ts` "F-13: changing a settled expense explains the new transfer", `settlement-impact.test.ts`; shares and settlements in model tests | Met for the rule | The £40 numbers and Sam's refreshed view across two accounts are not run as one journey |
| 9 | Concurrent edits: name and amount merge to 3000; both amounts must choose | `browser/expense-merge.spec.ts` (both cases, stored values); `expense-merge.test.ts` property tests; R10 | Met (fixture API) | Two-browser run against a local Worker open |
| 10 | Interrupt a scan: proposal stored once, Ready to review without tapping, one draft and one model call; retry creates no duplicate | `browser/expense-confirmation.spec.ts` F-11 (reload mid-reading fills in by itself; time-limit message); R06/R07/R12 on production routes (`receipt-ai.test.ts`, `receipt-commit-ownership.test.ts`, `receipt-background.test.ts`) | Met locally | Hosted lifecycle and iPhone/PWA lock unverified (owner-accepted, R07); no ready notification (F-11 gap above) |

## Gaps found

1. **F-11 ready notification (P1 expectation):** the person who started a reading is never notified that it is ready; notifications exclude the acting account by design. Closing it needs a notification to the reading's own account when a proposal is stored by a reading (and probably only when the app is not open), which touches `lib/notifications.ts` and the processing commit.
2. **Acceptance 5 restore path untested:** History → "Review expense to restore" → Save and its purged-photo message exist in code but no test runs them.
3. **F-05 filters:** no date filter in Activity; no filter bar in the bill view.
4. **Acceptance-level runs:** the audit's two-real-accounts, both-engines, production-server form of the ten scenarios is not how they are tested. Browser journeys use fixture APIs with TripTab's own calculation and validation code; the production-server, two-account evidence is in unit tests on Miniflare D1 or SQLite. The only browser tests against production routes are in `browser/cached-client.spec.ts` (one account).
5. **F-07 entry points:** the four scan entry points are not each tested.
6. Known, already listed elsewhere: F-10 live evaluation (blocked), F-12 and F-19 (deferred), device checks, the production-sized migration copy, privacy review.

These gaps do not change any verified financial outcome. Items 1 to 3 are product behaviour the audit expected; items 4 and 5 are test-coverage differences.
