# Receipt quantities, conversations and memory

TripTab stores item quantities, receipt discussions and remembered context with the receipt in D1. All travellers with access to the holiday can read its shared receipt context. Automatic image transcription is optional and uses the owner's server-encrypted OpenAI API key for all signed-in app users. Tool-capable questions, remembered aliases and share changes remain available through the user's connected ChatGPT/Codex and TripTab's authenticated MCP tools.

## Quantities divide the full line price

An item's amount is the full receipt line total. Equal shares, percentages or labelled quantities determine who owes that cost. Quantities can be fractional and need not be an integer total: 2.5 and 0.5 blocks can divide a total of 3; allocations can also divide a total of 7.5.

Purchased quantity is stored separately in optional `item.quantity`, with a positive `total`, an optional `label` and optional original `sourceText`. For example, `2 x Stck` can establish two pieces; a pizza-slice description or established receipt context can give the clearer label “slices”. A generic pizza description alone does not establish that the purchase was slices. The reader interprets multilingual count terminology and decimals in context and leaves an unclear quantity absent rather than guessing.

On a newly scanned line, the automatic API reader retains the purchased quantity and context-supported label independently of cost shares. It leaves the line unassigned until a person chooses who owes its cost. Switching to Units starts with the detected total and label, while allocation remains a human decision. Existing percentages, quantity allocations and user-entered purchased quantities survive recognition-only corrections. Purchased quantity remains available independently when the user chooses another cost split.

For a £10.01 line containing 3 blocks, Alice's 2.5 blocks cost £8.34 and Bob's 0.5 cost £1.67. The line stays £10.01; the quantity does not multiply its price. Allocations must add exactly to the entered total and match the selected travellers. Money shares use exact rounding, including when tax, tip, discount, foreign-currency conversion or an actual bank charge applies. A whole-receipt percentage split takes priority over individual-item shares while retaining the saved quantities for review.

Incomplete quantity entries stay in the form. A receipt question can include their intended counts for clarification while preserving valid saved receipt details. The proposed correction still needs review before it becomes a posted expense.

AI corrections that omit a split retain its saved participant order and allocation, including penny rounding. When a correction supplies new quantity counts but omits the label, an existing label such as “bars” is retained; an explicit new label replaces it.

Connected-tool corrections that omit `quantity` retain its saved purchase evidence even when the selected travellers change. An explicit purchased-count correction retains an omitted label; original source text is retained only if the count still agrees with it. Purchased quantity never multiplies the line amount or authorizes a consumption assignment. JSON downloads, the CSV item-detail field and receipt history preserve it; history displays the purchased count separately from cost allocations.

Connected-tool schemas accept ordinary decimal quantities such as `0.1` and `1.1` without floating-point divisibility checks. The server still enforces at most six decimal places, the quantity bounds and exact allocation totals before saving a proposal.

## One receipt with item-focused discussions

Each item has a discussion focused on that item's stable ID. “This item” starts with that context, and replies inherit their saved question's item context. The receipt discussion shows all its threads. An item focus is not a separate access permission: a question may ask about other receipt items or other information the caller can already access.

New user messages receive their speaker identity from the authenticated account's linked traveller. Saved message content and human author metadata are preserved when copied between an expense and its review draft. Older messages without author metadata remain attributed to an earlier traveller; the AI context marks their speaker as unknown rather than assuming that “I” refers to the current caller. Removed-item threads remain readable as earlier-item discussions.

Assistant replies are AI messages, not statements attributed to the participant who submitted them. Connected-tool views omit member/name attribution from assistant messages, including older incorrectly stamped replies, while keeping human question authors and item context.

## Shared memory and aliases

Remembered notes and names belong to the receipt, not one item thread or an external chat session. For example, “blocks” can refer to the chocolate item. An alias can also refer to a traveller; an optional speaker scope lets Bob's “me” refer to Bob without giving that word the same meaning for Alice. Speaker scope changes interpretation, not who can read the saved context.

