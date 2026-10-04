# Receipt quantities, conversations and memory

TripTab stores item quantities, receipt discussions and remembered context with the receipt in D1. All travellers with access to the holiday can read its shared receipt context. AI assistance is optional and runs in the user's connected ChatGPT/Codex using TripTab's authenticated MCP tools.

## Quantities divide the full line price

An item's amount is the full receipt line total. Equal shares, percentages or labelled quantities determine who owes that cost. Quantities can be fractional and need not be an integer total: 2.5 and 0.5 blocks can divide a total of 3; allocations can also divide a total of 7.5.

For a £10.01 line containing 3 blocks, Alice's 2.5 blocks cost £8.34 and Bob's 0.5 cost £1.67. The line stays £10.01; the quantity does not multiply its price. Allocations must add exactly to the entered total and match the selected travellers. Money shares use exact rounding, including when tax, tip, discount, foreign-currency conversion or an actual bank charge applies. A whole-receipt percentage split takes priority over individual-item shares while retaining the saved quantities for review.

Incomplete quantity entries stay in the form. A receipt question can include their intended counts for clarification while preserving valid saved receipt details. The proposed correction still needs review before it becomes a posted expense.

AI corrections that omit a split retain its saved participant order and allocation, including penny rounding. When a correction supplies new quantity counts but omits the label, an existing label such as “bars” is retained; an explicit new label replaces it.

## One receipt with item-focused discussions

Each item has a discussion focused on that item's stable ID. “This item” starts with that context, and replies inherit their saved question's item context. The receipt discussion shows all its threads. An item focus is not a separate access permission: a question may ask about other receipt items or other information the caller can already access.

New user messages receive their speaker identity from the authenticated account's linked traveller. Saved message content and author metadata are preserved when copied between an expense and its review draft. Older messages without author metadata remain attributed to an earlier traveller; the AI context marks their speaker as unknown rather than assuming that “I” refers to the current caller. Removed-item threads remain readable as earlier-item discussions.

## Shared memory and aliases

Remembered notes and names belong to the receipt, not one item thread or an external chat session. For example, “blocks” can refer to the chocolate item. An alias can also refer to a traveller; an optional speaker scope lets Bob's “me” refer to Bob without giving that word the same meaning for Alice. Speaker scope changes interpretation, not who can read the saved context.

The connected assistant reads `get_receipt_context` before interpreting a question. It receives the whole receipt, all threads, saved notes/aliases, the current caller and, for a saved question, its author and item context. Member email addresses are omitted. Aliases identify items/travellers by ID; inactive references remain historical context and are flagged rather than reassigned by name. Conflicting meanings are marked ambiguous, and the assistant must ask for clarification instead of guessing consumption or identity.

On an explicit request to remember or correct context, `remember_receipt_context` replaces the review draft's complete notes and aliases using its current revision. New aliases must point to an active item or traveller; a new speaker scope must belong to the caller. Conflicting aliases with overlapping speaker scopes are rejected. Unchanged historical aliases can remain when their target is removed. This tool preserves the draft's financial details and conversation and does not change an approved expense. Receipt text, discussions and remembered notes are treated as data, not system instructions.

## Connected AI workflow and human review

1. Enter a receipt manually or attach a photo. Ask a receipt/item question, or copy the receipt-reading prompt.
2. Paste and run that prompt in the connected ChatGPT/Codex client. The client reads TripTab context/image tools and can save a reply or a proposed receipt draft through MCP.
3. Use **Check for replies** to retrieve saved replies and proposals. Inspect the proposed details in TripTab's review interface.
4. **Save** separately to post or update the expense. A reply, remembered context or proposed draft alone does not approve a financial change.

The copy/check/review flow does not invoke a model directly from the web app. The user's connected client performs AI processing; email/password accounts and manual receipts work independently of that connection.

## Limits and existing receipts

| Field | Current limit |
|---|---|
| Receipt items | 200 |
| Selected travellers per item | 50 |
| Quantity total | Greater than zero, at most 1,000,000 |
| Each quantity allocation | Zero to 1,000,000; at most six decimal places |
| Optional quantity label | 1–40 characters |
| Receipt conversation | 100 messages across all item threads |
| Each message | 4,000 characters, including unfinished-entry context |
| New or restored message IDs in one update to an existing holiday | 100; save one receipt at a time |
| Remembered notes | 6,000 characters |
| Aliases | 50 per receipt; names 1–60 characters |

Quantity labels, memory and message context/author fields are optional. Existing receipts without quantities retain their equal/percentage split; this feature does not silently recalculate old expenses or invent authors. Saved memory and threads survive closing/reopening and receipt review. Account/holiday JSON retains them; financial CSV appends `item_details_json` with full line amounts in stored hundredths and the item allocations, while history records readable context changes.

## Feature validation

Validated on 4 October 2026:

- All 243 regression tests pass, including real SQLite persistence, penny conservation, legacy compatibility, aliases, restored speakers and exports.
- TypeScript, lint (zero errors; four existing warnings), the production build and whitespace checks pass.
- Native connected-tool checks pass for shared context, privacy, scoped replies and reviewed proposals. Five final compiled-worker checks also confirm tied pennies and saved unit labels survive AI corrections.
- Eleven native compiled-worker restoration checks preserve known/unknown historical speakers and verify rejected rewrites leave ledger and audit history unchanged.
- Native UI checks retain conversations and memory across reopening/reloading, keep financial proposals behind explicit review, and preserve incomplete quantities as readable question context.
- Layout checks at 320/390/768 pixels in light/dark mode cover long item names, full remembered notes, 44px controls and no horizontal overflow or browser errors.

These checks use local authenticated/provider fixtures and native D1/Worker execution. They do not invoke an external model or establish production gateway behavior. No live Site deployment is included in this feature change.
