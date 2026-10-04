# TripTab operations

This is an operator procedure, not a record of a production backup or restore. No scheduled backup, automated monitoring, restore drill, email delivery service or production gateway verification is introduced by this change. Complete and record those actions separately with access to the actual Sites resources.

## Release and migration records

GitHub is the source mirror. ChatGPT Sites owns the production source repository, environment and deployment. A passing GitHub workflow or a merge into `main` does not publish the Site.

For each release, record the GitHub commit, Sites source commit/version, deployment ID, environment revision, release time in UTC, migration filenames and hashes, backup location and recovery bookmark. Keep the record outside application data so it remains available during an incident. Compare these commits before publishing to detect source drift.

1. Run `npm run install:ci`, `npm test`, `npx --no-install tsc --noEmit`, `npm run lint` and `npm run build` from a clean checkout.
2. Test new migrations against both an empty database and a copy of the previous schema/data. Check that financial totals, account ownership, memberships and receipt links survive.
3. Inspect the current production migration state through the authorized Sites deployment tooling. The Drizzle journal lists generated migrations; it does not prove they were applied to a particular database. Never replay an already-applied file. If an applied-migration record cannot be obtained, establish it before proceeding rather than guessing.
4. Take a recoverable D1/R2 backup and record a D1 Time Travel bookmark before any production schema change. For changes that need a consistent database/object snapshot, pause writes through an operator-controlled maintenance mechanism. TripTab currently has no built-in maintenance switch.
5. Publish through the Sites build/version/deploy workflow, allowing its migration lifecycle to manage the target database. Do not run local Wrangler commands against production as an additional migration path.
6. After the deployment succeeds, verify the approved release's essential journeys with test accounts: login, existing trip read, expense save, shared-trip access, receipt upload/retrieval and balances. Record the result and keep the previous Sites version available.

Code using activity history, receipt lifecycle and private account history requires migrations through `0007_receipt_message_registry.sql` in order before it serves traffic. Migration `0005` adds invitation/image audit metadata and browser-subscription generations; `0006` gives active historical images with unknown dates a fixed 24-hour cleanup grace without inventing an upload date. Migration `0007` backfills an immutable receipt-message lookup from historical and live conversations, then updates it atomically as new activity is recorded. Measure this one-time backfill on a production-sized copy before release; ordinary new questions use bounded indexed lookups. A local migration or a generated SQL journal does not establish production readiness. Apply the migrations through Sites' release path and retain its applied-migration evidence.

Installations that applied the standalone `0007` receipt-message registry backport must still apply `0005` and `0006` by their explicit filenames through the recorded migration lifecycle. A timestamp-only migrator can skip these earlier entries; do not replay the already applied `0007` SQL.

Redeploying a previous Sites version rolls back code, not necessarily D1 data or schema. Confirm that the previous code is compatible with the current schema before using it. A financial-data problem may require a data restore and reconciliation as well as a code rollback.

## Embedded preview release check

The Worker's current `frame-ancestors` policy allows `'self'`, `https://chatgpt.com`, `https://*.chatgpt.com`, `https://chatgpt-team.site` and `https://*.chatgpt-team.site`. The published child app's `*.chatgpt.site` address does not imply that this domain is also a parent frame; every ancestor origin must independently match the policy.

For the approved release, exercise the actual Sites preview and ChatGPT embed through their supported platform interface. Record the ancestor origins and sandbox configuration, effective CSP headers, successful hydration/interactions, and any browser framing violations. Standalone navigation and simulated local frames cannot establish hosted compatibility. If an ancestor is blocked, confirm its platform ownership and necessity before adding that specific origin; do not add a broad `*.chatgpt.site` wildcard based only on the app's address. This hosted check remains unperformed for the current changes.

## User data downloads

The account's **Download your data** panel provides account JSON, holiday JSON, a financial CSV and paginated history downloads. Private account history is available separately in JSON/CSV and never includes another account's events. This is a user download, not an operator backup or recovery mechanism.

Account JSON includes the caller's own profile and current trips they own or belong to; holiday JSON includes the selected authorized trip, item splits, drafts and receipt conversations. It contains shared financial records, not only entries created by the caller. JSON and history JSON/CSV omit other travellers' structured contact email fields, including historical snapshots; this does not scrub email-like text authored in names, notes or messages and does not alter live history. Optional receipt metadata describes attached receipt IDs and trip IDs; it does not contain image bytes, unreferenced stored images or R2 recovery material. Downloads exclude credentials, sessions, invitation secrets and provider account links.

Financial CSV contains posted expenses and payments, with transaction date/time/timezone retained as entered and money explicitly labelled in stored hundredths (`amountScale: 100` in JSON). History pages contain up to 50 events, may be smaller for large snapshots, and use UTC event/export timestamps. Use **Older history CSV** until no older page is offered to collect earlier history. Spreadsheet-dangerous text is prefixed with an apostrophe and CSV quoting preserves commas, quotes and multiline notes.