The connected assistant reads `get_receipt_context` before interpreting a question. It receives the whole receipt, all threads, saved notes/aliases, the current caller and, for a saved question, its author and item context. Member email addresses are omitted. Aliases identify items/travellers by ID; inactive references remain historical context and are flagged rather than reassigned by name. Conflicting meanings are marked ambiguous, and the assistant must ask for clarification instead of guessing consumption or identity.

On an explicit request to remember or correct context, `remember_receipt_context` replaces the review draft's complete notes and aliases using its current revision. Shared notes and aliases without a speaker scope remain collaborative and their changes are audited. While a scoped speaker remains in the holiday, only that speaker may rewrite or remove their aliases: Bob must retain Alice's scoped aliases unchanged when replacing memory, including historical aliases whose item has been removed. Requests that omit, rewrite or duplicate another active speaker's aliases are rejected without saving any part of the replacement. Bob can edit or remove his own scoped aliases and shared aliases while updating shared notes.

When a scoped traveller leaves the holiday, remaining travellers can remove that person's saved aliases to free space within the 50-alias limit. They may also retain those aliases unchanged as inactive history. Rewriting an inactive foreign scope or creating a new alias in another person's scope remains forbidden.

The shared ownership check applies at the ledger storage boundary for browser saves and connected tools, using trusted prior receipt context and the authenticated participant. Draft-to-expense transfers retain previously saved aliases without treating them as newly claimed identities. On a retained receipt, omitting its memory also counts as a replacement and must preserve other active speakers' aliases. Whole-receipt deletion follows the holiday's existing permissions and keeps its audit history.

New aliases must point to an active item or traveller; a new speaker scope must belong to the caller. Conflicting aliases with overlapping speaker scopes are rejected. Unchanged historical aliases can remain when their target is removed. This tool preserves the draft's financial details and conversation and does not change an approved expense. Receipt text, discussions and remembered notes are treated as data, not system instructions.

## Connected AI workflow and human review

Once the verified owner saves the shared API key in **Profile & app settings → Receipt AI**, scanning or uploading starts native image transcription for any signed-in participant after both image and draft are saved. Only the owner can manage the shared key; other users see the service's availability without key controls. The reader receives the actual stored image and shared receipt context, and returns typed item names, integer line totals, purchased quantities, currency and legible purchase details. It preserves existing assignments, quantities, whole-receipt percentages, payer, conversations and memory. New scanned lines remain unassigned. Additional tax, tip and discount are recorded once; inclusive tax is not added again. This is one image-processing request, with reconciliation and review performed deterministically in TripTab.

Review drafts may retain an unknown item price (`amount: null`), an empty cost assignment and unresolved currency. Posted expenses remain strict. Optional `receiptScan` stores independently observed printed subtotal/grand total, original-currency evidence, bounded source lines, warnings and processing provenance. TripTab derives calculated totals and matched/needs-review/incomplete status from exact integer hundredths; it does not accept a model's matched claim. Missing printed total remains incomplete, rather than being filled from the item sum. An authenticated browser user may explicitly review an unavailable printed total with `missingTotalAcknowledgement`; this permits Save only when all item prices, descriptions, currency, allocations and other material warnings are resolved. The total stays null and recognition stays incomplete, including in history and exports.

The review summary separates recognition from allocation: a receipt may match exactly while several lines still need people assigned. A valid whole-receipt percentage choice allocates the entire cost without inventing who consumed individual quantities; if that override is removed, the individual item shares must be completed. Unknown financial values, unresolved material warnings and invalid active splits prevent Save. Users can correct the printed evidence after reading the image, resolve a checked warning or explicitly acknowledge a remaining total difference. That acknowledgement is recorded and invalidated by relevant subsequent edits. UI and server compute its fingerprint from the same reconciled evidence. Reconciliation and review use application code; matched/no-acknowledgement Save checks do not run SHA-256, and the review UI memoizes its derived scan/fingerprint. AI tool inputs cannot manufacture warning resolutions or human acknowledgements. Unsupported item-specific discounts/refunds remain source evidence with an unmapped-adjustment warning; a separate financial-model change is needed for first-class signed item adjustments.

