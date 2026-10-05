# PR #6 follow-up review — 5 October 2026

N2: Native processing accepts unrelated global revision changes and optionally validates the browser's source-draft hash before any model call. Its save writes one trip using the existing receipt-link data version, exact membership/profile-email/ownership guards and current receipt access. Other users' trips cannot invalidate the CAS or be overwritten. Same-trip changes retain bounded retries and draft/account/image checks; inference runs once. Activity records use the actual commit revision.

N4b: OAuth refresh persists valid rotated credentials before returning permission_required on a reduced grant. Later receipt access remains denied; disconnect revokes the new token. Existing account, refresh lease, version and encryption guards remain.

N3/N4: Build/preview requires an explicit valid owner email. Participants and the existing canonical owner do not depend on runtime bootstrap email configuration. The documented operator-only transfer helper requires a canonical linked target and expected owner/version, clears old ciphertext and appends an atomic private audit event; failure leaves the key/pin unchanged. It is not publicly exposed and was not run on production.

N6/N9: Setup budget and PKCE hashing use shared base64url SHA-256; test imports use one shared resolver. PR #5's one-snapshot auth fix is integrated.

Validation: 839 tests pass; TypeScript, production build and lint pass (four existing warnings). All provider responses and accounts are synthetic. No paid model call, production write, deployment or merge into main was performed.
