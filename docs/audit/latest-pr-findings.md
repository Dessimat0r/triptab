# Latest PR review findings — 5 October 2026

The [combined finding-by-finding record](pr-review-2026-10-05.json) covers every open PR #2–#8, including the 09:15–09:16 UTC follow-ups and PR #8’s 10:58 UTC review. Fixes are carried through the stacked branches; no PR has been merged into main.

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

RECEIPT_AI_OWNER_EMAIL is required explicitly at build/preview startup and has no personal-email fallback. Runtime configuration only gates bootstrap management; existing participants and the pinned owner retain access. An operator-only version-guarded transfer clears the old ciphertext and audits the new pin. Established auth/profile reads resolve session precedence, provider links and flags in one SQL snapshot, including stale cookies. Guarded bootstrap retains a post-write snapshot check. Existing-draft id-only patches are intentional, while changed legacy metadata requires metadataPatch. The browser supplies a draft hash; a changed source draft/image fails before spending, while an unrelated global revision does not.

SHA-256 hex, base64url and canonical JSON helpers are shared across callers. Receipt fingerprint key ordering and synchronous review fingerprints remain compatible; credential validation still rejects malformed encodings. Ordered multi-photo recognition and first-class signed/item-specific adjustments remain separate product scope. Unsupported negative evidence is retained and blocks silent application.

Actual hosted ChatGPT/Codex tool exposure and live vision benchmarks remain unperformed; synthetic tests are not evidence for those external integrations. SIWC remains gated off.

## Validation and release boundary

The combined source passes 981 regression tests, TypeScript, production build and lint (zero errors, four existing warnings), plus the recorded compiled mobile/native-route/export journeys. This PR retains two additional focused regressions for purchase-detail opt-out and snapshot-consistent save ETags; final exact-head CI is recorded in its description.

No private key was read, no paid model call was made and no production financial data was changed. No SQL migration was added or replayed. GitHub does not deploy the Site; successful publication and matching source provenance are recorded separately in PR #7’s description.

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
| N7 — escaped completion envelope | A final result retains its 1 MB raw-text cap; individual events allow the worst-case JSON escape expansion plus envelope, bounded separately from the 8 MiB stream cap. A valid escaped event exceeding 1 MB succeeds; oversized events/results/transport still reject. |
| N8 — refactor noise | Removed redundant blank lines and token/endpoint hash wrappers; purposeful hash calls at budget writes remain. |
| N9 — copied test import rewriting | Data-URL harnesses use a shared transpilation helper; central shared-module resolution preserves caller-specific mocks. |

No production owner transfer, deployment or PR merge is performed by this review update.

## Re-review of `6858249` (F1–F9)

| Finding | Fix and regression evidence |
| --- | --- |
| F1 — scoped CAS rejected equivalent trips | The stored trip and the caller's `readLedger` snapshot are compared in one representation (schema-normalised, membership-overlaid, assistant stamps cleared) instead of raw against parsed. A legacy assistant message carrying a human stamp and a stored `userId` on an unlinked traveller now save; genuine data, owner, membership and email races still conflict (existing CAS tests unchanged). |
| F2 — quadratic stream scan | The unfinished SSE line is held as pieces and only each new chunk is searched; its byte length is tracked incrementally. A 6 MB single line in 1 KB chunks takes well under two seconds (it took about 9.5 s before). |
| F3 — stream cap not scaled | The transport cap is three escaped copies of the largest allowed event plus 4 MiB of per-delta envelope. A maximal valid result repeated through 16,000 deltas, the done event and the completed event succeeds; a larger stream still rejects. |
| F4 — pre-check skipped without `draftHash` | `draftHash` is required and `revision` is accepted but ignored (older cached bundles). The browser no longer sends it. A request without the fingerprint is refused before access, budget or model work; an unrelated revision still cannot reject a scan. |
| F5 — owner transfer not runnable; README setup | `npm run receipt-owner` (`--show`, or `--expected-user-id/--expected-version/--new-user-id`) wraps `migrateReceiptAIOwner` over the configured D1 binding, with core logic and argument parsing tested. It was also exercised end to end against a local D1: show, stale-version refusal, transfer, replay refusal and missing-variable refusal. README's quick start sets `RECEIPT_AI_OWNER_EMAIL` before the first build. Hosts that give operators no D1 access must use their own administrative context; this is stated in operations. |
| F6 — MCP/native amount protection | One shared predicate (`mayRecognizeUnknownProvenance`) decides what recognition may fill when provenance is unknown. A legacy blank-named zero-price item with a quantity or scan source is protected on both paths. |
| F7 — remaining base64url copies | The invitation token and the web-push signer use the shared encoder. |
| F8 — second identity path | `resolveIdentity` keeps the session-confined fast read (exports rely on it) and otherwise uses the same single snapshot as `readAuthContext`; the duplicate provider SQL is gone. A live session whose profile row is missing no longer masks a valid provider identity. The link/credential/session races on profile creation remain pinned by `provider creation guards…`; the `delete-other-provider` result is the intended outcome of a coherent snapshot (the principal is chosen once). |
| F9 — test hygiene | Shared transpile helper also resolves `./audit` and `react` specifiers; six copied rewrite lines removed. Stray blank lines removed. |
