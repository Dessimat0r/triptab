# Review corrections R15 and R16 (7 November 2026)

The independent review of PR #78 at `99e4437` (`PR-78-REVIEW.md`, supplied by the owner) requested changes for two reproduced defects in the execution grant introduced by `555ecf2`. Both are corrected on this branch and reproduced first. The reviewer's own `review-evidence/adversarial.test.ts` and `make-adversarial.mjs` were not available here; the journeys were rebuilt from the review's description as maintained regressions in `tests/receipt-grant-revocation.test.ts`.

| # | Pri | Defect | Correction | Before (at `99e4437`) | After |
| --- | --- | --- | --- | --- | --- |
| R15 | P1 | A ChatGPT grant was accepted when `grant_ref = user_id` without a link, bypassing normal authentication's rule that a legacy identity (profile ID = provider ID) with a password and no link is disconnected. Unlinking ChatGPT did not revoke a background reading's grant | One canonical predicate, `providerAuthenticatesAsSql` (`lib/receipt-operations.ts`), mirrors `authSnapshot`/`providerIdentity`: a link to the account, or the legacy fallback only when no link exists for that provider and the account has no password; account present and not deleted. Grant creation (`lib/auth.ts` `executionGrant`), the pre-spend checks and the commit gate all use it | Legacy unlink: background `resumed 1, stored 1, failed 0` while the ledger returned 401 for the old identity. **Also found:** remapping the provider identity to another account let the background attempt call the provider again (2 calls) | Both refused before any provider call, with no proposal, revision or history change and no retry. Controls pass before and after: separate IDs unlinked (refused), legitimate unlinked legacy and self-linked legacy (stored), session precedence (session grant survives unlinking ChatGPT), account deletion. A truth table (3 link states × password × same/different ID × deleted) shows the grant rule equals `resolveIdentity` in every case |
| R16 | P2 | Commit-time expiry compared deadlines with a JavaScript time captured before save preparation, so a session or grant that expired during preparation still passed | Every deadline in the owner condition is compared with the database's time inside the statement (`DB_NOW_MS`, `DB_NOW_ISO`: SQLite `julianday('now')` and `strftime(...,'now')`, fixed within one step). The pre-spend checks (`operationAuthorized`, `startProviderCall`) use the same condition and therefore the same clock. Lease and claim selection keep the Worker's time; they decide who may try, not whether the attempt may act | Session expiring during the commit pause: **200**, stored, history +1. Grant expiring after inference: **200**, stored | Both **409**, nothing written, operation failed. Controls at the same pause: an unexpired owner commits; a removed grant is refused |

Evidence: `correction-evidence/r15-r16-before.log`, `r15-r16-after.log`. Residual, unchanged: a ChatGPT grant cannot observe whether the platform's own ChatGPT sign-in is still active; it ends with unlinking, remapping, account deletion or the 30-minute expiry. Database and Worker clocks may differ slightly; the grant's 30-minute deadline is set from the Worker's clock and enforced on the database's.

---

# Second correction pass: R12, R07, R13 and R14 (7 November 2026)

**Status: corrected for independent review. Not release-ready.** R07 is implemented and locally proven; its hosted lifecycle is unverified and was **accepted by the owner without that test** (record below). The other release gates at the end of this section remain open. No merge, deployment, hosted resource, production data change, production migration or paid model call was made. Branch `claude/new-session-cus6bc`, draft PR #78, based on #77 (`2e8bbc8`) so its diff shows only this pass. #69 and #77 remain review vehicles; the original implementation branches were not rewritten.

## Provenance and limits

