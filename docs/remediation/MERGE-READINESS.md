# Successor integration and merge readiness

7 November 2026. This is correction-phase implementation evidence, not an independent approval of these new changes or permission to deploy.

## Proposed production tree

Use `codex/remediation-merge-readiness-20261107` as a new successor integration branch targeting `main`. Do not merge #69, #77 or #78. Do not merge the earlier feature branches afterwards: their changes are already represented here, including the conflict resolutions and review corrections.

The starting point is main `01be219b2675ab6018d4090bf042e51400030eec`. Replaying 53 first-parent integration deltas and corrections produces `f0e062e1141880feafc5a14e5b3fd68058f8eff0`, whose tree is **exactly** #78's `d50d2c14dac40ef351a8fa8c64696db61f3aad99`: `2c3a6722fced8d4b5b2a9e4ee5051bfd9bc8f3ee`. The new corrections below are applied after that equality checkpoint. The machine-readable [provenance](MERGE-PROVENANCE.json) maps every replayed source commit to its successor commit and records all source PR heads.

Cherry-picking preserves content and attribution, but does not make every original feature head an ancestor. Original PRs will not automatically close. After independent approval and an owner-authorised successor merge, reconcile/close superseded PRs explicitly. Until then leave them unchanged. If main or a source branch moves, compare the new changes, update the successor, and repeat checks on its actual proposed merge tree.

## Corrections after the final independent audit

The independent audit of #78 concluded **Changes required**. That verdict remains the historical verdict for that SHA. The changes here implement its findings and related reproduced gaps; these implementation tests are not a substitute for an independent re-review.

| Finding | Failure established before correction | Correction and maintained regression |
| --- | --- | --- |
| N01, P2 | An in-flight notification could be written after its recipient left the bill or disabled notifications. | Guard inbox/digest persistence using current membership, account and preferences; recheck push/digest dispatch after asynchronous preparation. Preserve legitimate owner-without-membership delivery. `tests/notification-revocation.test.ts`: 19 cases, including four digest flush cutoffs. |
| N02, P2 | Import counted existing bills against the 50-holiday limit and used the wrong limit for bills. | Count the imported trip's kind; allow 50 holidays and 100 bills independently. `tests/import-limits-route.test.ts`: five real-route boundaries, with no mutation on refusal. |
| N03, P1 | A prepared ledger payment committed after the request's session was logged out or expired; related lifecycle/import paths shared this gap. | Capture an immutable, privately issued fence for the credential actually accepted by authentication. Check it in the final financial SQL gate, including native, offline, import, lifecycle and MCP writes. A valid native session remains independent of a remapped legacy provider ID. `tests/financial-write-revocation.test.ts`: 13 cases. |
| N04, P1 | Revocation/expiry during quota preparation still allowed the first receipt provider request, although the final receipt commit was protected. | Recheck grant, operation, source, membership and current credential versions immediately before each external call, including plan model discovery. Normal plan-token refresh updates the outbound header. The final database admission also fences settings/connection replacement. `tests/receipt-pre-spend.test.ts`: 15 cases. |
| N05, P2, owner decision | The ready notice depended on `request.signal` and was on for everyone. | Superseded by the owner's policy (final pass below): an optional, default-off *Receipt ready notifications* setting, decided from persisted operation state. `enable_request_signal` may stay for other uses; nothing depends on it. |
| Invitation cutoff, P1 | Prepared create, revoke and accept requests succeeded after logout; prepared acceptance succeeded after invitation expiry. All four adverse tests failed before correction. | Apply the same request fence to the transactional invitation mutations and use database time for invitation expiry. `tests/invite-authorization.test.ts`: four cases; existing invitation suite retained. |
| Paid translation cutoff, P1 | Paid names-only translation could start after logout, expiry, leaving the bill or removing credentials during preparation. Five adverse cases failed; the authorised control passed. | Apply the shared pre-provider request/credential/access guard and recheck before replying. Preserve normal token refresh and the free same-language path. `tests/translation-authorization.test.ts`: six cases. |
| R16 precision, P2 | The Julian-day floating point expression rounded some current-date instants down by 1 ms, accepting equality at the expiry boundary. | Use integer epoch seconds plus SQLite's millisecond digits. `tests/authorization-time.test.ts` checks all 1,000 milliseconds on each of four dates, plus expiry equality and the one-millisecond live control. |
| Receipt interaction, P2 | Safari focused the dialog during pointer-down; a scheduled footer reveal then moved the allocation control before pointer-up. The targeted regression failed in both engines before correction. | Exclude root-dialog focus, discard stale focus work and defer reveal/resize work while a pointer is held. Retain covered-input keyboard reveal. `tests/browser/receipt-money.spec.ts`: two focus controls plus four real-route financial journeys. |
| Fast swipe, P2 | A swipe completed within one React frame read stale painted state on release. The synchronous gesture test failed in both engines. | Track the current gesture position synchronously; state still controls rendering. `tests/browser/row-actions.spec.ts` covers fast completion plus short, vertical and unrelated-pointer controls. |
| Traveller focus, P2 | A previous render's passive effect could consume the submit focus request before the row became disabled. The final WebKit run exposed it; event traces reproduced six failures in 20 diagnostic runs. | Restore focus in a layout effect with the committed editable DOM. The existing browser test now also acknowledges the actual posted name, asserts Samuel remains saved and requires exactly one POST. |