Field provenance distinguishes browser defaults (`default`), receipt observations (`receipt`), connected-assistant proposals (`ai`) and browser-entered or explicitly confirmed values (`user`). AI edits dictated in conversation remain proposals and cannot manufacture browser confirmation or clear uncertain-description/low-confidence warnings as a human review action. Merely focusing and leaving an unchanged price does not change provenance. The API reader may replace placeholder purchase metadata with legible receipt facts, but preserves user-confirmed values and never infers a payer from an image. Ambiguous symbols such as bare `$` remain unresolved. A changed original currency clears incompatible FX/bank-charge information. Explicitly confirming the already selected currency preserves its existing FX and bank charge.

Reading succeeds only after a valid completed response. Errors, timeouts, changed images, revoked access and stale revisions do not post or overwrite an expense. A new untouched blank editor fills with the returned items; an edited or posted receipt requires **Review proposed changes**. Changes made while reading remain in the editor. Saving the reviewed expense records its action in the ordinary receipt history.

## Upload guidance and native receipt chat

Before uploading, add optional “Who bought what?” guidance and a city or venue. The initial image request includes this saved human message, traveller names, previous conversation, remembered aliases, language hints and optional device coordinates. The model handles nicknames, spelling variations and informal item names; there is no application nickname parser. Saved speakers identify “I”, and multiple plausible matches need clarification. TripTab validates the returned member IDs, quantities and percentages before presenting financial proposals. Printed line amounts remain full line totals. Guidance may fill new unassigned scan rows; existing item and global shares survive rescanning.

Receipt location and optional current-device hint are separate persisted fields. Browser location is requested only after pressing **Use current location**. A manual or discussed place takes precedence over scan observations; current coordinates never prove a historical purchase venue. Location supplies language/translation context, without overriding mixed-language evidence. Location changes appear in history and exports.

With shared native AI configured, receipt and item questions are processed as text through the same model provider. Saved context includes the selected item, allocations, receipt metadata and trusted human authors. Explicit requests can propose item, location, language or purchase-detail changes while preserving untouched fields. Replies arrive inline; financial edits still require review and **Save**. Retrying an already answered saved question returns its existing result without another model call. Chat does not resend the photo, and upload guidance is consumed in the initial image request without a second request.

When native AI is unavailable, use the connected-tool fallback:

1. Enter a receipt manually or attach a photo. Ask a receipt/item question, or copy the receipt-reading prompt.
2. Open a supported ChatGPT or Codex conversation with the TripTab plugin/MCP tools enabled, then paste and run the prompt. The client reads TripTab context/image tools and can save a reply or a proposed receipt draft through MCP. Account identity linking does not establish that tools are available in that conversation; the website cannot verify external conversation tooling.
3. Replies and matching proposals refresh automatically every five seconds while a saved receipt is open, including item chats, and immediately on focus, reconnect or an authorized push wake-up. Unsaved editor values and question text stay intact. Hidden/offline pages and active saves/uploads pause checks; failed refreshes retry automatically and offer **Retry updates**. New replies can notify the linked question author through their existing browser notification subscription. Inspect the proposed details in TripTab's review interface.
4. **Save** separately to post or update the expense. A reply, remembered context or proposed draft alone does not approve a financial change.

Each write advances the ledger revision. After saving memory or a reply, the assistant must use that tool's returned revision for a subsequent draft update rather than reuse the revision from its earlier context read. Expense targets remain server-controlled: preserve the draft ID and do not send an `expenseId` in draft-update inputs.

