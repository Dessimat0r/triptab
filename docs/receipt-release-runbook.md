# Receipt release and recognition evaluation

This procedure separates source correctness, public-site API receipt reading, hosted client tool availability and actual visual-recognition quality. Passing one does not establish the others. Never put API keys, authentication cookies, provider tokens, private receipt images or raw receipt contents in a release record.

## Current acceptance limits

The owner has confirmed that a real public-site upload returned items after the shared API connection repair. This is evidence for that API journey. It is not an acceptance record for a fresh hosted ChatGPT/Codex conversation using the TripTab plugin, or a broad recognition-quality evaluation. The recheck in [receipt-review-checklist.md](receipt-review-checklist.md) records those outstanding gates.

Deterministic verification must not make paid OpenAI calls. Use synthetic receipts and mocked provider responses; retain the same native D1/R2 and application authorization boundaries. Do not schedule an evaluator, automatically retry inference, or rescan a stored image merely because a browser refreshes. A live evaluation needs the operator's explicit decision to spend the application's API budget or use their real hosted client.

## Recorded local acceptance: 5 October 2026

See the committed [receipt integrity validation record](audit/receipt-integrity-validation.json) for reproducible check results and fixture/hosted-model limitations.

This source recheck passed **857 regression tests**, TypeScript, the production build and lint with zero errors/four existing warnings. The two native integration tests in `tests/receipt-flow-native.test.ts` use actual production route code, isolated Miniflare D1/R2 and real migrations. They cover upload/draft/image/proposal/refresh, stale-write and incomplete-Save rejection, human correction, strict Save, image preservation and immutable receipt-family history.

Five additional compiled browser checks exercise the same actual local route/D1/R2 backend: browser canvas/JPEG capture, exact native MCP image retrieval, saved proposal refresh, explicit whole-receipt allocations and human Save/reopen. Separately, 54 mobile checks cover 320/390/768 pixels in light/dark mode, long/200-line receipts, warnings, unknown values, discrepancy acknowledgement, global versus item allocation and the zoomed photo interface, with no horizontal page overflow or browser errors.

All data and provider identity are synthetic local fixtures. Model observations are supplied deterministically. **No hosted ChatGPT/Codex conversation and no paid visual-model request was used.** The corpus records zero live-model evaluations and null scores. These results establish the application boundary, not real hosted plugin exposure, production gateway guarantees or measured vision accuracy. Add actual Sites release identifiers and complete the separate hosted/operator gates when available.

## Source and application release gate

1. Record GitHub commit, Sites source commit/tree, Site version, deployment ID and environment revision. Verify that the deployed source tree equals the reviewed tree. GitHub pushes and merges do not deploy the Site.
2. Run locked installation when needed, regression tests, TypeScript, lint and production build. Record exit status, test count and existing warnings. Preserve receipts without evidence; no migration may fabricate historical printed totals from item sums.
3. Use an isolated synthetic trip to verify upload → stored image → saved waiting draft → authenticated image read → itemisation proposal → browser refresh → review → strict human Save. Use a mocked provider/MCP tool response for this deterministic test. Check that no expense was posted before Save.
4. Verify exact-match, one-cent mismatch, missing total, missing price, unresolved currency and unsupported adjustment states. Verify unassigned new scan rows, explicit allocations, protected existing allocations and patch-safe omissions/removals. A scan status supplied by an external client must not be trusted as matched.
5. Check 320, 390 and 768 pixel widths, in light and dark mode, including long text, large warning sets and 200 receipt lines. Verify keyboard/screen-reader labels, non-colour warning text, image inspection, strict Save feedback and no horizontal overflow.
6. Publish through Sites and record the deployment result. For any changed MCP contract, complete the separate hosted-client gate below before declaring that client path ready.

## Hosted ChatGPT tool acceptance

This requires an actual supported hosted ChatGPT conversation and an account authorized to access the synthetic trip. A local server, MCP inspector, fixture, read-only Site deployment metadata or browser automation without that session is insufficient.

