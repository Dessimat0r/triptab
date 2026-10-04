# Audit implementation status

This document tracks the follow-up to PR #1. [The original audit](TRIPTAB_AUDIT.md), [second-pass review](SECOND_PASS_REVIEW.md) and their reproduction scripts remain unchanged historical evidence. Their original test counts and findings describe the versions examined then.

**Implemented** means the corresponding change exists in this branch; final validation is recorded below. **Partial** means a useful fix shipped but the wider recommendation remains open. **Open/unverified** means this change does not resolve the finding. This is not a beta-readiness assessment or evidence of a production deployment, restore drill or gateway verification.

## First-pass findings

| Finding | Status | Change and remaining scope |
|---|---|---|
| F-01 · Authorship/history | Partial | Immutable, server-attributed activity events retain before/after snapshots in the mutation's CAS-guarded D1 batch; a History view displays them. Members still edit shared records. Roles, approvals, per-record authorship fields and soft-delete/restore remain open. |
| F-02 · Payments | Implemented core | Manual sender/recipient/amount/date/time/method/note, partial payments, edit, review/confirm, stable IDs and duplicate/reverse/overpayment warnings. Confirmation records an already-completed transfer; recipient acknowledgement is not implemented. |
| F-03 · Global revisions | Partial | One safe rebase/retry handles unrelated changes; conflicting financial entities require explicit review. The global CAS, whole-ledger payload and cross-trip contention remain; granular mutations/per-trip revisions are deferred. |
| F-04 · Account lifecycle | Partial | Current-password-protected password changes revoke other sessions. Verification delivery, password recovery, session-management UI, export and account deletion remain open. |
| F-05 · Gateway identity trust | Unverified | Production header stripping and gateway-bypass protection still require confirmation from Sites. Browser/MCP Origin checks do not establish this trust boundary. |
| F-06 · Operations/testing | Partial | Direct `tsx`, `npm test`, read-only CI, focused regression/invariant/SQLite tests and an [operations runbook](../operations.md). Actual encrypted backups, restore drills, monitoring and production migration/promotion controls remain open. |
| F-07 · Invitations | Open | Acceptance is recorded in history, but email ownership is unverified. Revoke/regenerate, pending-invite management and explicit inherited-history confirmation remain open; an invite secret grants access. |
| F-08 · Receipt lifecycle | Open | Receipt deletion, reference counting, orphan collection, quotas and retention/erasure policy are not implemented. Image preparation does not solve existing-object retention. |
| F-09 · Photo preparation | Implemented browser path | New browser uploads are decoded, orientation-normalised, resized to a 2,000-pixel long edge and re-encoded as JPEG without original EXIF. Server limits remain. Real-camera/HEIC behavior needs device testing; old stored images are unchanged. |
| F-10 · Hidden bank override | Implemented | New/changed receipts reject same-currency or zero bank charges; posted original/converted totals must be positive. MCP clears stale currency-dependent data. Unchanged legacy records are retained for explicit review rather than silently rewritten. |
| F-11 · Stale edits/resurrection | Implemented client guard | Editor baselines are compared before save and after refresh; a changed/deleted expense produces a conflict review. Recreating a deleted entry requires an explicit new-entry choice. Per-entity server revisions remain part of F-03. |
| F-12 · Destructive actions | Partial | Expense/payment/draft removal requires confirmation and preserves activity snapshots. Undo, tombstones and a restore UI are not implemented. |
| F-13 · Settlement explanation | Partial | Traveller statements show expense shares and payments; suggestions explain their simplification. Exact opposite balances pair first with deterministic ordering; the remaining greedy algorithm is not a globally optimal minimal-transfer search. |
| F-14 · Local dates/timezones | Implemented | Local date/time helpers replace UTC defaults; the editor offers supported IANA zones. Midnight/DST date and FX validation receive regression coverage. |
| F-15 · Currency precision/scope | Partial | Manual/reference/bank provenance is labelled correctly. The existing 25-currency scope and 15-currency reference provider remain; ISO minor-unit migration, especially ISK, and broader currency support are deferred. |
| F-16 · Auth abuse | Partial | Registration, login and password setup use separate IP/email budgets; successful logins retain the IP budget. Per-email lockout/enumeration concerns still need broader abuse controls and account verification. |
| F-17 · Notifications | Partial | Committed non-draft events produce actor/action/entity notifications with a generic “TripTab activity” title; draft-only changes do not notify. Shared-device subscription ownership and finer recipient/privacy controls remain open. |
| F-18 · HTTP headers | Implemented baseline | Worker responses add framing CSP, no-referrer, nosniff, Permissions-Policy and HTTPS HSTS. Inline framework hydration still requires `unsafe-inline`; this is not a strict nonce-based XSS policy. Hosted enforcement needs deployment checks. |
| F-19 · AI/MCP scope | Partial | Discovery returns summaries; detail reads and write responses scope to one trip and omit member emails. AI provenance/activity and browser request checks are added. Model-specific prompt injection, fine-grained permissions and MCP abuse limits remain open. |
| F-20 · JSON-blob scale | Open | Whole-ledger size/trip limits and JSON storage remain. Client rebasing does not remove payload, validation or D1 scale limits. |
| F-21 · Remainder penny bias | Open | Existing exact deterministic rounding is retained. Penny-recipient rotation and an associated behavior migration are deferred. |
| F-22 · Traveller removal/history | Partial | Member/reference rewrites are visible in immutable history. The broad shared-edit policy and missing removal/ownership workflow remain; history is not an authorization restriction. |
| F-23 · Trip lifecycle | Open | Close/archive/delete/leave, ownership transfer and dedicated traveller/date-management workflows are not introduced here. |
| F-24 · Duplicate names | Implemented | New/changed traveller names are trimmed and checked case-insensitively for uniqueness. Unchanged legacy duplicates remain readable until corrected. |
| F-25 · Default payer | Implemented | New expenses and uploaded receipts select the signed-in traveller, falling back to the first traveller only when no linked match exists. |
| F-26 · Hashing/cleanup | Partial | Bounded opportunistic cleanup removes expired sessions and stale rate windows. The Workers PBKDF2 work factor/rehash strategy and used-invite purge remain unchanged. |
| F-27 · Accessibility | Partial | Larger touch targets, reduced motion, contextual receipt alternatives and save/status announcements supplement modal focus handling. Real screen-reader, contrast and device QA remain open. |
| F-28 · PWA updates/offline | Partial | Waiting-worker updates get an explicit update/later prompt; active forms block the reload action. Private ledgers remain outside offline caches. Real installed-PWA/offline behavior still needs device testing. |
| F-29 · Stale balances | Partial | Focus/visibility refresh, refresh before balances/payment entry and a visible last-refresh time reduce stale suggestions. Periodic ETag polling/realtime updates are not implemented. |
| F-30 · Zero-money edges | Partial | A zero original posted receipt total cannot be replaced by a positive bank charge. With zero-priced items and positive tax/tip, the existing allocation across all trip members is retained; selected-person semantics still need a separate decision. |
| F-31 · Legacy schema | Open | The unused original `ledgers` table remains to preserve migration history. Membership/receipt profile foreign-key migration and archival policy are deferred. |
| F-32 · Lint hygiene | Checked | No lint/type errors. Four lint warnings remain: three existing native-image/internal-navigation warnings and one unused variable in historical audit evidence, which is preserved. |

