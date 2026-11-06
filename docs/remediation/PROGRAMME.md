# TripTab approved remediation programme

Owner brief and evidence baseline: **TripTab Functionality, Usability and Financial Accuracy Audit — 6 November 2026**, audited commit `48de3f9`. D01–D08 and the additional owner decisions govern this programme. This record describes implementation evidence, not approval to release. No merge, deployment or production migration is authorised.

## Baseline — 6 November 2026

- Latest fetched `origin/main`: `48de3f99580337cc2190db013033276744431df9`; clean source checkout initially. Matches the audited commit.
- Open PR query through the connected GitHub application: **none** at baseline. Local `gh` has no login; connector has repository write access.
- Windows / Node `v24.22.1`: **1,325 / 1,329 tests pass**. Two failures invoke unavailable `python3` (Windows Store alias); two route-boundary assertions compare normalised framework paths with native Windows paths. Original Node 22 claim is being checked independently (F-21).
- Baseline production build and `tsc --noEmit`: **pass**. Build only, using synthetic `ci-owner@example.invalid`; no inference or production access.
- Local raw evidence: ignored `outputs/baseline-tests-node24.log`, `outputs/baseline-build-node24.log`, `outputs/baseline-types.log`. Portable committed result records will accompany each change.
- Calculation rules: absent legacy rule, `selected-participants`, `receipt-total`, `rotating-remainder`, current `native-minor-units`. Monetary records must retain the rule and results already stored unless explicitly corrected.
- Persistence: Cloudflare D1, JSON trips plus relational memberships, append-only activity, R2 receipt images, global `sync_state` CAS. Fourteen checked-in migrations `0000`–`0013`. README's statement of twelve migrations is stale. Local isolated migration state will be recorded with integration results; production migration state has **not** been inspected or changed.
- Deployment: Vinext / React 19 Worker built with Vite; Sites managed source/deployment is separate from this GitHub mirror. Pushing a PR does not deploy. No production changes.
- Receipt evaluation: v1 golden corpus and synthetic arithmetic tests; `evaluation-status.json` explicitly `not-run`. Live model verification is **not available as evidence** yet.
- Latest versions of all owner-listed files are present at the audited main SHA. The directly checked F-01, F-03 and F-08 defects remain in source. No finding is marked already fixed without specific verification.
- Implementation workers use the requested **GPT-6 Sol / Extra High**. Claude Opus 5.5 is not exposed by this session; requested Opus review gates remain pending rather than being substituted silently. A separate GPT-6 Sol Extra High final audit is allowed by the owner and will be recorded separately from implementation.

## Closure tracker

Statuses: Unresolved; Already fixed and verified; In progress; Implemented and tested; Blocked; Explicitly deferred. Tests and reviews must name actual evidence. A code commit alone does not close acceptance.

