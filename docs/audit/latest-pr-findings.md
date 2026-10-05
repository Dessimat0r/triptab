# Latest PR review findings — 5 October 2026

The [combined finding-by-finding record](pr-review-2026-10-05.json) covers every open PR #2–#8 through the earlier follow-ups. The [13:00 UTC follow-up record](pr8-follow-up-2026-10-05.json) covers PR #8's subsequent nine findings against `6858249`. Fixes are carried through the stacked branches; no PR has been merged into main.

## Fixed and verified

- Receipt recognition preserves existing manual or unknown-provenance item names/prices, confirmed metadata, cost shares and omitted items. Explicit conversational corrections remain AI proposals. Unknown values and unsupported financial evidence stay visible for human review.
- Unchanged amount focus/blur does not confirm a value. Same-currency confirmation retains bank/FX details. Review fingerprints reconcile evidence before hashing; people may explicitly review an unavailable printed total without fabricating one.
- Native and MCP rescans retain source evidence, including repeated identical physical rows. Evidence overflow gives recovery guidance without replacing saved evidence. Explicit purchase-date/time opt-out applies to receipt-derived values too.
- Completed paid scans survive unrelated ledger writes through bounded save retries and account/draft/member/image checks, without repeating inference. SSE transport and result caps are separate, long external handoffs do not truncate prompts, status reads coalesce and API scans do not start external-chat polling.
- Closing receipt work resets busy controls. Failed API-key saves retain the masked key for retry. Model defaults are centralized; the existing owner-managed shared key remains available to all authorized participants.
- Logout revokes the browser token even during profile/audit failures. Invitation links survive traveller renames; active rows and revoke prompts use current traveller names.
- Readiness detects missing migration 0005 objects. Oversized history entries retain pagination and authenticated full downloads. JSON/CSV account cursors are independent, organizer contact exports preserve the intended privacy policy, and notification delivery is bounded and fair.
- Navigation uses separate routes, API 404s return JSON, own-action refreshes request fresh snapshots, background failures show recovery, and saved response ETags match the response snapshot.
- The gated SIWC path rejects normalized protocol-relative and backslash return paths, rechecks saved callbacks and resolves returns from the callback origin. OAuth exchange/refresh accepts omitted unchanged scope and retains a previous refresh token when no replacement is returned; rotation and authorization guards remain.
- MCP SHA-256 hex duplication uses the existing shared hash helper with unchanged namespaces and output.

## Intentional behavior and remaining scope

RECEIPT_AI_OWNER_EMAIL is required explicitly at build/preview startup and has no personal-email fallback. Runtime configuration only gates bootstrap management; existing participants and the pinned owner retain access. A runnable operator-only version-guarded transfer clears the old ciphertext and audits the new pin. All identity/profile reads share one SQL snapshot, including stale or orphaned session fallback, without creating profiles during identity-only reads. Guarded bootstrap retains a post-write snapshot check. Existing-draft id-only patches are intentional, while changed legacy metadata requires metadataPatch. The browser must supply a draft hash; a changed source draft/image fails before spending, while an unrelated global revision does not. Cached clients may send an ignored revision alongside the required hash; revision-only payloads receive reload guidance.

SHA-256 hex, base64url and canonical JSON helpers are shared across callers. Receipt fingerprint key ordering and synchronous review fingerprints remain compatible; credential validation still rejects malformed encodings. Ordered multi-photo recognition and first-class signed/item-specific adjustments remain separate product scope. Unsupported negative evidence is retained and blocks silent application.

Actual hosted ChatGPT/Codex tool exposure and live vision benchmarks remain unperformed; synthetic tests are not evidence for those external integrations. SIWC remains gated off.

## Validation and release boundary

The latest combined source passes 1,012 regression tests, TypeScript, production build and lint (zero errors, four existing warnings). Earlier compiled mobile/native-route/export journeys remain recorded separately; the follow-up record identifies checks rerun for this change. Final exact-head CI is recorded in the PR description.

No private key was read, no paid model call was made and no production financial data was changed. No SQL migration was added or replayed. GitHub does not deploy the Site; successful publication and matching source provenance are recorded separately in PR #8's description.

## 11:36–11:37 UTC re-review (PRs #5–#8)

