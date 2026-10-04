# Audit implementation status

This document tracks the follow-up to PR #1. [The original audit](TRIPTAB_AUDIT.md), [second-pass review](SECOND_PASS_REVIEW.md) and their reproduction scripts remain unchanged historical evidence. Their original test counts and findings describe the versions examined then.

**Implemented** means the corresponding change exists in this branch; final validation is recorded below. **Partial** means a useful fix shipped but the wider recommendation remains open. **Open/unverified** means this change does not resolve the finding. This is not a beta-readiness assessment or evidence of a production deployment, restore drill or gateway verification.

## First-pass findings

| Finding | Status | Change and remaining scope |
|---|---|---|
| F-01 · Authorship/history | Partial | Immutable, server-attributed activity events retain before/after snapshots in the mutation's CAS-guarded D1 batch. History offers reviewed restoration of deleted expenses/payments as new entries. Members still edit shared records; roles, approvals, per-record authorship fields and soft-delete tombstones remain open. |
| F-02 · Payments | Implemented core | Manual sender/recipient/amount/date/time/method/note, partial payments, edit, review/confirm, stable IDs and duplicate/reverse/overpayment warnings. A newly matching payment detected during a retry requires another explicit confirmation. Confirmation records an already-completed transfer; recipient acknowledgement is not implemented. |
| F-03 · Global revisions | Partial | One safe rebase/retry handles unrelated changes; conflicting financial entities require explicit review. The global CAS, whole-ledger payload and cross-trip contention remain; granular mutations/per-trip revisions are deferred. |
| F-04 · Account lifecycle | Partial | Current-password-protected password changes revoke other sessions. Account/holiday JSON and financial/history CSV downloads require current membership and omit credentials and image bytes. Verification delivery, password recovery, session-management UI and account deletion remain open; downloads are not a backup/import mechanism. |
| F-05 · Gateway identity trust | Unverified | Production header stripping and gateway-bypass protection still require confirmation from Sites. Browser/MCP Origin checks do not establish this trust boundary. |
| F-06 · Operations/testing | Partial | Direct `tsx`, `npm test`, read-only CI, focused regression/invariant/SQLite tests and an [operations runbook](../operations.md). `/healthz` checks required D1 schema and R2 binding methods, not R2 networking. Actual encrypted backups, restore drills, external monitoring and production migration/promotion controls remain open. |
| F-07 · Invitations | Partial | Owners can list, revoke and replace pending links. Acceptance previews the trip and requires inherited-history consent; the resulting member change is recorded in history. Invite issuance/revocation do not have separate activity events. Email ownership and verified-email binding remain unimplemented; an invite secret grants access. |
| F-08 · Receipt lifecycle | Partial | D1 reservations enforce 500 images/account and 200/trip, with pending/active/deleting states and CAS-guarded attachment checks. Referenced-image deletion returns 409; removing the last reference schedules R2 purge with retry. Bounded cleanup considers at most 20 active, unreferenced objects with known age ≥24 hours. Pending uploads are never swept and unknown-age legacy objects need operator review; full retention/account-erasure policy remains open. |
| F-09 · Photo preparation | Implemented browser path | New browser uploads are decoded, orientation-normalised, resized within 4 million pixels/8,192 pixels per dimension and re-encoded as JPEG without original EXIF. The 5 MiB encoded-upload limit remains. Real-camera/HEIC behavior needs device testing; old stored images are unchanged. |
| F-10 · Hidden bank override | Implemented | New/changed receipts reject same-currency or zero bank charges; posted original/converted totals must be positive. MCP clears stale currency-dependent data. Unchanged legacy records are retained for explicit review rather than silently rewritten. |
| F-11 · Stale edits/resurrection | Implemented client guard | Editor baselines are compared before save and after refresh; a changed/deleted expense produces a conflict review. Recreating a deleted entry requires an explicit new-entry choice. Per-entity server revisions remain part of F-03. |
| F-12 · Destructive actions | Partial | Expense/payment/draft removal requires confirmation and preserves activity snapshots. History can open a deleted expense/payment for review and explicit confirmation as a new entry. Purged images are not restored. Toast undo, tombstones and restoration for every entity type remain open. |
| F-13 · Settlement explanation | Partial | Traveller statements show expense shares and payments; suggestions explain their simplification. Exact opposite balances pair first with deterministic ordering; the remaining greedy algorithm is not a globally optimal minimal-transfer search. |
| F-14 · Local dates/timezones | Implemented | Local date/time helpers replace UTC defaults; the editor offers supported IANA zones. Midnight/DST date and FX validation receive regression coverage. |
| F-15 · Currency precision/scope | Partial | Manual/reference/bank provenance is labelled correctly. The existing 25-currency scope and 15-currency reference provider remain; ISO minor-unit migration, especially ISK, and broader currency support are deferred. |
| F-16 · Auth abuse | Partial | Registration, login and password setup use separate IP/email budgets; successful logins retain the IP budget. Per-email lockout/enumeration concerns still need broader abuse controls and account verification. |
| F-17 · Notifications | Partial | Committed non-draft events produce actor/action/entity notifications with a generic “TripTab activity” title; draft-only changes do not notify. Subscriptions check current account ownership, and a hash-bound browser proof lets logout remove only that device. Finer recipient/privacy controls and physical-device validation remain open. |
| F-18 · HTTP headers | Implemented baseline | Worker responses add framing CSP, no-referrer, nosniff, Permissions-Policy and HTTPS HSTS. Inline framework hydration still requires `unsafe-inline`; this is not a strict nonce-based XSS policy. Hosted enforcement needs deployment checks. |
| F-19 · AI/MCP scope | Partial | Discovery returns summaries; detail reads and write responses scope to one trip and omit member emails. AI provenance/activity, browser request checks and a 120-call/minute budget per provider identity are added. Model-specific prompt injection, fine-grained permissions and broader abuse controls remain open. |
| F-20 · JSON-blob scale | Open | Whole-ledger size/trip limits and JSON storage remain. Client rebasing does not remove payload, validation or D1 scale limits. |
| F-21 · Remainder penny bias | Open | Existing exact deterministic rounding is retained. Penny-recipient rotation and an associated behavior migration are deferred. |
| F-22 · Traveller removal/history | Partial | Member/reference rewrites are visible in immutable history. The broad shared-edit policy and missing removal/ownership workflow remain; history is not an authorization restriction. |
| F-23 · Trip lifecycle | Partial | Holiday dates and traveller names can be edited with validation. Close/archive/delete/leave, ownership transfer and dedicated membership-removal workflows remain open. |
| F-24 · Duplicate names | Implemented | New/changed traveller names are trimmed and checked case-insensitively for uniqueness. Unchanged legacy duplicates remain readable until corrected. |
| F-25 · Default payer | Implemented | New expenses and uploaded receipts select the signed-in traveller, falling back to the first traveller only when no linked match exists. |
| F-26 · Hashing/cleanup | Partial | Bounded opportunistic cleanup removes expired sessions and stale rate windows. The Workers PBKDF2 work factor/rehash strategy and used-invite purge remain unchanged. |
| F-27 · Accessibility | Partial | Larger touch targets, reduced motion, contextual receipt alternatives and save/status announcements supplement modal focus handling. Real screen-reader, contrast and device QA remain open. |
| F-28 · PWA updates/offline | Partial | Waiting-worker updates get an explicit update/later prompt; active forms block the reload action. Private ledgers remain outside offline caches. Real installed-PWA/offline behavior still needs device testing. |
| F-29 · Stale balances | Partial | Focus/visibility refresh, refresh before balances/payment entry, a visible last-refresh time and 30-second HEAD/ETag polling detect accessible-trip changes. Unrelated trips do not change the user's ETag. Realtime updates and finer server revisions remain open. |
| F-30 · Zero-money edges | Implemented versioned rule | A zero original posted receipt total cannot be replaced by a positive bank charge. New/updated zero-priced item receipts allocate positive adjustments among selected participants; an explicit version marker preserves unchanged legacy allocation across all trip members. Historical entries are not silently recalculated. |
| F-31 · Legacy schema | Open | The unused original `ledgers` table remains to preserve migration history. Membership/receipt profile foreign-key migration and archival policy are deferred. |
| F-32 · Lint hygiene | Checked | No lint/type errors. Four lint warnings remain: three existing native-image/internal-navigation warnings and one unused variable in preserved historical audit evidence. |

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