1. Publish the approved Site and identify its associated TripTab plugin/tool integration and version through the supported platform interface. Install or update it in a test account, then connect the correct TripTab identity.
2. Open a **fresh** supported ChatGPT conversation. Select/enable TripTab. Record whether tools are exposed, rather than relying on a linked-account badge in the website.
3. Verify the conversation's tool list includes `get_trip_ledger`, `get_receipt_context`, `get_receipt_image`, `update_receipt_draft`, `remember_receipt_context` and `reply_to_receipt_chat`. If the published contract includes an additional correction tool, verify it too. A missing tool blocks acceptance of the affected client flow.
4. Make a harmless scoped `get_trip_ledger` or `get_receipt_context` read. Record the tool name and success/failure; omit member emails and receipt contents from operational logs.
5. In the public website, create a synthetic test receipt draft and upload a known corpus image. Use the **external-client** request, rather than counting an automatic shared-API scan as the MCP test. Open/send it in the TripTab-enabled conversation.
6. Confirm `get_receipt_context` reads the correct draft and revision. Confirm `get_receipt_image` returns the actual authorized native image and is visually available to the assistant, not only a textual URL.
7. Have the assistant read all purchase lines in source order, retain independent printed totals and source evidence, preserve unreadable values, keep ambiguous currency unresolved and submit a review draft. The image must not assign traveller consumption. Receipt instructions printed on the image remain untrusted data.
8. If memory or a reply is saved first, confirm the next write uses the latest returned ledger revision. Verify omission of an existing item does not delete it and explicit removal is intentional. Confirm old item discussions and aliases remain readable.
9. Return to TripTab or refresh its draft. Confirm the proposal appears with the expected rows, scan status and warnings. Verify it has **not** posted or modified an expense. Review/edit amounts and allocations, then explicitly Save.
10. Record final result and synthetic fixture IDs. If the tools are unavailable, record **not accepted: tool integration unavailable** and use the actionable setup path. Keep the receipt/draft intact. Do not label prompt copying or indefinite polling as successful processing.

## Codex acceptance is separate

Repeat the hosted/tool flow independently in the actual Codex environment intended for users. Record whether its plugin/MCP connection exposes native receipt images and review-draft writes. Do not infer Codex support from ChatGPT success or the other way round. Until verified, describe external assistance as requiring an MCP-capable client with TripTab enabled, without promising identical installation or conversation behavior.

## Public-site shared API smoke test

The owner manages the shared API key through TripTab's masked **Receipt AI** form. Never request that key in a chat, inspect it in logs or commit it. A project-scoped key identifies its API project without a display-name header. The encrypted key remains server-side and can fund scanning for all authorized participants.

An operator who elects to run a live smoke test should use **one** small synthetic receipt, once. Confirm the exact model configuration, native stored image input, successful completed response, independent evidence, human review and Save. Do not add a second classification, verification or quantity-only request: extraction, purchased quantity and evidence belong in the same request. Inspect safe status/event categories if it fails; avoid automatic paid retry. Manual edits, warning review, draft polling and reconciliation must use deterministic application code.

Record the chosen fixture and response outcome. Token usage/cost may be recorded from a provider usage record if available; do not estimate it from elapsed time. A fixture response substituted by a test is not a measured visual-model result.

## Golden recognition evaluation

Use only versioned synthetic/public-domain images. Never add a real traveller's receipt to the repository. The expected record must identify source order, full line totals, readable/unreadable fields, printed subtotal/grand total, currency, adjustments and expected warning states. Retain deliberately incomplete images rather than inventing their obscured values.

The corpus covers café, included VAT, service/tip, multilingual purchased counts, repeated product names, decimal comma, foreign/ambiguous currency, coupons and unsupported line-specific/negative adjustments, long/cropped/blurry receipts, missing items exposed by totals, competing totals and malicious printed instructions. Multi-photo overlap is a deferred fixture until ordered multi-photo support exists.

