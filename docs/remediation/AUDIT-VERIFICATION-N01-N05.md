# Independent audit N01–N05: verification of #79 and the gaps it left

> **Status update (final pass).** This file records the verification pass on #79 and is kept as review evidence, not release content. Since it was written: the reminder fix it describes is part of the release branch; **F1** (invitation limits), **N05** (optional receipt-ready notifications, migration `0018`) and **F2** (receipt upload/delete and display-name fence) were implemented with tests; the "open product decision" for N05 below is superseded by the owner's policy; F3 to F6 remain documented follow-ups. See `MERGE-READINESS.md`, "Final pass before merge".


Status: **draft for independent re-review. Not merged, not deployed, no production data or migration touched, no paid inference.**
Stacked on #79 (`ef3acf9`); this branch adds tests, one fix and this report.

## Why this is a verification pass, not a second implementation

The brief names #78 (`d50d2c1`) as the baseline and asks for N01–N05 to be implemented. Refreshing GitHub first
showed #79 (`ef3acf9`, opened after the audit, same tree as #78 plus the corrections) already claims all five. Rebuilding
them from #78 would have produced a second competing candidate, and the brief itself says not to build from an
outdated baseline. #79 is same-programme work, not independently reviewed, so this pass treats its claims as
untrusted: it reproduces each finding on the #78 tree, checks #79 against the same scenarios, widens the scenarios
to the brief's full lists, audits adjacent paths, and fixes what it finds.

Sol's local evidence directory (`C:/Users/garyo/triptab-independent-final-audit-20261107`) was not accessible; nothing here
claims to have inspected it. Failures were reproduced from the audit's written scenarios. #79's tests named
"Independent …" are ports of Sol's scenarios; they were not re-derived here.

## Method for "fails before, passes after"

Every new test file was run against the #78 tree (with only the test helpers copied in) and against #79. A test that
passes on both is a control, labelled as one.

## Results by finding

| Finding | Fails on #78 (`d50d2c1`) | Passes on #79 (`ef3acf9`) | Gap found in #79 |
| --- | --- | --- | --- |
| N03 financial commit after revocation | 8 of 14 (`200 !== 401`: whole-ledger and per-trip × explicit revoke, account deletion, provider unlink, provider remap). 6 controls pass on both | 14/14 | **Yes, fixed:** settlement reminders (see below) |
| N04 first provider call after revocation | 4 of 8 (remap, photo deleted, photo replaced, claim taken reach the provider). 4 controls/limits pass on both | 8/8 | none found |
| N01 notification eligibility | 8 of 11 at the push/digest-push boundary (pushes sent to travellers who had become ineligible) | 11/11 | none found |
| N02 import limits | 2 of 5 (restore at limit, independent limits) | 5/5 | none found |
| N05 receipt-ready notice | n/a (see below) | 3/3 for the signal-independent branch | **Open product decision** |

On #78, #79's own seven new files fail as well (for example 15/15 pre-spend and 15/19 notification cases), which
independently confirms the original findings. `financial-write-revocation.test.ts` failed there only at import,
so it is not counted as a behavioural reproduction; the N03 rows above come from this pass's own black-box file.

### N03: what was checked
Test: `tests/audit-n03-commit-authorisation.test.ts`. Production handlers, Miniflare D1, final commit held then released.
Refusals assert 401, and unchanged trip data, trip revision, ledger revision, history and notifications, with no retry
(commit-batch count unchanged). Controls: valid session and valid provider commit once with one history event; a member who
left is refused; a genuine same-trip conflict is still 409, not an authorisation error.

Note on unlink: after a provider is unlinked, a header-only request is not refused. It resolves under the designed legacy
rule to a fresh empty profile named by the provider id. The fence still refuses the held write.

### N03 cross-path assessment (writers of financial or credential-adjacent state)
| Path | Request fence at admitting statement | Result |
| --- | --- | --- |
| `/api/ledger` whole-ledger and per-trip | yes | tested |
| `/api/import`, `/api/offline-expenses` | yes | tested by #79 (route loop) |
| `/api/trip` lifecycle (archive, restore, leave, delete, restore/purge-deleted, add-connected, transfer) | yes | tested by #79 for delete/restore/purge |
| `/api/invite` create, accept, revoke | yes (expiry checked in the statement) | tested by #79 |
| `/mcp` ledger writes | yes (credential kind recorded) | tested by #79 (unlink, remap) |
| Receipt operation commit (service-authorised) | execution grant, R12/R15/R16 | tested by #79 and existing suites |
| `/api/receipt/translate` | yes (spend) | tested by #79 |
| **`/api/remind`** | **no in #79** | **gap, fixed here** |
| `/api/receipt` POST (photo upload) and DELETE | no | **not changed, see below** |
| `/api/profile` POST (display name) | no | **not changed, see below** |
| `/api/trip-language`, `/api/interface-language`, notification preferences, push subscription | no | own-account preferences; not changed |
| `/api/account` delete / revoke-session, `/api/auth` | authenticate the request themselves (password / session) | not reviewed in depth |

**Fixed: `/api/remind`.** A reminder writes a notification into another traveller's inbox on the requester's behalf. #79
checked the recipient (membership, preference, deleted profile) in the admitting statement but not the requester: a reminder
prepared before the requester signed out, or before their account was deleted, still delivered. The admitting INSERT now
carries the canonical request fence and a refusal is a 401. Tests: `tests/audit-reminder-authorisation.test.ts`
(requester signed out and requester deleted failed before the change; recipient-side cases already held).

