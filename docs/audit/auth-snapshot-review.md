# PR #5 auth snapshot review — 5 October 2026

N5 is addressed by resolving live-session precedence, canonical provider links, profile and auth flags in one indexed SQL snapshot. Established reads, including stale/expired-cookie provider fallbacks, do not call resolveIdentity again. ensureProfile consumes that snapshot's identity alongside its profile.

The security boundary is the atomic read: changes before it affect the result; changes after it affect the next request. Two successive reads no longer mix flags or principals. A trusted provider remains independently authenticated when an expired/deleted browser token falls back. Tests explicitly pin session precedence, canonical relinking, stored email verification and legacy credential disconnection. Profile bootstrap still guards provider links/credentials/session precedence in its mutation batch and rereads after creation; mutation authorization/CAS guards remain.

Shared encodings and SHA-256 helpers keep password/session namespaces and verification behavior. Data-URL harnesses have a shared import resolver.

Earlier N5 validation: 637 tests passed; TypeScript, production build and lint pass (four existing warnings). No production mutation, deployment or merge was performed.

## F8 — identity-only consumers and orphan sessions

The subsequent PR8 review found a separate two-statement identity fallback and orphan session precedence. `resolveIdentity` and `sessionIdentity` now reuse the atomic SQL snapshot, excluding sessions without profiles from precedence. Identity-only reads omit optional flags, session-only reads omit provider joins, and neither creates a profile. Tests cover stale/expired/orphan/duplicate cookies, canonical links, disconnection, signed-out behavior and fresh revocation reads. PR5 full validation passes652 tests, TypeScript and lint (zero errors/four existing warnings); native and API access regressions also pass in the combined branch.