- **Refreshed on 7 November 2026:** main `01be219`, #77 head `2e8bbc8` (merge base `01be219`); no newer commits on either or on the other open PRs (#59, #63 to #76).
- **The reviewer's local evidence was not available here.** `C:/Users/garyo/triptab-corrections-review-20261107/` (CORRECTIONS-REVIEW.md, `recheck-evidence/`, `make-independent-checks.mjs`, `store-adversarial.test.ts`, `receipt-route-race.test.ts`, the Chromium/WebKit/clock/teardown logs) and the 6 November review folder exist only on the reviewer's Windows host. Each finding was taken from the brief's self-contained description and **reproduced independently here before it was fixed**; comparing these reproductions with the reviewer's logs remains an open check.
- **Runtime contract verified from source.** `developers.cloudflare.com` is refused by this environment's proxy, so the current pages were read from Cloudflare's documentation source (`cloudflare/cloudflare-docs`, `src/content/docs/workers/runtime-apis/context.mdx` and `workers/platform/limits.mdx`, production branch, fetched 7 November 2026): `waitUntil` extends execution "for up to 30 seconds after the response is sent or the client disconnects"; Cron Trigger and Queue consumer invocations may run 15 minutes.
- **Platform capability inspected:** `.openai/hosting.json` and the vendored Sites plugin declare D1, R2 and MCP only. No Queue, Workflow or Durable Object binding is available to this Site. Cron is (the build already declared one); whether Sites activates Worker Cron triggers in production is unverified (as before).
- **Environment:** Linux, Node 24.22.1 (official tarball, SHA-256 checked), Chromium 1243 via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` with Playwright 1.62.1. WebKit cannot be downloaded here; it ran in CI's pinned Playwright container (Linux). Neither environment is evidence for the reviewer's Windows host.

## Commits

| Commit | Finding | Summary |
| --- | --- | --- |
| `f2e1e0b` | R12 | Ownership and completion decided inside writeLedger's commit transaction; trusted operation fence |
| `555ecf2` | R07 | Durable job (migration 0017), execution grant, shared work module, background runner on Cron |
| `2c7a34e` | R07 | Follow-up: the Worker entry must not export a constant (found by the browser preview) |
| `adb059f` | R13 | Fixture date pinned; next-day control |
| `690dabb` | R14 | Ordered teardown; persisted payment journey |
| `571630f` | R14 | Follow-up: conditional reads forwarded without validators (found by CI WebKit) |

Plus this documentation commit. For cherry-picking: R12 and R07 belong with #74/#65 after `740f82c` (R06/R07 claims); R13 with #68; R14 with the R01 commit `b99b8a3` (#64).

## Closure matrix

| # | Pri | Status | Correction | Regression evidence | Before | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| R12 | P1 | **Corrected (reproduced and fixed)** | A successful claim issues an operation fence (a WeakSet-registered object; no request body, MCP argument or JSON value can be one). `writeLedger` takes the fence instead of the old `processing` flag, requires it with a scoped receipt save, adds "this attempt owns the running operation and its grant is live" to the guarded `sync_state` UPDATE that admits the whole write, and marks the operation stored in the same batch, conditional on that write. The route no longer checks or completes separately. All other checks unchanged; person saves unaffected | `receipt-commit-ownership.test.ts`: production process/ledger/upload routes on Miniflare D1/R2, the commit batch paused after every pre-write check (`helpers/workers-shim.ts`) so a real second request takes over exactly there. Takeover before commit (409, zero ledger/history/revision change, B stores the only proposal); current-owner control at the same pause; a person's edit wins; commit failure then retry; loss right after commit; overlapping requests make one provider call; forged fences refused. Unit: only claims issue fences | `r12-before.log`: superseded attempt got **200** and its proposal was stored; loss after commit left the proposal stored but the operation **failed** (claimable again) | A takeover after the lease still means both attempts reached the provider (documented) |
| R07 | P1 | **Implemented and locally proven. Owner-accepted risk: hosted behaviour unverified** (7 Nov 2026; kill switch added) | See "Background receipt completion" in `docs/operations.md`. The operation row is the durable job (0017). The claim stores the request's identifiers and an execution grant (server-side session ID or trusted ChatGPT identity; 30 min; never a cookie or token). A per-minute Cron (`* * * * *`, plus every 15-minute maintenance run) resumes an attempt whose lease ran out without an outcome, once, with server-held credentials, rechecking source, photo version, membership, grant and credential kind before spending, and committing through R12's fence. Failed operations, persistence conflicts and refused commits are never retried; the client's "stalled" threshold covers the background window | `receipt-background.test.ts` (20 cases, production routes and runner on Miniflare D1/R2, mocked provider): cut-off reading completes with no browser request while its background inference is held long; reconnect gets 202, spends nothing; the late attempt writes nothing; duplicate runner deliveries plus a person's retry give one resume and one proposal; 11 revocation/credential cases before the attempt spend nothing and are not retried; 4 during it are not committed; failed readings never resumed; resumes bounded; connected readings need no runner. Scheduler, health and reading-status tests | `r07-before.log`: with R12 only, operation stays `running` and the draft `waiting` after the lease, no runner | **Hosted lifecycle unverified** (Sites Cron activation, a real long disconnect, iPhone/PWA). **Crash-window spend:** provider requests are `store: false`, so a call accepted for a cut-off attempt cannot be retrieved and the resume pays once more (at most once per operation). Removing it needs provider-side stored responses (owner privacy decision) |
| R13 | P2 | **Corrected (reproduced and fixed)** | One fixture-day constant; every case pins the browser clock to midday on it (timers run). New control: the same bill on the next day saves with no warning. `lib/duplicates.ts` unchanged | `resilience.spec.ts` F-09 and the control 12/12 over six repeats | `r13-before.log`: F-09 failed 3/3 on 7 November | None known |
| R14 | P2 | **Corrected; WebKit confirmation in CI** | `withFlow()`: mark closing (new routed requests aborted on purpose), drain in-flight handlers, close the page, then dispose the Worker; handler errors are not suppressed. The current-bundle test records the £3.75 payment through the real route and checks the persisted payment, unchanged expense, empty settlements, one revision and one POST 200. Conditional reads are forwarded without validators because Playwright cannot fulfil a 304 | Chromium with a real previous-main preview: 12/12 over three repeats; full suites below | `r14.log`: the reviewed spec passes 8/8 on Chromium; an evidence-only spec (`r14-mechanism.spec.ts.txt`) gets "Cannot use disposed instance" with the old order and none with the new. CI WebKit then caught the 304 defect in the new journey (`571630f`) | Windows WebKit not rerun |

## Verification on the final tree

Linux, Node 24.22.1, 7 November 2026. Logs: `correction-evidence/second-pass-*.log`.

| Check | Result |
| --- | --- |
| Units (`npm test`) | **1,475 / 1,475 passed**, 0 skipped (baseline here 1,442) |
| Types (`tsc --noEmit`) | Passed |
| Lint | 0 errors, 4 warnings (the same pre-existing four; none in changed files) |
| Production build | Passed |
| Chromium, full suite, local, with `TRIPTAB_PREVIOUS_URL` = separately built main `01be219` | **243 / 243 passed, 0 skipped** (at `690dabb`; `571630f` changes only the forwarding helper, rerun 12/12) |
| CI (GitHub Actions run 42368152067, Playwright 1.62.1 container, Linux) at `c6751bc` | All checks green: quality, regression, **WebKit 240 passed / 3 skipped / 0 failed**, Chromium 240 passed / 3 skipped (the skips are the previous-bundle tests, which need a main preview; they passed locally above). Earlier, at `690dabb`, WebKit was 239 passed / 1 failed (the 304 defect, fixed in `571630f`) |

Financial outcomes required to be preserved are asserted by unchanged, passing tests: BOGOF 300/300/150 → 450 and shares 375/75 or 150/300 (`adjustments`, `receipt-ai-promotions`, `adjustment-ownership`, `browser/discounts`, `browser/cached-client`); fixed £2 then 50% → £4 (`adjustment-preview`, `browser/discounts`); human allocations surviving native and MCP rescans (`adjustment-ownership`, `mcp`); old rules unchanged (`model`, `financial-format`); cached clients fail closed (`financial-format`, `browser/cached-client`); £20 settled with £10 then deleted reopens £10 and £30 reopens £5 (`settlement-impact`). Account-state privacy, unsaved adjustments, archived review, line-order merge and the no-op membership trigger keep their R02/R04/R09/R10/R11 tests, all passing. F-12 and F-19 stay deferred.

**WebKit investigation.** Not possible on the reviewer's host from here. In CI WebKit at `690dabb` and again at `c6751bc`, every receipt-layout, empty-bill close, R03 save and reconciliation-exception case passed; the only failure was the new journey's 304. The intermittent `expense-layout 1024×768 receipt` failure (run 42310528517) did not recur in this pass's runs and is not root-caused; it stays a gate. No retries, skips or weakened assertions were added.

## Owner risk acceptance: R07 without the hosted test (7 November 2026)

**Decision.** On 7 November 2026 the repository owner, in the Claude Code session that produced this branch, chose to proceed without the hosted R07 verification and asked for a kill switch and this record. This supersedes the brief's instruction to keep R07 blocked, and only that instruction. It is a risk acceptance, **not** a verification: nothing below has been observed on Sites. The decision was given in that session; it has no separate signature, and the owner may countersign it in review.

**What is accepted as unverified on the hosted Site:**
- whether Sites activates the `* * * * *` and `*/15 * * * *` Cron triggers;
- whether a reading cut off after a real disconnect is resumed and stored, including the iPhone Safari and PWA lock-and-resume cases;
- whether the execution grant (session ID or trusted ChatGPT identity) and server-held credentials behave on Sites as they do in Miniflare;
- the 30-second post-disconnect limit as it applies on Sites (taken from Cloudflare's documentation source, not observed).

**Why the downside is bounded (from the code and local tests, not hosted observation):**
- If the triggers never run, interrupted readings behave as in the reviewed candidate: they wait for the person to read again. Nothing breaks and nothing is spent.
- If grant or credential checks behave differently on Sites, the background attempt fails before the provider call or is refused inside the commit: no ledger write.
- Extra spend is at most one provider call per interrupted operation (`MAX_AUTO_RESUMES = 1`), within the existing processing budget.
- R12's commit fencing does not depend on Cron and is fully covered by local tests.

**Conditions that still apply:**
1. Migration 0017 ships with 0014 to 0016 (and the production-sized copy gate stays open); without it receipt processing fails and `/healthz` is unavailable.
2. The kill switch `RECEIPT_BACKGROUND_RESUME=off` (runbook: "Background receipt completion") is the response to any of the warning signs listed there.
3. The rule against rolling back below the financial-format boundary is unchanged.
4. The hosted procedure stays recommended as a post-release check; the shortest useful version is the per-minute trigger appearing in Workers logs plus one reading with the browser closed showing `native-processing-resumed` then `native-proposal-stored`.

**Kill-switch evidence (local):** `receipt-background.test.ts` adds two cases: with the variable `off`, `OFF`, `false`, `0` or `disabled` the runner reads, writes and spends nothing, leaves the operation exactly as the platform left it, and a person's own retry still stores one proposal; unset, empty or `on` keeps it on, and typos turn it off. Units 1,477/1,477. A build with the variable set carries it into `dist/server/wrangler.json`; the default build does not.

## Migration, configuration and rollback

- **0017** adds nullable columns and an index to `receipt_operations`; no data change. Apply after 0014 to 0016 on the production-sized copy (gate below). `/healthz` requires it.
- **Cron:** the build now declares `*/15 * * * *` and `* * * * *`. Sites must activate both; with only the 15-minute trigger, interrupted readings finish up to 15 minutes later.
- **No new secret.** The runner uses the existing `RECEIPT_AI_TOKEN_KEY` and stored plan connections. One optional variable: `RECEIPT_BACKGROUND_RESUME` (the kill switch; unset means on).
- **Rollback:** code below this pass with 0017 applied is schema-safe (columns ignored) but loses R12's atomic fence and R07's resume. The earlier rule stands: never roll back below the financial-format boundary once scoped records exist.

## Release gates still open

1. Original-document reconciliation. **Partly done (7 November 2026):** the owner supplied the November audit, and D01 to D08 are now recorded in `PROGRAMME.md` (recommended options adopted; D05's missing creator was added the same day, from history, `correction-evidence/d05.log`). The finding-by-finding and acceptance-test reconciliation is in [`AUDIT-RECONCILIATION.md`](AUDIT-RECONCILIATION.md): no conflict with the audit's expectations and no financial outcome affected, with gaps listed there; gaps 1 to 5 were addressed the same day (ready notification, restore-path tests, Activity date and bill filters, two-account acceptance runs for 4, 7, 8 and 9, and an inbox name field), see its update section. Still open: comparing these reproductions with the reviewer's `recheck-evidence`.
2. Independent review of R01 to R14 and every implementation PR.
3. Production-representative D1 migration and restore through 0014 to 0017; the encrypted POSIX recovery drill; Sites migration atomicity and all-traffic rollout.
4. **R07 hosted: accepted by the owner without verification (see above).** Still recommended after release: the shortest check (per-minute trigger in the logs, one closed-browser reading resumed and stored). Still open as a decision: provider-side stored responses, if the crash-window spend is not acceptable.
5. Authorized live AI evaluation (F-10); physical devices.
6. WebKit: the intermittent CI receipt-layout case and the reviewer's Windows-host failures.

---

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
| R01 | P0 | Corrected (code); hosted rollout gate open | The server refuses ledger money to bundles that do not declare format 2. Covers `/api/ledger` GET/HEAD/POST, `/api/activity`, `/api/receipt/process` (before inference), `/api/trip?mode=archived-data`, and, added in the final pass, `/api/export`, `/api/receipt/audit`, `/api/import`, `/api/offline-expenses` and `/api/invite` (preview and every write; the invitation list carries no money and is not gated). Only the exact supported format is accepted: a request declaring none, an older format or a newer one is refused (426), so a declaration of 3 is refused just as 1 is. The refusal is a 426 with a reload message, sent before auth, reads, writes or spending. This bundle fails closed on a future format, and readers refuse unknown calculation rules | `financial-format.test.ts` (production routes in Miniflare: undeclared, format 1 and unreadable declarations; no money or account leaked; no write); process route refused before key lookup; a static check that every gated fetch declares the format (flags main's four sites). `browser/cached-client.spec.ts` runs **main `01be219`'s real bundle and this bundle against the real routes** | The control reproduces main showing "pays Bob £6.75" and a £7.50 total; the protective tests fail against the pre-fix server (`r01-before.log`) | A main bundle opened before release keeps its pre-release amounts, labelled "Showing the last loaded amounts", until reloaded (it never receives scoped records, and its writes are refused). Rollback below a format-2 build after scoped records exist shows wrong money (runbook). A gradual or percentage rollout would defeat the boundary |
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

## Verification results

The code under test is `ce2e082` (the docs-only commits after it change no code). Runs were made on Linux with Node 24.22.1, on 6 November 2026.

| Check | Command | Result | Time |
| --- | --- | --- | --- |
| Units (complete) | `npm test` | **1,442 / 1,442 passed**, 0 failed (review baseline 1,403) | 66 s |
| Types | `npx --no-install tsc --noEmit` | Passed | 9 s |
| Lint | `npm run lint` | 0 errors, 4 warnings (the same four as the baseline) | 36 s |
| Production build | `npm run build` | Passed | 10 s |
| Chromium, full suite, local | `playwright test --project chromium`, with `TRIPTAB_PREVIOUS_URL` set to a separate build of main `01be219` | **242 / 242 passed**, including the three previous-bundle tests | 149 s |
| Chromium, CI (combined head `6e9ce7f`) | GitHub Actions in Playwright's container | 239 passed, 3 skipped (the previous-bundle tests, which need a main preview) | 2.9 min |
| WebKit, CI (combined head `6e9ce7f`) | GitHub Actions in Playwright's container | **239 passed**, 3 skipped (the same three) | 3.2 min |
| Migrations | `membership-revision-migration`, `trip-revisions-migration`, `health` and `receipt-operations` tests (Miniflare D1 with every migration) | Passed | within units |

Logs are in `correction-evidence/final-*.log`.

**One intermittent WebKit failure is recorded, not dismissed.**
- On CI at `740f82c`, WebKit failed 1 of 236. The test was `expense-layout.spec.ts › 1024×768 › receipt fits without clipping`: the "Show first for item 1" select was not found within 5 s.
- It passed on the next combined run (`6e9ce7f`), and at `c0566c1`.
- That select renders only once the receipt's bilingual names are known, which depends on the trip-language read. None of these corrections touch that code.
- The trace is in that run's `browser-failure-webkit` artifact (run 42310528517).
- The root cause is not established. It is close to the WebKit receipt-layout instability the review saw, and it needs its own investigation. It is listed as a release gate.
- The review's Windows-host WebKit layout failures (28 of 37 on baseline main) were not reproducible on Linux.

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
8. **WebKit:**
   - Root-cause the intermittent `expense-layout 1024×768 receipt` failure above, using the CI trace.
   - Look at the reviewer's Windows-host WebKit layout failures on that host.
