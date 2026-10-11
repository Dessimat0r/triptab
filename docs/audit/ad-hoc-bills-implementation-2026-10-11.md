# One-off bills implementation

Implements the brief in PR #53 as five stacked changes: acceptance tests, model and lifecycle guards, the start sheet, the combined bill view, then copy and integrations.

Bills use existing trip rows, receipt processing, financial calculations, payments, history and invitations. Missing `kind` remains a holiday. No database migration or calculation algorithm changes are required. Bills allow multiple receipts and invitations, share the 50-open-ledger limit, and offer archive after settlement rather than archiving automatically.

The first scanned receipt requires one narrow clarification to the brief’s currency rule. Scanning saves a draft before approval, while the brief both locks currency after any draft and asks the first scan to adopt its currency. The server allows that adoption only in the same save that consumes the sole review draft into the first approved expense, with no payments or other drafts. Editing currency while the draft remains is still rejected. Explicit currency choices retain the normal conversion path.

Tests cover seeded calculation parity, immutable kind, currency locking, discard/save and discard/join races, lifecycle copy, creation defaults, real scan review, settlements, archive, summaries, route aliases, narrow layouts, translations, MCP retries, and exports/imports. The final phase rejects deferred bill browser cases. Existing holiday browser tests and money algorithms remain unchanged. The receipt-editor handler harness gained bill state bindings while keeping its holiday assertions.

Validation uses lint, TypeScript, the full unit suite, production build, and the complete Chromium/WebKit layout suite for each phase. Preview credentials are synthetic and all preview servers are local. No deployment is performed by this implementation.
