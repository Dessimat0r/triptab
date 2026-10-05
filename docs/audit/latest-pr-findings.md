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

The shared API owner’s verified email is the user’s explicit requirement. Final identity revalidation protects concurrent unlink/revocation; it is retained. Existing-draft id-only patches are intentional, while changed legacy metadata requires metadataPatch. Initial stale native requests fail before spending the API budget.

A broader crypto/codec/canonical-serialization refactor remains a maintenance suggestion, with no reproduced behavior defect. Existing canonical key ordering, synchronous review fingerprints and credential-validation semantics require compatibility preservation. Ordered multi-photo recognition and first-class signed/item-specific adjustments remain separate product scope. Unsupported negative evidence is retained and blocks silent application.

Actual hosted ChatGPT/Codex tool exposure and live vision benchmarks remain unperformed; synthetic tests are not evidence for those external integrations. SIWC remains gated off.

## Validation and release boundary

The combined source passes 966 regression tests, TypeScript, production build and lint (zero errors, four existing warnings), plus the recorded compiled mobile/native-route/export journeys. This PR retains two additional focused regressions for purchase-detail opt-out and snapshot-consistent save ETags; final exact-head CI is recorded in its description.

No private key was read, no paid model call was made and no production financial data was changed. No SQL migration was added or replayed. GitHub does not deploy the Site; successful publication and matching source provenance are recorded separately in PR #7’s description.
