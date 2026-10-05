# PR #6 follow-up review — 5 October 2026

N2: Native processing accepts unrelated global revision changes and requires the browser's source-draft hash before any model call. Its save writes one trip using the existing receipt-link data version, exact membership/profile-email/ownership guards and current receipt access. Other users' trips cannot invalidate the CAS or be overwritten. Same-trip changes retain bounded retries and draft/account/image checks; inference runs once. Activity records use the actual commit revision.

N4b: OAuth refresh persists valid rotated credentials before returning permission_required on a reduced grant. Later receipt access remains denied; disconnect revokes the new token. Existing account, refresh lease, version and encryption guards remain.

N3/N4: Build/preview requires an explicit valid owner email. Participants and the existing canonical owner do not depend on runtime bootstrap email configuration. The runnable operator-only transfer CLI requires a canonical linked target and expected owner/version, clears old ciphertext and appends an atomic private audit event; failure leaves the key/pin unchanged. It is not publicly exposed and was not run on production.

N6/N9: Setup budget and PKCE hashing use shared base64url SHA-256; test imports use one shared resolver. PR #5's one-snapshot auth fix is integrated.

Earlier N2–N9 validation: 839 tests passed; TypeScript, production build and lint pass (four existing warnings). All provider responses and accounts are synthetic. No paid model call, production write, deployment or merge into main was performed.

## PR8 F1–F5 follow-up

Scoped CAS and ledger reads share the exact raw stored-trip projection, including legacy whitespace, assistant attribution repair and unlinked member metadata; immutable audit before-images and final membership/data guards remain. SSE lines use one bounded reusable byte buffer and scan only newly received bytes. The1000000-byte result and6016384-byte event caps remain, with36098304-byte transport allowance for repeated escaped output. `draftHash` is required before key/budget/inference; revision-only payloads receive reload guidance; a legacy revision alongside a valid hash is accepted and ignored. The operator CLI requires explicit resources and expected pin/version, defaults to a read-only dry-run and has real local Wrangler/D1 subprocess and audit-rollback tests. PR6 full verification passes862 tests, types and lint (zero errors/four existing warnings). No production transfer or paid call was made.