## Second-pass findings

| Finding | Status | Change and remaining scope |
|---|---|---|
| S-01 · AI currency correction | Implemented | Currency changes clear omitted bank charges and rates; explicit replacements receive model validation. Same-currency hidden bank charges cannot enter a new/changed saved receipt. |
| S-02 · Editor 409 dead end | Implemented client recovery | Refresh/rebase and retry once when edited entities are unchanged; otherwise retain the form and require conflict review. Repeated contention reports an error without discarding the entry. Global revisions remain. |
| S-03 · Receipt refresh overwrite | Implemented client guard | Receipt refresh checks the saved financial baseline before adopting results; independently appended chat messages can merge. A concurrent financial edit/deletion needs explicit review. |
| S-04 · Login resets IP budget | Implemented | Successful authentication clears only its email counter; independent IP budgets remain consumed. Regression coverage includes interleaved successful own-account logins. |
| S-05 · FX bounds/plausibility | Implemented safeguards | Converted totals use the normal money-field cap and intermediate arithmetic rejects unsafe sums. Manual-rate outliers require UI confirmation; when available, a matching reference rate supports the comparison. Rates remain positive finite values rather than an arbitrary universal range. |
| S-06 · Email squatting | Open | Credential email uniqueness still permits an unverified registration to block password setup. The error explains the collision and existing ChatGPT sign-in remains usable; no unsafe email-based merge or takeover is introduced. Verification/recovery is required for resolution. |
| S-07 · MCP browser boundary | Implemented | JSON is required; foreign browser Origin/cross-site Fetch Metadata is rejected before private tool work. Same-origin requests and non-browser ChatGPT/Codex clients remain supported. |
| S-08 · Weak-currency reference precision | Unverified | The live provider probe returned HTTP 403 in this environment. Direction/precision comparison and any inverse-pair change remain pending; bank-charge/manual-rate fallback does not establish provider precision. |

## Validation record

Integrated local checks recorded on 4 October 2026. These are the follow-up's results, not the audit's historical counts.

| Check | Result |
|---|---|
| Clean locked installation (`npm run install:ci`) | Passed in an isolated clean directory; 687 packages installed |
| Regression suite (`npm test`) | 120/120 passed |
| TypeScript (`npx --no-install tsc --noEmit`) | Passed; 0 errors |
| ESLint (`npm run lint`) | Passed; 0 errors, 4 warnings described above |
| Production build (`npm run build`) | Passed |
| CI workflow (`actionlint`) | Passed |
| Native local HTTP checks | 22 checks plus 4 invitation/activity checks passed |
| Native local browser checks | 20/20 passed; mounted 320/390/768-pixel layouts in light/dark mode showed no horizontal overflow |
| Historical-data UI recovery | 6 checks passed: saved invalid bank charge stays visible, explicit correction succeeds, history retains the old value, balances recover and no browser errors occur |
| Compiled Worker/browser checks | 8 checks passed: actual response security headers/private caching and standalone signup hydration at 320/390/1440 pixels without overflow or CSP errors |
| Production deployment, gateway verification, backup/restore drill | Not performed by this code change |

Focused tests cover financial conservation, bank/FX validation, local dates, client rebasing, authentication limits, MCP boundaries, Worker headers, SQLite migrations and storage/route authorization. SQLite shims and browser emulation do not substitute for real-D1 load tests, physical iOS/Android/PWA camera/push checks, or a screen-reader audit.

The remaining wider work includes account verification/recovery/export/deletion; invitation revocation and verified binding; receipt lifecycle/quotas; granular per-trip revisions and storage scale; notification privacy; production gateway assurance, backups/restores and monitoring; currency minor-unit migration and penny rotation; and device/accessibility validation.