Exports check current owner/membership access. Leaving or losing access to a shared trip means its data cannot be downloaded subsequently; data already downloaded is outside TripTab's control. A size limit may require exporting holidays individually. Downloaded JSON/CSV does not include all database tables, all historical versions or receipt binaries, does not create a consistent D1/R2 restore point, and has no automatic restore/import path. Continue using the separate operator backup procedure below.

## D1 backup

Obtain the real production database identifier, authorized operator credentials and supported maintenance path from Sites. The generated local `dist/server/wrangler.json` uses placeholder bindings and is not a production configuration. If Sites does not grant direct Cloudflare access, perform these operations through Sites support/tooling instead.

Where direct access is authorized, the installed Wrangler supports the following reference commands. Substitute a separately secured configuration with the actual database; do not use the local placeholder configuration:

```sh
npx --no-install wrangler d1 time-travel info DB --config /secure/path/production.wrangler.json --json
npx --no-install wrangler d1 export DB --remote --config /secure/path/production.wrangler.json --output /secure/path/triptab-backup.sql
```

Record the returned bookmark and timestamp, database identifier, schema/migration state, export checksum and file size. Confirm that Time Travel is available and determine its retention window for the actual account; an old bookmark outside that window is not a backup. Keep encrypted SQL exports in restricted storage separate from the production account and test that they can be decrypted. Exports contain profiles, financial details, password hashes, session hashes and invitation data, so do not commit them or attach them to public issues.

Choose a backup interval and retention policy appropriate to the acceptable amount of lost work, and assign an operator to check success and expiration. This repository does not schedule or upload backups.

## R2 receipt backup

D1 Time Travel does not restore R2 objects. Back up the stored images as well as the D1 receipt metadata. New browser uploads are prepared JPEGs; an old object's bytes may still be its original upload.

1. Through an authorized R2 API or S3-compatible tool, enumerate the actual receipt bucket and copy its objects to a separate restricted backup location. Preserve each exact object key, content type and bytes; receipt keys include the original owner and receipt ID.
2. Store a manifest with object keys, sizes, checksums, copy time and the matching D1 snapshot/bookmark. Verify copied bytes rather than treating a listing or ETag alone as proof of a complete copy.
3. Reconcile the D1 `receipts` records and receipt references in trip data against the manifest. Identify missing referenced images and unreferenced objects. Report them for review; do not delete objects as part of a backup or restore.
4. Protect backups from the same accidental deletion or credential compromise as the live bucket. Confirm the retention policy and available provider recovery facilities rather than assuming R2 has usable historical object versions.

Do not put bucket credentials in this repository or shell command arguments. Use the operator's protected credential store/environment and the provider's documented access controls.

## Receipt cleanup and recovery

The receipt table reserves quota before upload, then changes `pending` to `active` after R2 succeeds. Limits are 500 images per uploader account and 200 per holiday; pending/deleting rows retain their quota slots until cleanup succeeds. A saved expense or draft can reference only an active image. Direct deletion of a still-referenced image returns 409; detach it from the saved receipt entry first.

Removing the last saved expense/draft reference marks the image `deleting`. R2 deletion is idempotent and failures retain the D1 cleanup record for a later retry. Opportunistic maintenance remains bounded. A global Worker task can also mark up to 20 active, unreferenced images and retry up to 20 deletions per run without a participant request. Known upload dates must be at least 24 hours old; unknown dates require the fixed migration `0006` grace to have elapsed. Pending uploads and current expense/draft references remain protected, with exact-state checks and system audit events preserving the initiating participant.

The Cloudflare-compatible build declares `*/15 * * * *` in UTC and exports a `scheduled` handler. Confirm timer registration and successful executions in the actual Sites release environment: the available Sites API exposes cloud updater tasks but does not verify Worker Cron activation. Do not claim cleanup is autonomous in production until this is established. No public maintenance endpoint or unauthenticated cleanup action is exposed. Failed cleanup keeps durable tombstones for later retry.

For a cleanup incident, preserve a D1/R2 recovery point and compare the image record, current trip references and object key before taking action. Never age out `pending` rows automatically: an upload may still be writing. Establish that its request has finished or failed before using an authorized recovery operation. Legacy records with an empty creation time also need operator review; do not substitute a guessed age. Retain a `deleting` row until object deletion has succeeded, and inspect repeated failures rather than discarding the retry record.

History restoration recreates the financial entry after user review; it does not recover a purged image. Recovering historical image bytes requires the matching operator R2 backup. A full account-erasure/retention policy remains outstanding.

## Health checks

`GET /healthz` returns uncached `{"status":"ready"}` or a generic 503 `{"status":"unavailable"}`. It compiles a read-only query against the activity, receipt-lifecycle and message-registry columns, requires the registry lookup index, and checks that the R2 binding exposes `get`, `put` and `delete`. It does not read/write a bucket object, prove R2 network availability, check email delivery or establish the production gateway's identity protections.

Use this endpoint as one signal when configuring an external monitor through the hosting operator. Also verify authorized application journeys after a release. No external uptime monitor, alert recipient or production probe is configured by this repository change.

## History privacy and retention design