| Finding | Fix and regression evidence |
| --- | --- |
| N1 — recognition over-protects blanks/nulls | Native and MCP observation fill unknown-provenance empty names, null prices and blank placeholders. Populated legacy manual values and explicitly user-confirmed fields stay protected. Missing-price warnings regenerate from the resulting fields. |
| N2 — deployment-wide scan conflicts | The browser sends a canonical source-draft hash. Preflight ignores the global counter; commit writes only the target trip under its existing receipt-link data version and exact membership/ownership/access guards. Other-trip writes cannot lose its CAS or be overwritten. History uses the transaction's current global revision. Same-trip conflicts retain three guarded retries without repeating inference. SQLite regressions inject 100 unrelated revisions at commit and assert current data/history, then race target data/owner/member changes. |
| N3 — personal owner fallback | Build/preview requires a valid explicit owner email. CI uses a synthetic address; README and operations describe configuration rather than a fixed personal identity. Regression covers absent, empty, malformed and normalized values. |
| N4 — availability/stranded ownership | Missing or changed runtime owner configuration cannot block participant access or the pinned owner's replacement/removal. Bootstrap fails closed. The documented operator helper transfers only to a canonically linked configured target, checks expected owner/version, clears old ciphertext and audits in one batch. Tests cover denial, successful new-owner setup and rollback on audit failure. |
| N4b — lost rotated refresh token | Persist renewed credentials/version before rejecting reduced plan permission. Subsequent processing remains denied without refresh; disconnect revokes the newly rotated token. |
| N5 — auth duplication/link races | One indexed SQL snapshot includes live-session precedence and canonical provider lookup, even with stale cookies. There is no second read whose principal can disagree with the first. Link/session changes before that snapshot affect it; later requests observe later changes. Bootstrap still guards link, credentials and session transitions atomically. Explicit race tests pin canonical IDs, stored email and verification flags, including disconnection. |
| N6 — remaining codec/hash copies | Shared SHA-256 bytes/hex/base64url helpers cover setup budgets and PKCE; password-derived bytes use shared hex encoding. Hash namespaces, password verification and credential error boundaries remain intact. |
| N7 — escaped completion envelope | A final result retains its 1 MB raw-text cap; individual events allow the worst-case JSON escape expansion plus envelope. The subsequent F3 fix increases the finite transport cap to 36,098,304 bytes for repeated escaped output events. A valid escaped event exceeding 1 MB succeeds; oversized events/results/transport still reject. |
| N8 — refactor noise | Removed redundant blank lines and token/endpoint hash wrappers; purposeful hash calls at budget writes remain. |
| N9 — copied test import rewriting | Data-URL harnesses use a shared transpilation helper; central shared-module resolution preserves caller-specific mocks. |

No production owner transfer, deployment or PR merge is performed by this review update.

## 13:00 UTC re-review (PR #8)

All F1–F9 findings are addressed. Scoped receipt saves now compare the exact raw ledger projection that the reader captured, preserving legacy text/metadata compatibility while retaining parsed validation, membership/CAS guards and immutable audit before-images. Stream parsing scans only new bytes using a bounded reusable buffer; separate event/result/transport limits accommodate repeated escaped Responses output. Source-draft fingerprints are mandatory before key lookup or budget use. Owner setup is documented before the first build, and the runnable transfer CLI defaults to a read-only dry-run against an explicitly selected D1 binding. MCP/native blank-price rules agree for legacy quantity/source evidence. Invitations use the shared base64url codec. Identity-only/session-only reads reuse the atomic snapshot and omit unnecessary flags. Test import resolution operates on actual import syntax and supports explicit mocks without rewriting ordinary strings.

## Follow-up to the 13:00 UTC re-review

Two small residuals from reviewing the final F1–F9 head. The unused argument parser and transfer flow in `lib/receipt-ai-owner-transfer.ts` duplicated the operator CLI (with different flag names) and was reachable only from one test; it is removed, and its argument edge cases (non-canonical, zero, overflowing and repeated versions; unsafe, empty or over-long account IDs; transfer to the current owner; repeated flags; malformed owner email) now exercise the real CLI parser. When a live session resolves, the single identity snapshot no longer probes `auth_links` or `auth_credentials` even if provider headers are present; fallback to the provider after a missing, expired or profile-less session still happens in the same statement. A regression test poisons both tables so any probe by a live-session read fails, and confirms provider-only reads still reach them.
