# Audit coverage

TripTab keeps two append-only histories: a holiday's shared activity and the signed-in account's private activity. This describes the current application write paths. It does not promise a record of every database operation, every browser action or changes made directly by a hosting operator.

## Shared holiday history

The holiday owner and current members can read its activity. Each event records the server-attributed actor, UTC recording time, source, action, affected record and its before/after details. A transaction date entered by a traveller is separate from the event's recording time. Sources distinguish the web app, connected ChatGPT/Codex and system maintenance.

| Change | Recorded details |
| --- | --- |
| Holiday settings | Name, settlement currency, travel dates and deliberate collection reorders. Expense/payment/draft additions and removals record their entity changes without redundant holiday updates; traveller placement remains recorded because it affects remainder pennies. |
| Travellers | Names, identifiers and account/email association. Invitation acceptance records the traveller's new account association. |
| Posted receipts and payments | Complete previous and resulting records, including amounts, splits, percentage overrides, quantities and labels, FX/bank-charge information, payer, transaction details and attached image references. Deletion retains the complete previous record. |
| Receipt drafts and conversations | Saved drafts, shared notes, remembered aliases, item context, questions/replies and their server-attributed speakers. An AI proposal remains a draft until a traveller reviews and saves it. |
| Invitations | Creation, replacement/revocation and acceptance, with the target traveller, expiry, status and whether an email restriction applies. History uses an independent reference, without the invitation token, authentication hash or destination email. Natural expiry does not create a new event by itself. |
| Receipt image lifecycle | Upload reservation and completion, detach/delete intent, failed-upload cleanup, orphan expiry and successful metadata cleanup after object deletion. Metadata identifies the uploader, content type, byte size, checksum and lifecycle reason; cleanup preserves its initiator. Events contain no image bytes, R2 object keys or access URLs. |

Ledger changes and their events commit in the same guarded D1 batch. Validation failures, stale writes and unchanged saves create no successful-change events. Invitation changes also use guarded batches. Receipt metadata changes have their own exact-state guards; their recorded revision is contextual and does not imply that every image operation increments the ledger revision.

R2 object storage cannot participate in a D1 transaction. Receipt deletion records intent first; only confirmed object deletion permits a metadata-deletion event. A failed cleanup retains inaccessible `deleting` metadata for retry, including when bytes were already removed but D1 completion failed. Retrying does not fabricate another completed deletion. Protected pending uploads still need operator recovery if genuinely stuck.

Restoring a deleted expense or payment is an explicit, reviewed creation recorded under the restoring actor. Its earlier delete event remains. Original conversation authors can be recovered from that holiday's history; restoration does not recover purged images. Entire-holiday deletion is unsupported: omitting a holiday from a ledger save does not delete it.

## Private account history

Only the authenticated account can read `/api/account-activity` or export its account history. Holiday members cannot read one another's private account changes.

| Change | Recorded details |
| --- | --- |
| Profile creation and edits | Display name, including first profile creation through trusted ChatGPT identity and guarded display-name edits. |
| Password setup/change | Whether password sign-in is configured and when it changed, without the password, derivation parameters, hash or salt. |
| Browser sign-in and sign-out | Successful session issuance, actual revocation, account switching and in-app provider sign-out/resume. Password changes record revocation of existing sessions and issuance of the replacement session. Routine authenticated reads do not claim a fresh sign-in. |
| ChatGPT account connection | Successful connection/disconnection state, without provider identifiers or authentication credentials. |
| Browser notifications | Successful enable/disable, this browser's removal on sign-out/account switch and provider-expired cleanup. Events retain only the service hostname, enabled state and reason. The subscription reference is a one-way SHA-256 digest of its endpoint, without the endpoint's redeemable value or token. |

Device enable/disable and its private event commit together. Repeated enables, status checks, absent-device removals and unsuccessful ownership attempts create no successful-change events. Another account cannot take over an existing browser subscription. Every fresh enable has a new internal generation, so a delayed provider response or stale removal cannot disable a recreated binding. That generation and the browser binding cookie are excluded from history.

Account snapshots contain bounded state flags and descriptions. Actor/display names remain personal information, and users can put personal text into those names; history is not anonymous. Session events describe their scope rather than exposing token hashes, cookies or a browser fingerprint.

## Deliberate boundaries

- Unsaved form edits, browser permission prompts, installation/update state, colour-scheme detection and other device-local UI state are not server mutations and are not recorded.
- Notification inbox rows are derived delivery state, retained as a bounded inbox. Delivery, throttling and inbox pruning are not participant modifications and do not generate history. The same applies to authentication/MCP rate counters, expired-session housekeeping, synchronization markers and migration backfills. Provider-expired push removal is recorded because it changes the account's persistent notification setting.
- API reads, downloads and failed login/authorization attempts are not modification events. This history is not an access log or a security intrusion log.
- Historical records created before these audit paths existed are not reconstructed or backdated. Legacy image metadata may have unknown size/type/checksum. Migration backfills add safe references; they do not establish who performed earlier actions.
- Browser notification summaries are separate from durable history. Pure expense/payment/draft additions and removals no longer generate collection-order holiday events; deliberate reorders and actual holiday-setting changes remain eligible. Draft-only updates stay silent.

## Reading, export and operations

Each receipt editor has a **Receipt history** view for that receipt's saved actions. The server selects its expense/draft family and current or earlier attached image events before pagination, so unrelated receipts cannot crowd out older actions. New expense saves record the consumed draft as `sourceDraftId` in the same financial write, so distinct draft/expense IDs keep pre-save questions, AI processing and image events after the draft is removed. Deleted draft links and restored expense IDs retain their history. Indexed entity/link lookups inspect the related family rather than parsing the holiday’s entire historical snapshots. Explicit draft-to-expense links take precedence over coincidentally matching IDs. Switching views keeps unsaved form values; unsaved edits do not create events.

History uses descending sequence cursors with pages of at most 50 events. Shared-history access is checked against current holiday access, while private history is always scoped to the current account. JSON/CSV history exports retain before/after snapshots; follow the returned cursor to obtain older pages. Current account/holiday snapshots are separate downloads and do not automatically include every history page. Exports exclude authentication secrets and receipt binaries and are not backups.

SQLite triggers reject modification, deletion and replacement of existing shared/private events. Application code cannot edit history through the ordinary write routes. An operator with database/schema privileges remains able to change the database; this is application-level append-only protection, not an external tamper-proof ledger.

Deployments using the current receipt cleanup require migrations through `0008_receipt_activity_scope.sql` in order. Receipt-scoped history uses the entity and expression indexes installed by `0008`. The message registry preserves immutable words and human authors through an indexed lookup instead of repeatedly parsing historical conversations. Assistant replies are identified by their role, without human speaker metadata. System cleanup is bounded, protects current references and pending uploads, and grants unknown-age historical images a fixed migration-based grace. Confirm the declared Worker timer is installed in the actual hosting environment before describing it as active. New future write routes must add an appropriately scoped event in the same guarded batch and verify no-op, failed-write, privacy and concurrency behavior. Do not infer coverage merely because a route calls the ledger reader.

Account erasure, agreed retention/redaction rules, historical anonymisation, restricted archives and production growth monitoring remain outstanding. Current profile edits or image purges do not redact earlier snapshots. Shared history can contain traveller emails and free text; downloads omit other travellers' structured contact emails without changing the stored history or authored text. Follow the [operations runbook](operations.md) for backup/restore precautions and the proposed privacy/retention design; do not disable append-only triggers for ad hoc deletion.