Shared holiday and private account histories are append-only: SQLite triggers reject event UPDATE/DELETE and replacement of existing events. Financial snapshots can contain actor display names and member emails; private account events use state flags and safe descriptions without authentication secrets. Purging a receipt image does not erase these snapshots. Account deletion is not implemented, and changing a current profile does not redact its historical values. See [audit coverage](audit-coverage.md) for the write-path matrix and the operational/browser state that is deliberately excluded. The following is a proposed design checklist, not an agreed retention policy or an available erasure operation.

- Decide which shared financial facts must be retained, which personal identifiers can be removed, and who can authorize redaction when other travellers rely on the history. Include downloaded exports, R2 images and backup copies in the policy.
- Minimise personal identifiers in future snapshots after checking that history display, financial review and recovery still work. Define how existing actor names, email fields and free-text details would be handled rather than treating an ID replacement as complete erasure.
- Design a narrowly scoped operator migration/redaction mechanism with an authorization boundary, a record of the approved action, transactional verification and a preserved financial audit trail. Current append-only triggers must remain intact until that mechanism and its restore implications are reviewed and tested. Do not disable them to perform ad hoc production deletion.
- Define retention and restricted archival access, then test redaction against current trips, historical snapshots, exports and restored backups. A backup restore must not silently undo a completed privacy operation. Account-deletion UI must wait until these semantics and the recovery procedure are agreed.

Expense/payment/draft additions and removals produce their entity events without a redundant full collection-order holiday event. Deliberate relative reorders still record before/after order, and traveller placement remains recorded for deterministic penny allocation.

Monitor history growth using aggregate event counts, snapshot bytes per trip, growth per successful mutation, write-batch cost and bounded-page latency. For example, an authorized read-only operator query can establish a baseline without dumping receipt contents:

```sql
SELECT trip_id, COUNT(*) AS events,
       SUM(length(CAST(coalesce(before_data, '') AS BLOB))
         + length(CAST(coalesce(after_data, '') AS BLOB))) AS snapshot_bytes
FROM activity_events
GROUP BY trip_id;
```

Apply the same aggregate count/byte monitoring to `account_activity_events`, grouped by `user_id`, without exposing private snapshots. Treat trip/account identifiers and the resulting metrics as private operator data. Choose alert thresholds and capacity headroom from the actual D1 plan, normal trip sizes and measured write behavior; indexed 50-event reads alone do not establish safe write/storage scale. Record an approved archive/redaction migration before applying retention: the current triggers intentionally block deletion, and no automatic pruning or compaction is implemented. Production growth monitoring and real-D1 load measurements remain outstanding.

## Restore drill and incident recovery

First run the following procedure on isolated resources. Record the recovery point, duration, missing changes and validation results. Until that drill succeeds, restore capability remains unverified.

1. Stop or isolate writes using the hosting/operator mechanism. Record the incident time, active Sites version, affected resources and the last known good backup. Preserve a fresh snapshot of the damaged state for investigation.
2. Create an isolated D1 database and R2 bucket with no access from normal users. Restore the SQL export into the empty database using the authorized provider import tooling. Copy the matching R2 objects under their original keys. Use the migration state from that snapshot; do not blindly apply every migration again.
3. Run SQLite integrity/foreign-key checks, parse stored trip data with the application validator, and recompute shares and balances. Check that each expense's shares sum to its converted total, each trip's balances sum to zero, and payments reference valid participants. Compare counts and representative amounts to the backup record.
4. Verify profile ownership, memberships, auth links and image references. Exercise login, a shared invite, receipt viewing and an expense update against the isolated restore. Include a trip with a bank-converted foreign-currency charge and item/receipt percentage splits.
5. Choose the production recovery point only after those checks. For an in-place D1 Time Travel restore, the installed CLI uses the command below; it overwrites the remote database and requires an operator-approved recovery window:

   ```sh
   npx --no-install wrangler d1 time-travel restore DB --bookmark RECORDED_BOOKMARK --config /secure/path/production.wrangler.json
   ```

   Restore the matching R2 snapshot separately through the authorized object-storage path. If moving to replacement resources, update bindings only through Sites environment/deployment management.
6. Restore compatible application code through Sites. Review sessions and invitations restored from the earlier snapshot: previously revoked tokens may become valid again. Revoke affected sessions and live invitation tokens through an authorized maintenance operation before reopening, and provide users with a new login/invite path.
7. Repeat the integrity checks and user journeys against the recovered resources before resuming writes. Record any transactions created after the recovery point that must be reconciled with participants; never silently invent or discard replacement financial entries.

## Outstanding operational work

- Confirm with Sites that the production gateway strips user-supplied `oai-authenticated-*` headers and that the Worker cannot be reached through a route bypassing that gateway. Local tests cannot establish this production trust boundary.
- Configure and exercise encrypted D1/R2 backups and a restore drill; choose retention and incident ownership.
- Add production monitoring, structured request/error logs without receipt contents or credentials, and scheduled financial/receipt reconciliation. CI regression tests do not monitor live data.
- Implement email verification and recovery delivery before describing an email as verified or offering email-based account recovery. Current email/password accounts do not require ChatGPT, and matching email addresses do not establish identity or merge accounts.
- Decide the migration tracking and promotion policy with Sites. Historical generated SQL files and build artifacts alone are not a production migration ledger.
