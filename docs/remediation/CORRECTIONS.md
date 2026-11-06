# Corrections to the independent release review (R01 to R11)

**Status: corrected candidate for independent review. Not approved for release.** No merge, deployment, production migration, production data change or paid model call was made. Merging and release stay separate owner actions, and the gates at the end remain open.

Branch `claude/new-session-kf3m0k`, draft PR #77 (do not merge, like #69).

## Provenance and limits of this correction pass

- **Base:**
  - main `01be219` (`01be219b2675ab6018d4090bf042e51400030eec`).
  - The integration from GitHub #69 `bbd5b9f`, which contains every implementation PR #59 to #68 and #71 to #76.
  - #70's tracker `21124c6`, merged as `1d6f40a` with no conflicts (only `PROGRAMME.md` differed).
  - Every PR head was refreshed from GitHub on 6 November 2026 and matched the review inventory.
  - #62 was already merged. #69 is review support only and must never be merged.
- **The review's local integration `5c7df5a` was not available.** It, `RELEASE-REVIEW.md`, `PR-INVENTORY.md` and `review-evidence/` exist only on the reviewer's Windows host (`C:/Users/garyo/triptab-release-review-20261106`), which this cloud session cannot reach.
  - The findings were taken from the correction brief's descriptions.
  - Each failure was reproduced independently here before it was fixed. The reproductions are recorded in `correction-evidence/` and in the commits.
  - Comparing these reproductions with the reviewer's own logs (`cached-client-browser.log`, `legacy-parity.log`, `independent.spec.ts`) is an open check.
- **The November audit and decisions D01 to D08 were not located.**
  - The repository references them (`PROGRAMME.md`) but does not contain them.
  - The October audit was not substituted, and no decision was invented.
  - Reconciling the original scope against these documents is an outstanding gate.
- **Runtime contract not verified here.** The proxy refused `developers.cloudflare.com` (HTTP 403), so the Workers limits page could not be read.
  - The 30-second post-disconnect `waitUntil` grace period is the review's figure.
  - The R06/R07 design's correctness does not depend on it.
