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

Redeploying a previous Sites version rolls back code, not necessarily D1 data or schema. Confirm that the previous code is compatible with the current schema before using it. A financial-data problem may require a data restore and reconciliation as well as a code rollback.

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

D1 Time Travel does not restore R2 objects. Back up the original images as well as the D1 receipt metadata.

1. Through an authorized R2 API or S3-compatible tool, enumerate the actual receipt bucket and copy its objects to a separate restricted backup location. Preserve each exact object key, content type and bytes; receipt keys include the original owner and receipt ID.
2. Store a manifest with object keys, sizes, checksums, copy time and the matching D1 snapshot/bookmark. Verify copied bytes rather than treating a listing or ETag alone as proof of a complete copy.
3. Reconcile the D1 `receipts` records and receipt references in trip data against the manifest. Identify missing referenced images and unreferenced objects. Report them for review; do not delete objects as part of a backup or restore.
4. Protect backups from the same accidental deletion or credential compromise as the live bucket. Confirm the retention policy and available provider recovery facilities rather than assuming R2 has usable historical object versions.

Do not put bucket credentials in this repository or shell command arguments. Use the operator's protected credential store/environment and the provider's documented access controls.

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