| Finding | Priority | Phase | Capability | Status | PR / exact head | Tests / review evidence | Dependencies / remaining blockers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F-01 | P0 | 1, 3 | Receipt total gate, exceptions, historical audit, promotions | In progress | Pending | Baseline defect confirmed; review pending | Phase 3 scoped discounts; live receipt verification |
| F-02 | P0 | 3 | Scoped multiple discounts and charges | Unresolved | — | — | Phase 1; new calculation rule and compatibility gates |
| F-03 | Immediate | 0 | Scrollable holiday/bill navigation | Implemented and tested | [#59](https://github.com/Dessimat0r/triptab/pull/59) / `445fe617a93d438c48661bd9c6145026326ab85a` | Build; 8 new + 54 existing browser checks pass on Chromium/WebKit | Independent review pending; no physical-device check |
| F-04 | P1 | 6 | Verified connected accounts and bill participation | Unresolved | — | — | Server relationship verification and two-account privacy tests |
| F-05 | P1 | 6 | Unified Activity and People | Unresolved | — | — | Authorised data, separate currency and bill obligations |
| F-06 | P1 | 5 | Visible row menus, swipe, safe bill lifecycle | Unresolved | — | — | Server deletion safeguards, accessibility |
| F-07 | P1 | 4 | Unified scan entry and protected optional description | Unresolved | — | — | Scan proposal merge and browser tests |
| F-08 | P0 | 2 | Semantic concurrent-edit merge | In progress | Pending | Baseline whole-form overwrite confirmed | Pure merge core, UI conflict resolution, real server sessions |
| F-09 | P1 | 7 | Duplicate expense / receipt warnings | Unresolved | — | — | Explicit override and low false positives |
| F-10 | P0/P1 | 3 | Consistent promotion extraction and real model evaluation | Unresolved | — | v1 live evaluation not run | Safe fixtures and inference credentials; release gate |
| F-11 | P1 | 4 | Durable, idempotent receipt processing | Unresolved | — | Abort coupling confirmed in source | Durable Worker mechanism; device/PWA checks |
| F-12 | Deferred | — | Multiple payers on one expense | Explicitly deferred | — | Owner decision D08 | Future programme after core remediation |
| F-13 | P1 | 5 | Settled expense consequence warnings | Unresolved | — | — | Preserve payments and show actual resulting obligations |
| F-14 | P1/P2 | 5, 7 | Reliable undo and recovery | Unresolved | — | — | Server recovery, image retention truthfulness |
| F-15 | P2 | 5, 7 | Accurate contextual wording | Unresolved | — | — | Kind-aware copy and accessible names |
| F-16 | P2/high risk | 7 | Narrower sync conflict boundaries | Unresolved | — | Global revision confirmed | Separate high-risk PR and migration review |
| F-17 | P2 | 7 | Separate limits and manual archiving | Unresolved | — | Shared max-50 schema confirmed | Friendly server/client limits, no automatic archive |
| F-18 | P2 | 7 | Account-isolated unsaved manual entry recovery | Unresolved | — | — | Safe storage, explicit resume, idempotent submissions |
| F-19 | P2 | 7 | Multiple photos for one receipt | Unresolved | — | — | Processing and reference lifecycle |
| F-20 | P2 | 7 | Identify invalid expenses and label incomplete totals | Unresolved | — | — | Never issue unreliable settlement instructions |
| F-21 | P2 | 7 | Runtime/test portability and documentation | Implemented and tested | [#60](https://github.com/Dessimat0r/triptab/pull/60) / `391adb5ae36b8d60ed025284a8f751cc867f3b4c` | Node24 1329/1329, build/types pass; Node22 after Windows corrections 1324/1329 | POSIX backup scenarios require CI; native Windows backup fails closed; review pending |

## PR and merge order

1. Phase 0 navigation — independent of financial changes.
2. Phase 1 reconciliation and read-only history audit.
3. Phase 2 concurrency, dependent on Phase 1 only if stacked UI changes require it.
4. Phase 3 adjustment model / AI / integration (split into coherent dependent PRs as needed).
5. Phase 4 capture and durable processing.
6. Phase 5 actions, consequence safeguards and recovery.
7. Phase 6 verified bill relationships and personal financial views.
8. Phase 7 independent resilience PRs; narrower revision/migration work isolated.

F-21 portability can merge independently. All PRs start as drafts. No PR is merged by this programme. Each inventory entry must include exact SHA, test result, migration/permission/compatibility impact, review status and blockers.

## Release gates

- Unresolved P0 or required financial/privacy verification prevents production readiness.
- Existing balances are never automatically corrected. Historical discrepancy inspection is read-only; authorised correction uses normal edit/history.
- Application rollback after new-format financial records exist may be unsafe. New adjustment format requires an explicit reader/writer compatibility and rollback plan before production approval.
- Owner approval remains required for merging, deployment and production migrations.

## Implementation record

### Phase 1 initial implementation

Authoritative reconciliation requires a fingerprint-bound reason (1–500 characters) for mismatched totals/subtotals. Ordinary bulk review never creates an exception. Legacy reasonless acknowledgements remain readable for historical inspection but cannot authorise a new/changed mismatch. MCP cannot manufacture human exceptions. Saved scan evidence must survive editing and draft promotion. Exceptions retain `needs-review` and before/after history includes the reason.

Historical receipt inspection uses a pure classifier and a paged, server-authorised read including archived trips. `/api/receipt/audit` returns only current owner/member records; an unrelated/guessed trip is rejected. The current trip's History exposes the report and expense review links. Account-wide archived reports can be downloaded page by page; an archived trip must be restored through normal lifecycle controls before editing its expense.

Evidence at initial commit: **172/172** targeted unit/persistence checks, TypeScript and build pass. Lint has no errors. Browser confirmation suite first run: 33/34 pass; one clean-scan WebKit save timing failure is under investigation, so browser acceptance is not yet complete. Dedicated mismatch UI regression is being added. This phase does not implement scoped discounts; F-01 remains in progress until Phase 3 and all acceptance gates pass. No schema migration; additive acknowledgement reason is the compatibility change.