- **Environment:**
  - Linux, Node 24.22.1 (the version #60 pins).
  - Chromium from the image (Playwright 1.62.1 config with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`).
  - WebKit could not be downloaded here; the PR's CI runs WebKit in Playwright's pinned container on the combined head.

## Commits, original PRs and what to do with them

Corrective commits on this branch, oldest first. Each is self-contained and names its original PR. The implementation PRs were not rewritten.

| Commit | Finding | Original PR | Disposition |
| --- | --- | --- | --- |
| `b99b8a3` | R01 financial-format boundary | #64 (compatibility) | Cherry-pick onto #64, or land with #64 as one release unit. Must ship before or with any build that can write `scoped-adjustments` |
| `f77fc94` | R03 preview/save order | #64 | Cherry-pick onto #64 |
| `fe43e02` | R04 adjustments are unsaved work | #64 (recovery from #68) | Cherry-pick onto #64 |
| `c0566c1` | R05 person-controlled discounts | #64 (native and MCP) | Cherry-pick onto #64 |
| `049b128` | R02 account-bound panels and Undo | #72, #67 (#66/#75 Undo) | Cherry-pick onto #72 after #67 |
| `c64564e` | R08 incomplete People | #67, #72, #68 | Cherry-pick onto #72 |
| `f4d5629` | R11 no-op membership trigger | #76 | Cherry-pick onto #76. Adds migration 0015 |
| `740f82c` | R06/R07 durable claim | #65, #74 | Cherry-pick onto #74 after #65. Adds migration 0016 |
| `b9b4429` | R09 archived audit review | #61 | Cherry-pick onto #61 (needs R02's `useAccountResource`, or land after #72) |
| `6e9ce7f` | R10 line-order merge | #63 | Cherry-pick onto #63 |

Superseding instead of cherry-picking:
- The owner may prefer to merge this branch's corrections as one reviewed unit after the PRs it builds on.
- In that case close nothing until review, then retarget #77 or a successor away from the integration.
- #69 stays non-mergeable either way.

## Closure matrix

Before and after logs are in `docs/remediation/correction-evidence/`. "Before" runs used the reviewed integration code (`1d6f40a`) or main `01be219` with only the new tests added.

| # | Pri | Status | Correction | Regression evidence (new) | Before fix | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| R01 | P0 | Corrected (code); hosted rollout gate open | The server refuses ledger money to bundles that do not declare format 2. Covers `/api/ledger` GET/HEAD/POST, `/api/activity`, `/api/receipt/process` (before inference) and `/api/trip?mode=archived-data`. The refusal is a 426 with a reload message, sent before auth, reads, writes or spending. This bundle fails closed on a future format, and readers refuse unknown calculation rules | `financial-format.test.ts` (production routes in Miniflare: undeclared, format 1 and unreadable declarations; no money or account leaked; no write); process route refused before key lookup; a static check that every gated fetch declares the format (flags main's four sites). `browser/cached-client.spec.ts` runs **main `01be219`'s real bundle and this bundle against the real routes** | The control reproduces main showing "pays Bob £6.75" and a £7.50 total; the protective tests fail against the pre-fix server (`r01-before.log`) | A main bundle opened before release keeps its pre-release amounts, labelled "Showing the last loaded amounts", until reloaded (it never receives scoped records, and its writes are refused). Rollback below a format-2 build after scoped records exist shows wrong money (runbook). A gradual or percentage rollout would defeat the boundary |
| R02 | P1 | Corrected | `useAccountResource` binds private reads to the account they were read for, accepts only the newest same-account response named by the server, clears on 401/403/404 and re-reads on every live refresh. Used by PersonalActivity and BillPeople. `/api/trip` reads name their account. Undo and deleted-bill notices carry their account | `browser/account-privacy.spec.ts`: account switch; delayed response for the previous account; membership revoked while open; shared bill with Undo and connections. Server authorization tests unchanged and passing | 3 of 4 failed: a late archive leaked "Secret spa" to Bob; a revoked archive stayed; Alice's Undo notice stayed for Bob (`r02-before.log`) | None known |
| R03 | P1 | Corrected | `previewAdjustment` builds one ordered list (an edited row stays in place) for validation, preview, shares and Save, with the rule Save stamps | `adjustment-preview.test.ts`: first/middle/last edits, fixed and percentage swaps, scope swaps, odd pennies, weighted traveller and three rules; preview equals payload equals persisted. Browser R03 journey | Preview "New total £3.00" against £4.00 stored (`r03-before.log`); the old preview moved the wrong person's penny on a legacy rule | None known |
| R04 | P1 | Corrected | Adjustments are included in `editorWorkValue`, `receiptEditableValue` (initial-fill and race fences) and `isBlankReceipt`, and in recovery for manual entries | `receipt-reconcile-races.test.ts` R04 cases (add, edit, allocate, reorder, remove; a queued fill yields; a legitimate fill with a proposed BOGOF still works). Browser: Close, Escape and unload prompt; opening alone is not a change | The human discount was lost to a late proposal (`r04-before.log`) | None known |
| R05 | P1 | Corrected | `source` now means control. The form saves `'user'`; the server claims edited proposals on person writes (a stale copy cannot demote one; new records stay exact); native and MCP keep person records exactly; MCP refuses to remove a line a person's discount uses | `adjustment-ownership.test.ts`: the claim rule; extract, override allocation, amount or scope, save, rescan and post (native); the same through production routes and MCP | Shares 300/150 became 150/300 at a total of 450 (`r05-before-after.log`) | A rescan may again propose a line whose extracted record the person deleted; that proposal goes to review, not straight into the ledger |
| R06 | P1 | Corrected | Migration 0016 `receipt_operations`. A one-statement claim before budget, key or provider; the key covers trip, draft, fingerprint, photo, photo version and kind; concurrent requests get 202 and the current ledger; only the claim holder commits | `receipt-ai.test.ts` R06 (simultaneous requests: one call, one proposal, 202; repeated requests spend nothing); `receipt-operations.test.ts` (one owner among 30 concurrent claims across three connections; Miniflare D1) | The overlapping request made its own paid call (`r06-r07-before.log`) | Cross-instance concurrency was proven on shared SQLite and Miniflare D1, not on hosted D1 |
| R07 | P1 | **Mitigated; hosted durability gate open** | 120 s lease; outcomes recorded; takeover of failed or expired operations on a new request only; superseded attempts cannot commit; the commit retry never reruns inference | Crash after provider acceptance; failure before and after persistence; changed draft, photo or membership; slow superseded attempt; lease, takeover and retention rules | All route cases failed (`r06-r07-before.log`) | **Not exactly-once:** an attempt terminated after the provider accepted it is not refunded, and the next request spends once more. **No background completion:** a reading cut off after a disconnect beyond the platform grace period finishes only when someone asks again. Resuming without a request needs a Queue or Workflow plus credential re-authorization outside the browser session (credentials are session-bound today). That is a platform and credential-design change, not made here. The hosted lifecycle remains unreproduced |
| R08 | P1 | Corrected | `peopleSummary` returns `incomplete` trips; People names them and never shows the debt-free line or a complete total while they are left out. `paymentError` is the one payment rule for balances, the invitation preview and Activity | `personal-activity.test.ts` R08 (invalid-only open and archived, mixed with GBP and EUR, five invalid payments across four readers); `browser/people-incomplete.spec.ts` | "Nobody owes you, and you owe nobody." on an invalid-only ledger (`r08-before.log`) | None known |
| R09 | P2 | Corrected | Audit links to receipts that are not open open `ArchivedReceiptReview` (read-only, from the account's own server-checked archive); Restore and review is explicit; unavailable targets reveal nothing | `browser/audit-review.spec.ts`: archived target; explicit restore; revoked or deleted archive; guessed trip; guessed receipt; deleted open receipt | All six did nothing (`r09-before.log`) | None known |
| R10 | P2 | Corrected | Line order merges three-way: a one-sided reorder is kept, an incompatible one is an "Order of lines" conflict, and additions keep their place | `expense-merge.test.ts` R10 (the tied-penny consequence, both directions, same and clashing reorders, additions and removals, scoped references) | The reorder was lost (`r10-before.log`) | None known |
| R11 | P2 | Corrected | Migration 0015 guards the membership UPDATE trigger on every column; `/healthz` requires it | `membership-revision-migration.test.ts` (insert, delete, change, move to both trips, three no-op forms); health test | Recorded in-test: an identical update advanced the revision | Not a money defect |

## F-01 to F-21 status changes

Only affected rows change. The others keep `PROGRAMME.md`'s status; no PR has an independent re-review of these corrections yet.

- **F-01:** Implemented and tested. Historical audit links now reach archived receipts read-only (R09). Remaining: the live model evaluation (F-10) and review.
- **F-02:** Implemented and tested, with a server-enforced client compatibility boundary (R01), one ordered preview and save (R03), adjustment edits as unsaved work (R04) and person-controlled records (R05). Remaining: the hosted rollout gate and review.
- **F-04 and F-05:** Implemented and tested, with account-bound private panels (R02) and People that never presents an incomplete balance as complete (R08). Remaining: privacy review.
- **F-08:** Implemented and tested, with line order merged three-way (R10). Remaining: a two-browser test against a local Worker, and review.
- **F-11:** **In progress.** Durable claims prevent duplicate paid calls (R06). Completion after a disconnect beyond the platform grace period still needs a platform capability (R07). Remaining: the hosted lifecycle and the iPhone and PWA lock checks.
- **F-14:** Implemented and tested. Undo notices are bound to their account (R02).
- **F-16:** Implemented and tested. No-op membership updates no longer advance the revision (R11, migration 0015). Remaining: a production-sized copy, the backup and review.
- **F-20:** Implemented and tested. Invalid payments are named consistently across readers (R08).
- **F-12 and F-19** stay explicitly deferred (owner decisions).

## Rollout and rollback runbook

Owner approval is required for every step. The owner decisions stand:
- F-12 and F-19 deferred.
- Connected accounts may be added directly to bills.
- Deleted bills recoverable for 30 days.
- No silent historical recalculation.

1. **Before release:**
   - Take the D1 backup and R2 inventory record (`docs/operations.md`).
   - Record the production migration state.
   - Migrations `0014`, `0015` and `0016` apply in order and change no existing data:
     - `0014` adds the revision column and triggers.
     - `0015` replaces one trigger.
     - `0016` creates an empty table.
   - Test them on a production-sized copy first. That copy run is a gate; it has not been done.
2. **Deploy as one switch, never gradually.**
   - The money-format boundary relies on every Worker answering with the new code.
   - During a percentage rollout an old Worker would serve scoped records to an old bundle.
   - Server and client ship together in one Sites build.
3. **Bundles already open (main `01be219` or earlier):**
   - Their next ledger, activity or processing request gets 426 with "TripTab has been updated. Reload this page to see current amounts. Nothing was saved."
   - A fresh load shows no amounts.
   - A tab already showing data keeps its pre-release amounts, labelled "Refresh failed. Showing the last loaded amounts."
   - Their payment or edit saves are refused, so no gross-price suggestion can be recorded.
   - A reload fetches the new bundle, because the service worker never caches the app shell.
   - Watch for a spike of 426 responses after release: it is expected and should decay as tabs reload.
4. **Scoped records:**
   - Once any `scoped-adjustments` entry exists, **do not roll back below this release** (format 2).
   - Main `01be219` and earlier read those entries at gross prices: on the BOGOF receipt, Alice is told to pay Bob £6.75 instead of £3.75.
   - The only safe rollback target is a build that includes the boundary. To undo a later defect, roll forward.
   - Removing scoped records to enable a rollback would change financial records and needs explicit owner approval with the normal edit history; it is not part of this plan.
5. **Retained bills:**
   - Deleted bills stay restorable for 30 days (#75).
   - A rollback to a build without #75's readers could expose pending-deleted bills. Roll back only to builds that skip them.
   - This is unchanged by these corrections and is restated here for completeness.
6. **Receipt-processing claims:**
   - After a release that includes `0016`, a reading that the platform cut off shows "Reading didn't finish" (the #74 status) after its limit. The person, or another trip member, can retry.
   - A retry within 120 s of the original start returns "already being read", without spending.
   - Rolling the code back past 0016 is schema-safe: old code ignores the table. It also loses the duplicate-spend protection.
7. **Post-release smoke checks:**
   - Run `PROGRAMME.md`'s list on production with two test accounts.
   - Add an old-tab check: open the app before deploying, then confirm the reload message and that no amounts are shown after it.
   - Add `/healthz` ready, which confirms 0015 and 0016 are applied.

## Integration and conflict record

- **#70 into the #69 integration:** clean merge. #70 only rewrites `docs/remediation/PROGRAMME.md`, and its version was taken.
- **The two #69-only resolutions are retained and still exercised by the browser suite:**
  - The #71 drawer "Delete bill" shows #75's Undo.
  - #75's restoration uses #68's bill-only limit.
- **The leave-balance warning on shared lifecycle actions is unchanged.**
- **Corrective commits conflict only with each other in `components/trip-app.tsx`.** They were made sequentially on this branch. When cherry-picking onto separate PRs, follow the commit order in the table above.

## Release gates still open

Corrected code does not close these. Do not give release approval while any is open.

1. **Original-document reconciliation:**
   - Locate the November audit and D01 to D08.
   - Check R01 to R11 and F-01 to F-21 against them.
   - Compare these reproductions with the reviewer's `review-evidence` logs and `5c7df5a`.
2. **Independent review** of the corrective commits, and of every implementation PR.
3. **Production-representative migration and restore:**
   - `0014` to `0016` on a production-sized D1 copy.
   - The encrypted POSIX operator recovery drill (not run on Windows, and not run here).
   - Sites migration atomicity.
4. **Hosted durability:**
   - The actual Cloudflare/Sites lifecycle of a reading cut off after a disconnect.
   - A decision on a Queue/Workflow resume with request-free credential authorization (R07).
   - Verification of the current Workers limits page.
5. **Hosted rollout of the boundary:**
   - Confirm Sites switches all traffic at once.
   - Run the old-tab smoke check in production.
6. **Paid live model evaluation (F-10):** not run. No paid calls were made in this pass.
7. **Physical devices:** iPhone Safari, PWA lock and resume, and swipe.
8. **WebKit:** the combined WebKit result comes from CI on PR #77 (Playwright's Linux container). The reviewer's Windows WebKit layout failures were not reproducible here and need a separate look on that host.