No calculation algorithm or migration file is changed after the #78 equality checkpoint. F-12 (multiple payers) and F-19 (multiple receipt photos) remain intentionally deferred.

## Browser test corrections and coverage

The receipt layout failure was investigated using pointer/scroll traces. The dialog-focus movement above was a product defect. Separately, the foreign-item layout fixture returned an invalid FX response; its late error banner changed the layout during input. That fixture now supplies a valid rate and waits for the conversion. A separate test retains the recoverable FX-error layout. Unsupported Windows WebKit CSS properties are asserted conditionally using `CSS.supports`; supported-engine bounds and overflow assertions remain.

The new receipt-money tests use two actual cookie-isolated accounts, real production routes in local Miniflare, real D1/R2 bindings and a binary-preserving local HTTP proxy. Only the external provider and unrelated auxiliary endpoints are mocked. Assertions inspect stored trip JSON, calculation versions, shares, payments, revision/history, photo restoration and provider-call counts. They cover BOGOF/name/interruption, manual discount with the second allocation, History restore and a single persisted £3.75 payment. Existing two-account conflict/sharing tests remain.

The browser CI job now builds and serves the actual old main bundle at pinned SHA `01be219`, outside the current checkout. Cached-client compatibility cases therefore run on both engines rather than skipping because a historical preview is absent. The old bundle still demonstrates the unsafe £6.75 suggestion when the format boundary is deliberately bypassed in the test. Against the corrected production routes it cannot read new monetary data or post that payment; the supported bundle settles £3.75.

After the interaction correction, the targeted receipt/old-client group passed **60/60** across Chromium and WebKit over three repeats. The layout, row-action and row-menu group passed **106/106**, with no skips. Complete frozen-source results and exact CI SHA are recorded in the successor PR's verification section when available.

## Frozen-source verification

Application source checkpoint: `d75c77c040b90a54f3775c6cacf66afb1ee70365` (documentation/provenance may follow). Windows, Node 24.22.1, locked Playwright 1.62.1. Local provider calls are mocked; no paid inference or hosted resources are used.

| Check | Result |
| --- | --- |
| Full Node suite, including database/migration, privacy, concurrency and finance cases | **1,558 passed; 0 failed; 0 skipped** |
| TypeScript | Passed |
| ESLint | 0 errors; four existing warnings |
| Production build | Passed after stopping the preview that held the Windows output directory open |
| Re-executed independent financial/save-gate tests | **6 passed; 0 failed; 0 skipped**; includes both BOGOF allocations persisted/exported/reimported, 5,000 generated adjustment cases, 1,000 prior-version comparisons, item-order merge, settled history and written reconciliation exceptions |
| Full Chromium and WebKit | The preceding `7c199bc` build passed 265 Chromium cases, with no skips; WebKit passed 264 and exposed the traveller-focus defect corrected above. Final rebuilt runs are pending; see the successor PR's exact-HEAD verification rather than infer completion from targeted runs. |
| Traveller focus after correction | **40 passed; 0 failed; 0 skipped**, 20 repeats in each engine, with saved-name and single-POST assertions |
| Linux GitHub CI at successor HEAD / merge tree | Pending publication; do not reuse #78's green checks |