**Not changed, reported:** receipt photo upload and delete, and display-name change, authenticate at request start and
write without the request fence. They affect only the requester's own data and are not financial writes. A request already
in flight when the session is revoked can still complete. This is the same class as N03 at lower severity; fencing
`receipt-lifecycle.ts` is a larger change than this pass justified. Recommended follow-up.
Not reviewed in depth: `/api/account` and `/api/auth` mutation paths (they re-verify the credential themselves).

### N04
Test: `tests/audit-n04-admission.test.ts`, added to #79's six cutoffs. Linearisation point (as implemented): the guard in
`requestProvider` runs before every outbound fetch, including ChatGPT model discovery, and its last step is the
`startProviderCall` UPDATE evaluated with database time. Nothing asynchronous follows it. The R12 commit fence is separate.
Quota note: the per-user and shared counters are consumed before the guard, so an operation refused at the guard has
consumed one quota slot; no provider cost is incurred. Whether that counts as "unjustified budget consumption" is a policy
call; it was not changed.

### N01
Test: `tests/audit-n01-push-boundary.test.ts`. #79 guards the inbox insert, the daily-digest insert, push dispatch and the
digest flush; there were no push-boundary tests. All three production `INSERT INTO notifications` sites are guarded
(`notifyMembers` path, digest flush, reminders). The default `notifyAccountPush` re-check covers account existence and
delivery preference but not trip membership; the push body is empty, so nothing private leaves the server.

### N02
Test: `tests/audit-n02-import-limits.test.ts`. Both limits are enforced at persistence by `validateLedger` (open trips only;
archived trips do not count) and by the global-revision compare-and-swap, so concurrent imports cannot exceed either cap.
The route pre-check only supplies a friendlier message.

### N05: open product decision (not resolved here)
`#79` enabled `enable_request_signal` in `vite.config.ts`. The notice for a reading that finishes in the request runner after
the browser has gone depends on `request.signal.aborted` being true at save time.

Evidence gathered, local only:
* The flag and its counterpart exist in the installed workerd (2026-05-15).
* A real disconnect experiment on that workerd, standalone, with the pinned compatibility date and `enable_request_signal`,
  dropped a raw TCP connection 400 ms into a request whose handler stayed running. Over the next 3.8 s `request.signal.aborted`
  stayed `false` and no `abort` event fired (detached work continued). Without the flag the result was the same. Under
  Miniflare the signal also never fired, and without the flag a disconnect cancelled the detached work.
* This is inconclusive for the hosted platform (the local server may not observe a half-open connection until it writes).
  It does mean the signal-dependent branch is **unverified**, and the local runtime gives no evidence the flag makes it work.

Why not simply remove the dependency: the service worker (`public/sw.js`) shows a visible notification for every push and
does no foreground suppression (required for iOS push). Notifying on every completion would show a redundant notice to
people watching the reading. That is a product decision.

Options for the owner:
1. Keep #79's approach and treat hosted disconnect delivery as a release gate (verify on the deployed Worker).
2. Notify on every completed reading (simple, durable, preference-aware, redundant for connected users).
3. Notify only if the response was not acknowledged by the client within a grace period (needs an acknowledgement and a delay; larger change).

Recommendation: 1 until hosted behaviour is checked, with 2 as the fallback if the signal does not fire in production.
The signal-independent behaviour is tested in `tests/audit-n05-ready-notification.test.ts`: background completion notifies
the starter exactly once across duplicate ticks, a retry and a late original; an account deleted, or a member who left,
during processing gets nothing and nothing is stored. The existing F-11 tests cover preference-off and the connected-page case.

## Test evidence

Run locally on Linux, Node 24.22.2, on this branch's committed tree (stacked on #79 `ef3acf9`):

| Check | Result |
| --- | --- |
| Unit suite (`tsx --test tests/*.test.ts`) | **1,605 passed, 0 failed, 0 skipped** (#79 reported 1,558; +47 new tests across six files) |
| `tsc --noEmit` | passes |
| Lint | 0 errors, 4 existing warnings |
| Production build (`RECEIPT_AI_OWNER_EMAIL` set to a placeholder; nothing deployed) | passes; `dist/server/wrangler.json` contains `"compatibility_flags":["nodejs_compat","enable_request_signal"]`. Whether the hosting platform retains the flag is not verified |

An earlier full run of this branch had 1,601 of 1,602 passing: the one failure was the existing settlement-reminder route test, whose module
stubs did not provide the request fence my `/api/remind` fix needs. The stubs were extended (assertions untouched) and the clean run above followed.

GitHub CI on #79's exact head `ef3acf9` (run 42406542154, Linux ubuntu-24.04): `quality` (types, lint), `regression`,
`browser (chromium)`, `browser (webkit)` and `verify` all succeeded. CI for this branch's head is separate and not yet seen.

Not run in this pass: Chromium and WebKit locally, the financial property suites as a separate step, migration 0014–0017 rehearsal.
The browser suites were not re-run here; this branch changes only tests, one API route and docs. The brief's Phase 7 items
(History loading stall, Windows WebKit failures, FX layout shift) were **not investigated** in this pass; #79 reports fixes and its Linux CI
passes both engines, which is evidence but not my own reproduction. No physical iPhone/PWA claim is made.

## Remaining release gates
Independent re-review of this pass and of #79; hosted disconnect-signal verification (N05) and the product decision above;
live AI evaluation (F-10); production-sized migration and restore rehearsal (0014–0017); hosted deployment-path checks;
physical iPhone/PWA acceptance; final owner approval. F-12 and F-19 remain deferred.
