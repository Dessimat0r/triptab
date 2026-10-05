# PR #5 auth snapshot review — 5 October 2026

N5 is addressed by resolving live-session precedence, canonical provider links, profile and auth flags in one indexed SQL snapshot. Established reads, including stale/expired-cookie provider fallbacks, do not call resolveIdentity again. ensureProfile consumes that snapshot's identity alongside its profile.

The security boundary is the atomic read: changes before it affect the result; changes after it affect the next request. Two successive reads no longer mix flags or principals. A trusted provider remains independently authenticated when an expired/deleted browser token falls back. Tests explicitly pin session precedence, canonical relinking, stored email verification and legacy credential disconnection. Profile bootstrap still guards provider links/credentials/session precedence in its mutation batch and rereads after creation; mutation authorization/CAS guards remain.

Shared encodings and SHA-256 helpers keep password/session namespaces and verification behavior. Data-URL harnesses have a shared import resolver.

Validation: 637 tests pass; TypeScript, production build and lint pass (four existing warnings). No production mutation, deployment or merge was performed.