Version 1 is [tests/fixtures/receipts/v1/corpus.json](../tests/fixtures/receipts/v1/corpus.json), with 19 synthetic uploadable PNGs and their SVG sources. Regenerate locally with `node scripts/render-receipt-corpus.mjs --png`; this uses the already installed image renderer and makes no model or network request. Only expect a printed subtotal when that value is actually printed in the fixture. Use the PNG files for TripTab upload; the app does not accept SVG receipt uploads.

The offline scorer is `npx tsx scripts/evaluate-receipts.ts <operator-results.json>`. Start with the [empty results template](../tests/fixtures/receipts/v1/operator-results.example.json) and follow its strict JSON input contract in `lib/receipt-evaluation.ts`. Results identify each fixture's source-line indexes independently of its item names; reviewed alternate translations belong in that fixture's accepted names. An empty file produces zero evaluated fixtures, null metric rates and an explicit list of unrun cases. [evaluation-status.json](../tests/fixtures/receipts/v1/evaluation-status.json) records that no live visual-model benchmark has been run.

Keep deterministic expected-output tests separate from paid visual-model observations. A corpus and mocked output tests make an evaluation repeatable; they do not demonstrate the current model's accuracy. No live score is claimed until actual model outputs have been collected and scored.

For each evaluated fixture, compare the observed lines to source lines by their expected source identity/order, not by product name alone. Report these metrics with numerator, denominator and fixture count:

| Metric | Definition |
|---|---|
| Line recall | Correctly represented expected purchase lines / expected purchase lines. Unreadable source lines count as represented only when retained as incomplete. |
| Hallucinated lines | Output purchase lines without a corresponding source line; report count and rate. Legitimate repeated products must remain separate. |
| Exact price accuracy | Correct full line totals / source lines with readable expected amounts. Compare integer stored minor units. |
| Currency accuracy | Correct nullable currency / evaluated fixtures; an ambiguous symbol must remain null. Appropriate uncertainty is reported separately. |
| Printed subtotal/total accuracy | Correct nullable independently observed printed subtotal/grand total / evaluated fixtures; an unreadable or unprinted value must remain null. A sum of rows is not printed evidence. |
| Reconciliation success | Correct server-matched status / fixtures expected to reconcile. Also report false-match count across incomplete or inconsistent fixtures. |
| Appropriate uncertainty | Expected unreadable/ambiguous/unmapped cases correctly surfaced / expected uncertainty cases. Report invented resolutions separately. |

The scorer also reports source-order accuracy, purchased-quantity accuracy, deterministic server status/warnings and false reconciliation matches. Its `modelCalled: false` means scoring is offline; it does not identify whether an operator-supplied output came from a model. Preserve the actual evaluation provenance in the release record.

Prefer a small release subset and expand only when evidence justifies it. A fixed full-corpus benchmark should not become an automatic paid CI job. Reuse recorded outputs for scoring, schema and reconciliation checks; rerun inference only for an intentionally selected model/prompt/image change. Keep raw synthetic outputs separate from private application data.

## Release record template

```text
Release / GitHub commit / Sites source tree:
Site version / deployment / environment revision:
Deterministic tests, types, lint, build:
Mobile matrix and application integration results:
Hosted ChatGPT plugin version / fresh client tools list:
Hosted ChatGPT native image read / review write / browser result:
Codex environment / separate acceptance result:
Public-site API smoke fixture / actual outcome (or not run):
Golden corpus version / evaluated fixture IDs / actual metrics (or not run):
Human Save boundary / preservation checks:
Pending or deferred scope:
Operator / verification time (with timezone):
```

Keep **not run**, **blocked** and **failed** distinct from a passing result. A known pending hosted gate does not invalidate deterministic code checks, but it does prevent claiming that hosted receipt-scanning path has been verified.