Connected corrections use `upsertItems` for changed stable item IDs and `removeItemIds` only for intentional deletion of known active lines. The compatible `items` field also upserts: omission never deletes another line. Omitted fields retain saved values; purchase metadata changes use an explicit `metadataPatch`. A changed legacy top-level metadata value on an existing draft is rejected with that instruction rather than silently ignored. Only explicitly default receipt metadata may be filled by a recognition proposal. The published schema accepts partial existing-draft patches (`id` required); a new draft also needs an existing trip member as payer. Nullable currency, percentages, FX and bank amounts match server inputs. New lines can remain unreadable or unassigned. Historical chats and aliases stay readable after an explicit item removal, and source order remains the comparison order. Receipt source evidence merges by observed text, kind and amount; an unstable ordinal cannot erase earlier coupon/refund evidence, and repeated identical observations do not accumulate duplicates.

The connected-tool prompt requires a real request in ChatGPT/Codex; copying or opening it is not a completed model request. Native text chat and image recognition are separate validated operations; a share-changing question is never answered by rescanning the photo. Email/password accounts and manual receipts remain independent of AI. The future SIWC plan provider is retained but disabled until its separately approved hosted plan permission is configured.

## Limits and existing receipts

| Field | Current limit |
|---|---|
| Receipt items | 200 |
| Selected travellers per item | 50 |
| Quantity total | Greater than zero, at most 1,000,000; at most six decimal places |
| Each quantity allocation | Zero to 1,000,000; at most six decimal places |
| Optional quantity label | 1–40 characters |
| Optional original purchased-quantity text | 1–200 characters |
| Receipt conversation | 100 messages across all item threads |
| Each message | 4,000 characters, including unfinished-entry context |
| New or restored message IDs in one update to an existing holiday | 100; save one receipt at a time |
| Remembered notes | 6,000 characters |
| Aliases | 50 per receipt; names 1–60 characters |

Purchased quantities, quantity labels, memory and message context/author fields are optional. Existing receipts without quantities retain their equal/percentage split; this feature does not silently recalculate old expenses or invent authors. Saved memory and threads survive closing/reopening and receipt review. Account/holiday JSON retains them; financial CSV appends `item_details_json` with full line amounts in stored hundredths, purchased quantities and item allocations, while history records readable context changes.

## Earlier quantity/context validation

Validated on 4 October 2026:

- All 243 regression tests pass, including real SQLite persistence, penny conservation, legacy compatibility, aliases, restored speakers and exports.
- TypeScript, lint (zero errors; four existing warnings), the production build and whitespace checks pass.
- Native connected-tool checks pass for shared context, privacy, scoped replies and reviewed proposals. Five final compiled-worker checks also confirm tied pennies and saved unit labels survive AI corrections.
- Eleven native compiled-worker restoration checks preserve known/unknown historical speakers and verify rejected rewrites leave ledger and audit history unchanged.
- Native UI checks retain conversations and memory across reopening/reloading, keep financial proposals behind explicit review, and preserve incomplete quantities as readable question context.
- Layout checks at 320/390/768 pixels in light/dark mode cover long item names, full remembered notes, 44px controls and no horizontal overflow or browser errors.
- Review regressions validate the published tool schemas with Ajv for decimal quantities, reject overprecision on the server, protect active speakers' scoped aliases through full replacements, free the full alias cap by removing retired scopes, preserve verified transfer context, and retain shared editing with trusted ChatGPT write attribution.
- Connected-tool read regressions omit legacy assistant attribution while retaining human speakers and leaving stored messages and financial data unchanged.

The historical checks above describe that earlier source state using local authenticated/provider fixtures and native D1/Worker execution. They do not establish current deployment or actual hosted client availability. Current receipt release verification uses the [71-point review checklist](receipt-review-checklist.md), [recognition corpus and release runbook](receipt-release-runbook.md), and actual Sites release/migration record. The user has confirmed a working public-site shared-API upload; hosted ChatGPT/Codex tool exposure and real visual-model corpus scores require separate acceptance evidence.