## Additional PR review

These dispositions address the eight findings in [the 4 October PR comment](https://github.com/Dessimat0r/triptab/pull/1#issuecomment-5980411489). They supplement the historical F/S findings; they do not replace the original reports.

| Finding | Status | Disposition and remaining scope |
|---|---|---|
| R-01 · Generic validation errors | Implemented | Typed `LedgerValidationError` messages return HTTP 400 without logging financial values; unexpected internal failures retain the generic response and value-free diagnostics. Scoped model/store tests passed 71 checks, including seven HTTP rule failures with unchanged data/revision/history and a simulated SQLite failure proving rollback and generic errors. |
| R-02 · Tall receipt readability | Implemented browser path | A 4-million-pixel budget and 8,192-pixel dimension safeguard replace the 2,000-pixel long-edge cap. A 1,200×6,000 image becomes 894×4,472 instead of 400×2,000; the 5 MiB JPEG encoding loop and EXIF removal remain. Chromium checks cover tall/square/noisy/thin images, orientation and EXIF removal; known text/prices survive a Tesseract read, and native upload/read/delete passed. Physical-camera/HEIC testing remains open. |
| R-03 · Suppressed browser confirmation | Implemented | All seven native confirmations are replaced with in-page sheets for deletion, manual FX and changed-payment review. Modal focus defaults to Cancel; Escape/cancellation, trip/account changes and unmount release the pending decision, and PWA reload waits. Eight native sandboxed-iframe checks passed without `allow-modals`, with a false-returning native-confirm stub and zero native calls. |
| R-04 · Focus refresh race | Implemented | A request sequence ignores superseded refreshes; ledger application rejects revisions older than the latest applied snapshot. Successful saves invalidate pending refreshes, and background refresh no longer clears visible errors. Three delayed-response browser checks passed: held GET cannot overwrite a newer save, older GET cannot overwrite newer GET, and background refresh preserves visible errors/local form state. |
| R-05 · History and erasure | Open design decision | Activity triggers still forbid UPDATE/DELETE and snapshots can retain actor names and member emails. Account deletion is not implemented. The [runbook](../operations.md#history-privacy-and-retention-design) describes the decisions and controlled migration/redaction design needed before promising erasure; no redaction path or retention policy is agreed or implemented. |
| R-06 · Frame ancestor compatibility | Hosted verification pending | Current policy allows `'self'`, `https://chatgpt.com`, `https://*.chatgpt.com`, `https://chatgpt-team.site` and `https://*.chatgpt-team.site`. The known `https://triptab-holidays.dessimat0r.chatgpt.site` is the child app, not evidence of a parent-frame origin. No actual hosted preview/embed ancestor chain was available; the allowlist is unchanged. Verify the approved build in Sites preview and ChatGPT embedding before release. |
| R-07 · Notification wording | Implemented | Generic title remains “TripTab activity”. Committed-change bodies use readable summaries such as “Bob updated an expense.” or “Bob updated this holiday.” followed by “Open TripTab to review the activity.” They omit holiday/item/payment names and amounts; the deep link remains `/`. Formatter/ownership/privacy tests passed 9/9. |
| R-08 · Activity volume | Partial operational plan | Current writes log per-entity before/after snapshots and reads use indexed bounded pages. The reviewer reported 2,080 events/~2.9 MB for one large fixture; this is their observation, not a new real-D1 load result. The [runbook](../operations.md#history-privacy-and-retention-design) proposes aggregate growth monitoring and an agreed archive/redaction policy; no automated retention, compaction or production alerting is implemented. |

The CI action pins were rechecked remotely on 4 October 2026 using both `git ls-remote` and GitHub's commit API in each action's official repository:

| Action | Pinned commit | Matching tags |
|---|---|---|
| [actions/checkout](https://github.com/actions/checkout/commit/d23441a48e516b6c34aea4fa41551a30e30af803) | `d23441a48e516b6c34aea4fa41551a30e30af803` | `v6`, `v6.1.0` |
| [actions/setup-node](https://github.com/actions/setup-node/commit/249970729cb0ef3589644e2896645e5dc5ba9c38) | `249970729cb0ef3589644e2896645e5dc5ba9c38` | `v6`, `v6.5.0` |

Both commits exist in the expected repositories and match the current v6 tags; each pinned `action.yml` declares the Node 24 runtime. No workflow pin or permission change was needed. Production release must also apply `0003_rainy_blazing_skull.sql` and `0004_hot_old_lace.sql` through Sites before code requiring their activity/lifecycle columns serves traffic; local application does not establish the production migration state.

## Validation record

Integrated local validation on 4 October 2026 includes the additional PR-comment fixes. Scoped checks are identified separately; these follow-up results are not the audit's historical counts. The current build's compiled Worker/browser smoke record is pending.

| Check | Result |
|---|---|
| Clean locked installation (`npm run install:ci`) | Passed in an isolated clean directory; 687 packages installed |
| Regression suite (`npm test`) | 193/193 passed |
| TypeScript (`npx --no-install tsc --noEmit`) | Passed; 0 errors |
| ESLint (`npm run lint`) | Passed; 0 errors, 4 warnings described above |
| Production build (`npm run build`) | Passed |
| CI workflow (`actionlint`) | Passed |
| Native local HTTP checks | Earlier 22 HTTP and 4 invitation/activity checks passed; additional receipt route 13, export route 16 and MCP/push 4 checks passed. Invitation preview, stale-consent rejection and joining also passed native checks |
| Native local browser checks | Earlier 20/20 passed; 6 additional checks passed for health/ETag, referenced-image deletion, image detachment/purge, expense restoration, payment restoration and phone CSV download. Re-review passed refresh races 3/3, restoration-concurrency 3/3, invitation/account-switch 2/2, concurrent matching-payment review 3/3 and sandboxed confirmations 8/8. Mounted 320/390/768-pixel layouts in light/dark mode showed no horizontal overflow |
| Receipt preparation | Tall/square/noisy/thin image pixel/dimension/5 MiB checks, orientation/EXIF removal, known-text OCR and native R2 upload/read/delete passed |
| Historical-data UI recovery | 6 checks passed: saved invalid bank charge stays visible, explicit correction succeeds, history retains the old value, balances recover and no browser errors occur |
| Compiled Worker/browser checks | Previous builds passed 8 security/hydration checks and 6 receipt lifecycle/restoration/freshness/download checks without browser or CSP errors. The current re-review build also passed 6 critical receipt/restoration/download checks and 3 delayed-refresh checks without browser or CSP errors |
| Production deployment, gateway verification, backup/restore drill | Not performed by this code change |

Focused tests cover financial conservation, bank/FX validation, local dates, client rebasing, authentication limits, MCP boundaries, Worker headers, SQLite migrations, invitation management, receipt lifecycle, export privacy/CSV formatting and storage/route authorization. SQLite shims and browser emulation do not substitute for real-D1 load tests, physical iOS/Android/PWA camera/push checks, or a screen-reader audit.

The remaining wider work includes account verification/recovery/deletion; verified invitation binding; pending/unknown-age receipt recovery and a full retention/erasure policy; trip archive/leave/ownership workflows; granular per-trip revisions and storage scale; notification privacy; production gateway assurance, backups/restores and monitoring; currency minor-unit migration and penny rotation; and device/accessibility validation. The live reference-provider precision question in S-08 remains unverified.