No tests are disabled, no automatic retries are configured, and both cached-client previews are supplied for final runs. An earlier complete Chromium attempt hit `net::ERR_NO_BUFFER_SPACE` during initial navigation, before its application workflow; that failure is retained separately from the final run. A first final build attempt was blocked by the running preview's Windows file handle; the preview was stopped and the same build then passed.

## Review and merge procedure

1. Review the source/provenance difference from main and the new corrections from the #78 equality checkpoint. Re-review the new fences, notification eligibility, provider refresh and UI interaction changes independently. Do not self-approve this correction work.
2. Require Node 24 regression, quality, both complete browser engines and the aggregate `verify` job at the exact successor HEAD. Verify GitHub's proposed merge-tree content equals the tested branch tree while main remains at the recorded SHA. Investigate failures; do not weaken assertions to obtain green checks.
3. The successor is the single proposed implementation route to main. The original dependency graph remains recorded for provenance: #64 depends on #61; #71 on #66; #72 on #67; #73 on #66; #74 on #65; #75 on #73; #76 on #63; #70 is programme documentation. Their integration/conflict resolutions are already in this tree. Do not independently merge stale feature heads into it.
4. Only the owner can authorise a merge or deployment. Merging code must not be presented as proof of the operational release gates below. Do not run production migrations as part of preparing this PR.

## Remaining production release gates

- Independent approval of the successor corrections and combined tree. The implementing session cannot supply that approval.
- Restore a genuinely representative current D1/R2 backup in isolation; rehearse migrations **0014 → 0015 → 0016 → 0017 → 0018**, validation, interruption/failure recovery and the POSIX restore procedure. The prior audit's synthetic migration drill is useful evidence, not a production-copy rehearsal. Migration `0018` (one column, off for all) is new in the final pass.
- Verify the platform's migration/deployment sequence can keep traffic gated between partial migrations, trusted identity headers, all-traffic server cutover and the financial-format boundary. `/healthz` must be ready, but is not a substitute for those checks.
- Physical iPhone Safari/PWA lock, reload, keyboard and swipe acceptance remains unperformed.
- Complete the authorised live receipt evaluation (F-10) with representative promotions, coupons, refunds, deposits and ambiguous negative amounts, checking extraction and final calculations. Synthetic fixtures are not live accuracy evidence; paid calls need owner authorisation.

**Accepted operational risk:** hosted scheduled background receipt recovery is unverified. Retain the owner-accepted `RECEIPT_BACKGROUND_RESUME=off` setting until the intended operational decision/testing. It prevents new scheduled resumes, not already-running requests or normal user scans. A crash after a paid request can cost one extra paid resume; the durable one-resume admission remains enforced atomically. Do not describe hosted recovery as observed.

**Rollback restriction:** after scoped-discount expenses exist, do not roll back below the compatible server/financial-format boundary. The historical client computes gross-price settlements incorrectly. Keep incompatible clients refused and roll forward with compatible code; preserve the database/R2 backup for recovery. See [operations](../operations.md) and [corrections](CORRECTIONS.md) for the release runbook and accepted constraints.

## Final pass before merge

Corrections added on top of this integration, each with tests that fail without it:

- **F1** Accepting an invitation now enforces the open-list limits (50 holidays, 100 standalone bills) inside the statement that admits the join, so two simultaneous acceptances cannot exceed them. Refusal is a 409 and writes nothing.
- **N05** Optional, default-off *Receipt ready notifications* (migration `0018`), one generic notice per stored operation from persisted state, idempotent across retries, takeovers and background resumes, never able to undo a saved result.
- **Settlement reminders** The requester's credential is part of the reminder's admitting statement (from the review pass; commits kept as authored).
- **F2** Receipt upload, receipt deletion and display-name change carry the same request fence. The profile race test now expects 401 (changed sign-in) instead of 409; its other assertions are unchanged.

Documented follow-ups (not release blockers; no failure reproduced that blocks release): **F3** draft/photo state is checked just before, not inside, the final inference admission statement; **F4** plan-token refresh can run before the final authorisation check (sends only the person's own refresh token to its issuer); **F5** the request fence is an optional argument of `writeLedger`/`writeTrips` (every caller passes it today); **F6** the account-level push re-check ignores trip membership (the push is content-free).
