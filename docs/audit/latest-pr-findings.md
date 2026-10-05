# Latest PR review findings — 5 October 2026

Scope: Dessimat0r/triptab PRs #2–#7, including ConForza's 09:15–09:16 UTC follow-up reviews. No standalone GitHub issues were returned. This follow-up is based on PR #7 (`ca8c338`), which includes the earlier stacked changes. The linked reviews describe some observations as confirmed and others as unverified; those labels alone are not validation.

## Addressed in this follow-up

| Review | Finding | Change / evidence |
| --- | --- | --- |
| #3 | Logout depends on account/profile and audit availability | Session deletion by token proceeds even when optional actor lookup or audit fails; normal logout still records its audit. Database deletion must succeed. Auth regression covers an audit outage. |
| #3 | Renaming an unlinked traveller hides the one-time invite URL | Invite reset depends on traveller IDs, not display names. |
| #3 | Readiness misses migration 0005 objects | Read-only compilation checks account history and invite, notification and receipt metadata columns. SQLite tests remove each column and require 503. Historical migration timestamps remain unchanged. |
| #5 | Foreground refresh can reuse a request predating a join or other action | Only background callers share an active request. Foreground actions always start a fresh read; stale responses remain rejected. Both foreground/background race regressions pass. |
| #5 | Save drops the conditional refresh tag | POST obtains freshness with its response's final read snapshot and sends matching ETag/revision headers without returning internal freshness metadata. SQLite route test verifies the next GET returns 304. |
| #6 | Closing an upload leaves busy flags set | Receipt reset clears upload, connection and checking state while invalidating late work. Extracted production-handler test closes an upload and rejects its late result for a newly opened editor. |
| #6 | Failed key save erases the pasted key | Keep the masked key in component memory for retry; clear after successful save. Fixed local error messages still exclude provider text. Existing account/unmount cleanup remains. |
| #7 | Focus/blur stamps unchanged AI amounts as human edits | Amount control only emits an actual value change, including nullable values; equivalent formatting does not emit changes. |
| #7 | MCP corrections manufacture user provenance | Changed item and metadata proposals use `assistant` provenance, including user-dictated proposals. Only browser review/editing records human confirmation; unchanged confirmed item fields remain protected. |
| #7 | Acknowledgement uses raw instead of reconciled scan | Review UI calculates/checks the fingerprint using its reconciled scan, matching Save. Nonfinancial metadata provenance does not invalidate financial review. |
| #7 | Currency review requires a destructive currency roundtrip | Explicit warning review confirms the current currency without changing FX/bank fields. A missing currency still blocks Save. |
| #7 | Incomplete draft input can throw while saving a receipt question | Safe fallback retains prior valid item/allocations; a new incomplete item retains a bounded description and unknown price without invented allocations. |
| #7 | MCP/native rescan can replace source evidence by position | Both paths retain distinct source observations and deduplicate exact observations. Reused scan line positions cannot erase coupon/refund evidence. The 1000-line evidence cap still rejects oversized proposals. |
| #7 | Published metadata nullability differs from accepted input | Top-level currency/percentages/FX/bank amount and metadataPatch have matching nullable schemas. Other fields remain non-nullable on both paths. `required: ['id']` is intentional for partial upserts. |
| #7 | Purchase-detail opt-out ignored when provenance exists | Existing date/time remain untouched when readPurchaseDetails is false, including receipt-origin details. |
| #7 | History displays raw warning codes | Review and history share human-readable warning text; immutable stored snapshots are unchanged. |

## Existing behavior retained

- PR #2/#4 and the earlier PR #3/#5 findings already have their fixes on this stack and regression coverage. The latest PR #5 review explicitly confirms its earlier timezone, ETag version, navigation, 404 and formatter fixes.
- Missing independent printed totals deliberately block receipt Save. The interface says to enter only amounts visible on the receipt. It does not request a fabricated total. Supporting a receipt with no printed total requires a separately designed, explicit manual-evidence workflow; this patch does not weaken the reconciliation gate.
- Existing manual draft metadata is deliberately changed only via metadataPatch; legacy top-level metadata initializes new drafts, with a narrowly documented exception for receipt defaults. Existing contract tests verify preservation. This is documented in the tool schema/description and PR #7; it is not an unrestricted replacement operation.
- The shared key owner's verified email is intentionally bound to the existing owner. Changing this authorization policy or making it deployment-configurable is outside these bug fixes.

## Remaining concerns, not claimed fixed or verified

The reviews also raise provider SSE capacity, retaining paid results across unrelated global revisions, duplicate status reads/polling, handoff URL length, disabled ChatGPT-plan response shape, key lifecycle on owner deletion, model-default duplication, oversized history pagination, timer failure reporting, export contact policy, account-export cursors, notification subscription delivery windows, repeated profile/metadata reads, and audit guards. These need reproduction or explicit product/operational decisions. None is represented here as a confirmed new defect or a completed fix.

The synchronous review fingerprint and repeated parsing remain. Changing them requires performance evidence and preservation of server/browser review invalidation semantics.

## Validation and release boundary

Regression tests exercise production logic with synthetic accounts/provider responses, SQLite and native workerd/D1 fixtures. No private API key was read, no paid model call was made, and no production financial data was changed. This is a code follow-up PR; it does not merge the stack or publish a Sites version. No SQL migration is added.
