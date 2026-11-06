# TripTab approved remediation programme

Owner brief and evidence baseline: **TripTab Functionality, Usability and Financial Accuracy Audit, 6 November 2026**, audited commit `48de3f9`. Decisions D01 to D08 and the additional owner decisions govern this programme.

This record describes implementation evidence. It is not approval to release. No merge, deployment or production migration is authorised. Status updated 6 November 2026 (follow-ups #71 to #74 added).

## Owner decisions, 6 November 2026 (after the follow-ups)

- **Bill undo:** option A from `docs/remediation/bill-soft-delete.md` (#73). Deleting a bill hides it, it can be restored for 30 days, and then it is removed. Every reader of `trips` must skip a pending-deleted bill.
- **F-16:** the per-trip revision migration is approved, after a D1 backup.
- **#64 prompt:** ships straight away, with no flag.
- **Rollback limit:** accepted. After discount records exist, roll forward instead of rolling back.

## Baseline (6 November 2026)

- **`main`:**
  - `48de3f9` at the start, matching the audited commit.
  - Now `01be219`, after CI-only #62 (browser checks in Playwright's container), which the owner merged.
- **Tests under Node 22:** 1,324/1,329. The 5 failures (one SQLite NUL-string test, four PWA timing tests) are specific to Node 22. CI and #60 use Node 24, where the audit and #60 report 1,329/1,329.
- **Calculation rules:** absent legacy rule, `selected-participants`, `receipt-total`, `rotating-remainder`, current `native-minor-units`. #64 adds `scoped-adjustments`, used only by entries with discount records.
- **Persistence:**
  - Cloudflare D1: JSON trips, relational memberships, append-only activity, and a global `sync_state` compare-and-swap row.
  - R2 receipt images.
  - Migrations `0000` to `0013`. #76 adds `0014` (F-16, owner approved); no other PR adds one.
- **Deployment:** a Vinext / React 19 Worker. Sites deploys separately from GitHub, so pushing a PR does not deploy.
- **Receipt evaluation:** a synthetic golden corpus (19 receipts, 23 after #64). The live vision evaluation is `not-run`.
- **Implementation and review:**
  - #59, #60 and #61 were implemented by GPT-6 Sol. This session reviewed them and added fixes to #59 (CI) and #61 (UI placement).
  - Phases 2 to 7 (#63 to #68) were implemented in a Claude Code session.
  - The planned independent Opus review cannot be done by the implementing session. **Every PR needs review by someone else.**

## Closure tracker

Statuses: Unresolved, Already fixed and verified, In progress, Implemented and tested, Blocked, Explicitly deferred. "Implemented and tested" means code and automated tests exist; no PR has had an independent review yet.

| Finding | Priority | Phase | Status | PR / head | Tests (local unless noted) | Remaining |
| --- | --- | --- | --- | --- | --- | --- |
| F-01 receipt gate, exceptions, historical audit, promotions | P0 | 1, 3 | Implemented and tested | [#61](https://github.com/Dessimat0r/triptab/pull/61) `d8a5439`; [#64](https://github.com/Dessimat0r/triptab/pull/64) `ed984f6` | #61: written-reason gate, server and MCP enforcement, read-only historical audit, browser 750 vs 450 case. #64: the scanned BOGOF reconciles as `matched` without an exception | Live model evaluation (F-10); review |
| F-02 scoped discounts and charges | P0 | 3 | Implemented and tested | #64 `ed984f6` | Acceptance R1 375/75 and 150/300 stored and settled; 400-run property test; all earlier rules unchanged; old-client strip refused | Review; one-way rollback (see release gates) |
| F-03 sidebar navigation | Immediate | 0 | Implemented and tested | [#59](https://github.com/Dessimat0r/triptab/pull/59) `4ed3e55` | Browser checks at 375×667, 390×844 and 1366×768; CI green on both engines | Physical phone check; review |
| F-04 bills reach connected accounts | P1 | 6 | Implemented and tested | [#67](https://github.com/Dessimat0r/triptab/pull/67) `f15eaaf`; [#72](https://github.com/Dessimat0r/triptab/pull/72) `d6f2353` | Two accounts plus an outsider on SQLite: connections, direct add, refusals leave every table unchanged, no access to other bills, leave. #72: add from People after the bill is created; a same-name person is linked only after confirmation | Privacy review |
| F-05 Activity and People | P1 | 6 | Implemented and tested | #67; #72 | Cross-trip activity; per currency, never netted; matched by account only; agrees with `settlements()`. #72: archived trips included read-only (own archive only, no emails) | Review |
| F-06 row menus, swipe, deletion | P1 | 5 | Implemented and tested | [#66](https://github.com/Dessimat0r/triptab/pull/66) `5e226ee`; [#71](https://github.com/Dessimat0r/triptab/pull/71) `1d0c4ed` | Keyboard ⋯ menu, touch swipe, delete without a prompt when there is no financial effect, bill delete without typing the name (server refusal fixed in `5e226ee`). #71: ⋯ menus and swipe on payment and draft rows; drawer ⋯ menus for holidays and bills | WebKit and iPhone swipe; review |
| F-07 scan flow | P1 | 4 | Implemented and tested | [#65](https://github.com/Dessimat0r/triptab/pull/65) `0585199` | Name typed before or during reading is kept; no review tap; no keyboard after the photo; bill name carries over | Device check; review |
| F-08 concurrent-edit merge | P0 (owner) | 2 | Implemented and tested | [#63](https://github.com/Dessimat0r/triptab/pull/63) `118d6b0` | Field-level three-way merge, 500-run property test, production handlers, two-account store test, browser clash choice | Two-browser test against a local Worker; review |
| F-09 duplicate warnings | P1 | 7 | Implemented and tested | [#68](https://github.com/Dessimat0r/triptab/pull/68) `6a969e3` | Exact, near and false-positive cases; browser Save anyway / Open existing | Review |
| F-10 promotion extraction and evaluation | P0/P1 | 3 | In progress | #64 | Prompt, schema and mapping; corpus contradiction resolved; BOGOF, multibuy, percentage and loyalty receipts added; prompt and corpus kept consistent | **Blocked:** live model evaluation needs credentials and paid calls |
| F-11 durable reading | P1 | 4 | Implemented and tested | #65; [#74](https://github.com/Dessimat0r/triptab/pull/74) `0d3bcd4` | A disconnected request still stores the proposal once, kept alive by `waitUntil`; a retry is idempotent. #74: draft rows show Reading receipt… after a reload, then fill in; Reading didn't finish after the limit | iPhone Safari and PWA lock test |
| F-12 several payers | Deferred | — | Explicitly deferred | — | D08 | Future programme |
| F-13 settled-expense warnings | P1 (owner) | 5 | Implemented and tested | #66 | Audit numbers: delete means "Gary pays Sam £10.00", change to £30 means "Sam pays Gary £5.00"; payments unchanged | Review |
| F-14 Undo | P1/P2 | 5 | Implemented and tested | #66; [#73](https://github.com/Dessimat0r/triptab/pull/73) `db384ff`; [#75](https://github.com/Dessimat0r/triptab/pull/75) `aab47f1` | 30 seconds, visible over forms, restores the same entry. #73: Restore receipt draft from History. #75: a deleted bill can be restored with its photos for 30 days (Undo, plus Recently deleted), then is removed; hidden from every access check | Undo banner for the drawer delete path (#71) when the two are integrated; review |
| F-15 wording | P2 | 5 | Implemented and tested | #66 | "Delete payment", "Invite someone", bill lifecycle errors with translations | Review |
| F-16 global revision | P2, high risk | 7 | Implemented and tested | [#76](https://github.com/Dessimat0r/triptab/pull/76) `905094f` | Migration 0014: per-trip revision maintained by triggers; the app saves only changed trips; another trip's save is no longer a conflict; migration test on existing data; health check | Test on a production-sized copy; D1 backup before applying; review |
| F-17 limits | P2 | 7 | Implemented and tested | #68 | 50 holidays and 100 bills counted separately; friendly messages; restore per kind | Review |
| F-18 unsaved entry | P2 | 7 | Implemented and tested | #68 | Kept per account and trip; survives a reload; resumed once | Review |
| F-19 several photos | P2 | 7 | Explicitly deferred | — | Investigated | After #61 and #64; image lifecycle work |
| F-20 invalid entries | P2 | 7 | Implemented and tested | #68 | Each failing entry named with Open; partial total labelled incomplete; no settlement shown | Review |
| F-21 runtime and documentation | P2 | 7 | Implemented and tested | [#60](https://github.com/Dessimat0r/triptab/pull/60) `391adb5` | Node 24 pinned; CI green | Review |

## PR inventory and merge order

| Order | PR | Head | Base | CI | Depends on |
| --- | --- | --- | --- | --- | --- |
| 1 | #59 F-03 sidebar, plus the CI container copy | `4ed3e55` | main | Green | — |
| 2 | #60 F-21 Node 24 | `391adb5` | main | Green | — |
| 3 | #61 F-01 gate and historical audit | `d8a5439` | main | Green | — |
| 4 | #64 F-02/F-10 discounts | `ed984f6` | #61 | Green | #61; retarget to main after #61 merges |
| 5 | #63 F-08 merge | `118d6b0` | main | Green | — |
| 6 | #65 F-07/F-11 scan | `0585199` | main | Green | — |
| 7 | #66 F-06/F-13/F-14/F-15 actions | `5e226ee` | main | Green | — |
| 8 | #67 F-04/F-05 bills | `f15eaaf` | main | Green | — |
| 9 | #68 F-09/F-17/F-18/F-20 resilience | `6a969e3` | main | Green | — |
| — | #69 integration check (do not merge) | `9dcc95d` | main | Green | #59 to #68 (#71 to #76 not yet included) |
| 10 | #71 F-06 row and drawer menus | `1d0c4ed` | #66 | Green | #66 |
| 11 | #72 F-04/F-05 add people later; archived Activity | `d6f2353` | #67 | Green | #67 |
| 12 | #73 F-14 restore drafts from History | `db384ff` | #66 | Green | #66 |
| 13 | #74 F-11 reading status per draft | `0d3bcd4` | #65 | Green | #65 |
| 14 | #75 F-14 bill undo, option A | `aab47f1` | #73 | Running | #73 |
| 15 | #76 F-16 per-trip revisions (**migration 0014**) | `905094f` | #63 | Running | #63; backup first |

- **Conflicts:** each later PR conflicts textually with earlier ones in `components/trip-app.tsx` and the editor test harness. #69 merges all of them in this order. Its merge commits hold the resolutions (unions of both sides), and it passes:
  - unit tests: 1,376/1,381 under Node 22 (the other 5 are the Node 22-only failures)
  - Chromium browser suite: 206/206
  - build and types
- **When merging one by one:** after each merge, merge `main` into the next PR and reuse #69's resolution.
- **Follow-ups #71 to #74** are stacked on their parent PRs. Retarget each to `main` after its parent merges. #71 and #73 both build on #66 and touch `components/trip-app.tsx`, so expect a small conflict between them.

## Release plan

Owner approval is needed for every merge, deployment and migration. **No migration is needed for #59 to #75. #76 adds migration `0014_trip_revisions.sql`, which the owner approved: take the D1 backup, apply 0014, then deploy.**

1. **Backup:** take a D1 backup and a record of the R2 inventory, following the procedure in `docs/operations.md`, even though no schema changes. #64 writes a new calculation-rule value that older code cannot read.
2. **Server and client compatibility:**
   - The server and client ship as one Worker build. #64's server must be live before any client writes discount records.
   - It refuses writes from cached older clients that drop records ("Refresh TripTab").
   - #68 raises the ledger size cap from 50 to 200 trips. Older cached clients still enforce 50 locally, which is safe because they refuse to write and a refresh fixes it.
3. **Deployment sequence:** merge in the order above, then publish with Sites from `main`, as one release or in the PR-sized steps.
4. **Feature flags:** none. The new behaviours are additive or are corrections. The owner decided the #64 prompt ships straight away.
5. **Post-deployment smoke tests**, on production with two test accounts:
   - the sidebar with several bills
   - an R1-style receipt: scan, apply the discount, Save; the stored total is 4.50 and settlements are correct
   - a mismatch that blocks until a written reason is given
   - concurrent edits that merge
   - Scan with a name; locking the phone while reading
   - ⋯ delete with Undo; a settled-bill warning
   - adding a connected person to a bill and checking they see only that bill; Activity and People
   - a duplicate warning
   - recovering an unsaved entry after a reload
6. **Rollback limits:**
   - Rolling back before any discount record is written is safe.
   - **After records exist, older code rejects the `scoped-adjustments` rule value** and cannot load ledgers containing those entries, so rollback is unsafe. Roll forward instead, or explicitly remove the records through the app first.
   - The other PRs roll back cleanly. Membership rows added by #67 stay valid under older code.
7. **Historical discrepancy audit (#61):**
   - Run `/api/receipt/audit` page by page for each account after deploying.
   - Review the confirmed and potential findings. Correct only through the normal edit flow, which keeps history.
   - It never changes stored amounts.
8. **Known residual risks:**
   - **Live AI evaluation not run.** Promotion extraction is untested on real scans.
   - **F-16 is addressed by #76**, which needs migration 0014 applied before deploy.
   - **Device checks not done:** iPhone, PWA and swipe on a real phone.
   - **No independent review** has been completed for any PR.
   - **Recently deleted bills** stay on the server for up to 30 days (owner decision A, #75).

## Release gates

- Any unresolved P0 or required financial or privacy verification prevents production readiness.
  - The F-10 live evaluation is still open.
  - Independent reviews of #61, #63, #64, #66 and #67 are required.
- Existing balances are never corrected automatically. The historical inspection is read-only.
- The rollback limit for the discount format above: **accepted by the owner** on 6 November 2026.
- Owner approval is still required for merging, deployment and production migrations.

## Implementation record

### Phase 1 (#61)

An authoritative gate on mismatched totals requires a reason (1 to 500 characters) bound to a fingerprint of the receipt evidence. Ordinary review never creates an exception, MCP cannot create one, and scan evidence must survive editing. The read-only historical audit is paged and permission-checked, and covers archived trips.

This session moved the difference block into Check & save, so the editor no longer opens scrolled, and updated three tests to the new gate. CI is green.

### Follow-ups (#71 to #74)

These cover the "Remaining" items above that needed no owner decision:
- #71: menus on payment, draft and drawer rows
- #72: adding people after a bill is created, and archived trips in Activity
- #73: restoring drafts from History
- #74: reading status per draft

While building #71, a bug in #66 surfaced: deleting a bill with entries was refused by the server, because the typed-name check stayed after the UI stopped asking for the name. The fix is `5e226ee` on #66, with a regression test that fails without it, and it is merged into #71 and #69.

### Phases 2 to 7

See each PR's description for the implementation summary, code areas, tests, financial, compatibility and permission impact, migrations (none), review status and limitations. Phase 7's investigation notes are in `docs/remediation/phase-7-notes.md` (on #68).
