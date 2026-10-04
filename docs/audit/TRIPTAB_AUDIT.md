# TripTab — Product, Financial-Correctness, Security and Mobile Audit

Audited commit: `642e28b` (branch `main` merged into `claude/triptab-audit-ss2lgw`). Audit date: 2026-10-04.
Scope: the full repository, a clean local build, and the running Worker (local D1/R2 only). **No fixes were made. No production system was touched** (a single `curl -I` to the live site returned `403` and nothing further was attempted).

Confidence labels: **Confirmed** (reproduced by running code, or unambiguous in the code path cited) · **Likely** (code path is clear, I did not execute the exact scenario) · **Potential** (depends on something I could not observe, e.g. the production gateway).

---

## 0. The three answers

1. **Can I trust TripTab's numbers?** Yes, for arithmetic. I tried hard to break the money model (4,000 randomised multi-currency / mixed-split trips, shuffled orderings, settlement application, JSON round-trips) and every core invariant held. What you *cannot* yet trust is the **inputs and history**: any member can silently change or delete any expense or payment, and nothing records who did it. There is also one validation hole that lets a ledger total differ from the receipt total (F-10).
2. **Can several ordinary people rely on it for a whole trip?** It will not *lose or duplicate money* under concurrency (a global compare-and-swap makes that safe), but it is not yet a product people can *trust each other through*: no audit trail, no partial/custom payments, no way to leave/close a trip, no password recovery, no live refresh, and a global write lock that makes unrelated users' saves collide. **Readiness: Alpha**, suitable for a supervised private beta among friends once the "Private beta" gate in §K is met.
3. **What next?** Four foundation PRs (§J: PR-1 integrity+tests+CI, PR-2 per-trip revisions with a granular mutation API, PR-3 activity log/authorship/soft delete, PR-4 payments v2), then account lifecycle, then receipts/mobile polish.

---

## A. Executive verdict

TripTab's *money core* is unusually good for a small project: integer minor units everywhere, exact BigInt rounding, largest-remainder allocation, a single rounding point for currency conversion, a global CAS on every write, hashed sessions, an Origin check on every mutating route, and server-side authorisation that held up in every IDOR/BOLA attempt I made. It is let down by what surrounds the core: a "whole ledger in, whole ledger out" collaboration model with no history, an incomplete settle-up workflow, missing account lifecycle, and almost no operational safety net (no CI, no test script, no backups/runbook, no monitoring).

| Rating | Verdict |
|---|---|
| Prototype | ✗ — far beyond |
| **Alpha** | **✓ — current state** |
| Private beta | Reachable with the §K "Private beta" gate (small, mostly-S/M items) |
| Public beta / Production | Needs the structural PRs (per-trip revisions, activity log, account lifecycle, ops) |

---

## B. Scorecard (0–10)

| Area | Score | Rationale |
|---|---|---|
| Financial correctness | **8** | Integer cents, exact BigInt rounding and proportional allocation hold in every randomised run; docked for the same-currency `bankAmount` override (F-10), UTC/local date mixing (F-14) and deterministic first-member penny bias (F-21). |
| Settlement correctness | **6** | Suggestions always zero every balance and are deterministic, but are greedy (not minimal, F-13), unexplained, and users cannot record a partial/custom payment at all (F-02). |
| Multi-currency | **5** | One rounding point and stored per-expense rates are right; but 2-decimals hard-coded for every currency, 25 currencies (no JPY/THB/AED/…), FX provider covers 15 of them, manual rate labelled "Reference estimate", date/time bug (F-14/F-15). |
| Data integrity | **6** | D1 batch + CAS makes writes atomic and lost-update-free; but hard deletes, silent history rewrite, orphaned receipts, and whole-ledger JSON blobs with a 1.5 MB cap across *all* a user's trips (F-01/F-08/F-20). |
| Security | **5** | Solid fundamentals (PBKDF2 + salts, hashed opaque sessions, Origin checks, tight push-endpoint allow-list, authz on every route tested); gaps: header-trust boundary unverified (F-05), unverified emails, no recovery/deletion, no security headers, lockout DoS (F-04/F-07/F-16/F-18). |
| Collaboration / concurrency | **5** | Strict serialisability via one global revision, but that revision is *global to all users*, there is no per-expense conflict handling, no live refresh and no attribution (F-01/F-03/F-11/F-29). |
| Mobile UX | **6** | Genuinely mobile-first (sticky action bar, bottom tabs, 320–430 px no overflow, safe-area meta); weak on speed-of-entry, destructive-action protection, touch target sizes (36–40 px), photo handling (5 MB hard limit, no resize). |
| Product completeness | **3** | Missing for a "settle-up" product: custom/partial payments, history, leave/close/archive/delete trip, member removal/rename, balance drill-down, account recovery/deletion/export. |
| PWA / reliability | **5** | Correct security-first choice (no private data cached); SW is minimal, no update prompt, no stale-data refresh; offline save fails loudly and keeps the form (good). |
| Accessibility | **6** | Real effort (focus-trap dialogs, tab ARIA, text + colour for owes/gets, labelled inputs); **not verified** with a screen reader; small targets; no reduced-motion evidence. |
| Testing | **5** | 64 passing tests, good rounding/validation coverage; no `test` script, no CI, no property tests, **zero tests of `store.ts` `writeLedger`, invite, receipt, ledger, push or notification routes** (MCP tests mock the store). |
| Operational readiness | **2** | Source and production deploy lifecycles are separate; no CI, backup/restore, rollback, monitoring, health check or invariant checker. |
| Maintainability | **5** | Strict TS, Zod schemas, good comments; but a 2,140-line `page.tsx` holds nearly all UI state and the whole-ledger write path, and tests rely on an undeclared `tsx`. |

---

## C. Architecture summary (verified from code, not README)

Stack confirmed: React 19 + TypeScript, **Vinext** (Next-style App Router on Vite) → Cloudflare Worker; **D1** (SQLite) via hand-written SQL (Drizzle is used only to *generate* migrations; the code never calls Drizzle); **R2** for receipt images. `package.json` has no `test` script; tests run via `npx tsx --test tests/*.test.ts` (`tsx` is only a transitive dependency of `drizzle-kit`).

```
Browser (single client component app/page.tsx: ~2,100 lines, all state)
  │  GET  /api/ledger  → {data:{trips:[ALL trips I can see]}, revision:<GLOBAL int>}
  │  POST /api/ledger  ← {data:{trips:[…]}, revision}      (whole ledger, every save)
  │  POST /api/receipt?tripId  (raw image)   GET /api/receipt?id
  │  /api/invite  /api/auth  /api/profile  /api/push  /api/notifications  /api/fx
  ▼
Worker (vinext fetch handler)           ChatGPT/Codex ──► POST /mcp  (JSON-RPC, tools)
  ├─ identity: tt_session cookie (hash→auth_sessions)  OR  oai-authenticated-user-* headers
  ├─ lib/store.ts  readLedger / writeLedger (validate → diff → D1 batch with CAS)
  ├─ lib/model.ts  Zod schemas + ALL money maths (pure, shared with browser)
  └─ lib/notifications.ts  inbox rows + payload-less Web Push (VAPID ES256)
        │
        ├─ D1: profiles, auth_credentials, auth_sessions, auth_links, auth_rate_limits,
        │       sync_state(id=1,revision,last_write)  ◄── ONE row = the global revision
        │       trips(id, owner, data JSON)          ◄── whole trip (members, expenses,
        │       memberships(trip,user,member)             payments, drafts) as ONE JSON blob
        │       invites, receipts(id,owner,trip), notifications, push_subscriptions
        │       ledgers  ◄── legacy table, unused by code, never migrated/dropped
        └─ R2 RECEIPTS: key = encodeURIComponent(uploaderId)/uuid
Service worker: caches only offline.html + icons; navigations network-only.
```

**Sources of truth**

| Concept | Authoritative source |
|---|---|
| Expense, payments, drafts, member list | `trips.data` JSON (one blob per trip) |
| Who owns / belongs to a trip, which account ↔ which traveller | `memberships` table + `trips.owner`; `member.userId/email` inside the JSON is a **cache that is overwritten from `memberships` on every read and write** (`readLedger`, `writeLedger`) |
| Revision / concurrency token | `sync_state` row id=1 — **one counter for the entire database** |
| Balances / settlement suggestions | **Never stored.** Recomputed on every render from expenses + payments by `balances()`/`settlements()` in `lib/model.ts` |
| Receipt existence | `receipts` row **and** R2 object **and** `receiptId` in JSON (three places, no FK between them, no GC) |
| Money amounts | Integer hundredths (`cents`, max 100,000,000 per field) |

**Structured-vs-serialised analysis.** Divergence between `memberships` and the JSON `userId` is well-guarded: reads overlay memberships onto JSON, writes overwrite client-supplied `userId`, and invite acceptance updates `invites`, `memberships`, `trips.data` (via `json_set`) and `sync_state` in one D1 batch guarded by a per-batch marker. I could not produce divergence. The real risks of the JSON-blob model are different: (a) every save re-sends and re-validates *all* of a user's trips; (b) the 1.5 MB ledger cap is shared across all of a user's trips; (c) there is no per-entity identity for history/audit; (d) receipts are referenced from three places with no reference counting, so orphans are unbounded (F-08). Balances cannot go "stale in the database" because they are never stored — a real strength.

---

## D. Financial invariants

| # | Invariant | Status | Evidence |
|---|---|---|---|
| I1 | Σ participant shares == expense total (converted) | **Apparently satisfied; strongly evidenced** | `allocate()` largest-remainder over integer weights (BigInt path); 4,000 random trips (2–9 members, mixed GBP/EUR/PLN/HUF/ISK, item/percent/receipt-% splits, tax/tip/discount, bank charge or manual rate): 0 violations. Unit tests cover specific cases; no property test exists in the repo. |
| I2 | Σ member net balances == 0 | **Satisfied** | Follows by construction (I1 + payments are ±amount); 0 violations in randomised run. |
| I3 | Final balances independent of expense/payment order | **Satisfied** | Integer sums; shuffled-order runs identical (0/4,000 differences). |
| I4 | Applying the suggested settlements zeroes every balance | **Satisfied** | 0/4,000 failures. |
| I5 | Suggestions deterministic | **Satisfied** w.r.t. expense order; **depend on trip member order** (greedy over member list). | `settlements()` |
| I6 | Suggestions minimal / simple | **Not guaranteed** | Counter-example (F-13): balances `[-3,-7,+7,+3]` → 3 transfers, optimum 2. Random generic data matched the optimum in 3,999 cases (zero-sum sub-groups are rare there), so the weakness shows with "couples/families" structure. |
| I7 | Ledger total of an expense == receipt total when same currency | **Violated** | Same-currency expense with `bankAmount` is accepted by `validateLedger` and **overrides the total** (receipt £50.00 → ledger £1.00, balances ±£0.50). F-10. |
| I8 | Historical value does not move when today's rate changes | **Satisfied** | The rate is stored on the expense; nothing re-fetches. (Editing an expense's date/time/tz clears `fx` in the UI; the user must re-lookup.) |
| I9 | Single rounding point for FX | **Satisfied** | Total converted once (`convertAmount`, exact decimal expansion of the stored double, half-up), then allocated proportionally to the original-currency shares. Receipt-wide % splits are converted directly. |
| I10 | JSON round-trip preserves financial state | **Satisfied** | Random trip round-trip equal; `fx.rate` stored as double (e.g. 0.8567) and re-parsed exactly via its shortest decimal string. |
| I11 | Retried / duplicate mutations do not duplicate money | **Satisfied at transport level; not semantically** | Retrying the *same* POST after commit returns 409 (stale revision) — no duplicate. A *new* payment with a fresh id (what happens if the user taps again after a refresh) is accepted. |
| I12 | Non-members cannot read or mutate another trip | **Satisfied in every path tested** (§F matrix) — *subject to F-05 (gateway trust)*. |
| I13 | Trip settlement currency immutable once saved | **Satisfied** server-side (`writeLedger`). |
| I14 | Adding a member does not alter past expenses | **Satisfied** — items carry explicit member lists. |
| I15 | Number shown == number in ledger | **Mostly** | Display uses `Intl` with 2 fraction digits for all currencies; the hidden `bankAmount` case (F-10) is the exception. |

**Rounding recipient (asked explicitly).** Remainder pennies go to the *first* person in the item's `members` array (ties broken by input order). That array is the order the user tapped chips, so *re-selecting people can move the penny*; untouched re-saves do not. £10.00 ÷ 3 → `[334,333,333]`; with order `[m2,m0,m1]` → `[333,333,334]` (Confirmed). Because default order = trip member order, **member #1 (the trip creator) systematically absorbs the extra penny**: over 500 six-way items the cumulative bias is **+£2.00 for the first member vs −£2.15 for the last** (Confirmed, simulation). Small, deterministic, undisclosed (F-21). The UI *does* show every person's resulting share in the editor ("Each person's share"), which is good.

---

## E. User-journey audit

| Journey | Assessment |
|---|---|
| **Sign-up** | Email + password (min 12 chars), clean and quick. No email verification, no password reset, no change-password UI for password accounts (the form only renders when `!hasPassword`). Forget the password = lose the account permanently (F-04). Registering and failed logins share a per-IP bucket of 8/15 min (F-16). |
| **Create / join trip** | Create: comma-separated names, creator first, settle currency. Good. Invite: owner-only, one-use 7-day link, no revoke, no pending-invite list, email binding is not meaningful with unverified emails (F-07). New joiner claims an *existing placeholder identity* (and all its history). |
| **Add expense** | Powerful (items, %, receipt-wide %, tax/tip/discount, FX) but not "one-handed in a restaurant": needs expense name **and** item name **and** amount; the **payer defaults to the first traveller (the organiser), not the person using the phone** (`payer: trip.members[0].id`, `page.tsx:281`, F-25) — a silent mis-attribution for every non-organiser. Date defaults to the **UTC** date while time/timezone are local (F-14). |
| **Receipt workflow** | Photo upload works; OCR is delegated to the user's own ChatGPT/Codex via a copy-pasted prompt + MCP, results arrive as a draft that a human must open and Save (the "AI is a proposal" principle holds — Confirmed: no tool path posts an expense). Practical friction: 5 MB hard limit with **no client-side resize** (modern phone photos often exceed it), EXIF retained, no way to delete a receipt (F-08/F-09). |
| **Understand balances** | Clear "Gets back / Owes / Settled" (text + colour, not colour-only) and "Still to settle". **No drill-down** from "You owe Sarah £47.31" to the expenses behind it, expense rows do not show *your* share, and the suggestion list is not explained as a simplification (F-13). |
| **Edit a mistake** | Tap expense → edit → Save; Delete is **one tap with no confirmation and no undo**, and leaves no trace (F-12). |
| **Record payment** | Only by tapping "Record paid" on a suggested transfer (one tap, no confirm). **No custom amount, no partial, no reverse/other pair, no note, no edit** — only "Undo" (delete). (F-02, Confirmed in UI: the Balances panel contains zero inputs.) |
| **Final settle-up** | Works arithmetically: recording all suggestions leaves everyone square. But a payer who actually transferred £60 of £100 cannot record it. Edited/deleted history after settlement just flows into the recomputed balances (see §G scenario "expense edited/deleted after settlement") — mathematically correct, not explained. |
| **Close / archive** | **Does not exist.** No close, archive, delete, leave, rename/remove member, edit dates/currency (F-23). |

---

## F. Findings register

Size: S ≤ 1 day · M ≈ 2–4 days · L ≈ 1–2 weeks · XL > 2 weeks. "Evidence" cites files in this repo.

### P1 — should block wider release

**F-01 · P1 · Confirmed · Collaboration/integrity — No authorship, history or audit trail; any member can silently rewrite any financial record**
- Evidence: `lib/model.ts` `expenseSchema`/payments schema have no `createdBy/updatedBy/at`; `lib/store.ts:115-190` `writeLedger` authorises only "is member of trip" then replaces the whole trip JSON; no history table in `db/schema.ts`; the only signal is a generic "Someone updated your shared holiday" notification (`store.ts:184`).
- Reproduction (HTTP, local): member Bob (non-owner) POSTed a ledger that (a) added an expense paid by Alice, (b) renamed Alice, (c) recorded a payment Alice→Carol — all accepted (`200`). The organiser (as Alice) then rewrote history by removing an unlinked traveller *and* stripping every reference in the same save; `200`, balances silently changed.
- Impact: a trust-destroying failure mode for a shared ledger even when arithmetic is perfect; no way to answer "why did my balance change?".
- Root cause: whole-document replace model; no per-entity identity or event log.
- Fix: append-only `trip_events` (actor, time, entity, before/after) written in the same D1 batch; `createdBy/updatedBy/updatedAt` on expenses and payments; soft-delete tombstones; a History view; derive notifications from events (see PR-3).
- Tests: every mutation emits exactly one event; deleting then restoring; actor spoofing impossible; reconstruct state by replaying events.
- Size: L.

**F-02 · P1 · Confirmed · Product — Payments can only be recorded as one-tap suggested transfers**
- Evidence: `app/page.tsx:1037-1045` is the only place a payment is created (`{ id: uid(), ...d, date: today() }`); UI run: Balances panel has no inputs. No edit; "Undo recorded payment" (`:1077-1090`) deletes immediately without confirmation. Server accepts any payment between any two members for any amount, including 1,000,000 against a £5 debt and exact duplicates with fresh ids (HTTP-confirmed).
- Impact: real settlements are messy (partial, different payee, cash, different day). Users will either not record them (balances stay wrong) or work around it with fake expenses.
- Fix: payment form (from, to, amount, date, optional note), edit with history, confirm-before-save sheet, optional recipient acknowledgement, over-payment warning, idempotency key per submit.
- Tests: partial, multiple partial, reverse-direction, over-payment, duplicate-tap, edit/delete after the fact (balances recompute exactly).
- Size: M.

**F-03 · P1 (for wider use; P2 for a handful of users) · Confirmed · Concurrency — one global revision for the whole database; whole-ledger upload on every save**
- Evidence: `store.ts:171-173` `UPDATE sync_state … WHERE id = 1 AND revision = ?`; `acceptInvite` bumps the same counter (`invite/route.ts:157-160`).
- Reproduction: User C saved an unrelated trip; User A's save (with A's still-current view of A's own trip) then returned **409 "Your ledger changed in another tab or in ChatGPT"**. Two concurrent saves on the same trip: exactly one `200`, one `409` (correct).
- Why this is *safe* but still a defect: CAS makes lost updates and duplicate writes impossible (a retried POST after commit gets 409 — Confirmed), but with N active users every save races every other user's save. A tiny edit with a large ledger present took ~0.5 s and re-uploaded ~1.4 MB.
- Fix: per-trip `revision` column (If-Match semantics) and granular endpoints (`POST /trips/:id/expenses`, `…/payments`) with client-supplied idempotency keys; keep the atomic D1 batch. (PR-2.)
- Tests: unrelated-trip writes do not conflict; same-trip conflicting writes do; idempotency-key replay returns the original result.
- Size: L–XL.

**F-04 · P1 · Confirmed · Security/Privacy — No account recovery, verification, deletion or export**
- Evidence: `lib/auth.ts` has actions `register|login|set_password|link_chatgpt|unlink_chatgpt|chatgpt_login|logout` only; README states reset/verification are not implemented; `components/account-panel.tsx:137` renders the password form only when `!profile.hasPassword`; `grep` finds no account/trip/receipt DELETE paths.
- Impact: a forgotten password permanently strands the user (and the organiser role); no way to honour erasure/export requests; unverified emails are displayed to other members.
- Fix: email-based reset + verification (needs a mail provider), change-password UI, session list/revoke-all, account deletion with a defined policy for owned trips (transfer or archive) and receipt purge, data export (JSON/CSV). (PR-7.)
- Size: L.

**F-05 · P1 until verified · Potential · Security — all identity rests on `oai-authenticated-user-*` headers supplied by the hosting gateway**
- Evidence: `lib/auth.ts:80-91` `trustedChatGPTIdentity`; `resolveIdentity` falls back to these headers for *every* route (and `/mcp` accepts *only* them). Locally, `ledger` and `/mcp` accepted forged `oai-authenticated-user-id: forged-user-1` and returned a (new, empty) account — the Worker itself performs no verification (the vendored dev plugin strips the headers only in dev mock mode, `build/sites-vite-plugin.ts:54-60`).
- Impact if the production edge does not strip client-supplied copies of these headers, or the Worker is reachable by any other route: full impersonation of any account whose id is known, including legacy accounts whose profile id *is* the provider id.
- Not confirmed: I did not (and should not without the owner's authorisation) test the production gateway. **Action:** the owner must confirm with Sites that the headers are stripped on ingress and that no alternate hostname/route bypasses the gateway; add a defence-in-depth shared secret/signature header if the platform supports one.
- Size: S (verify) / M (if a signature check must be added).

**F-06 · P1 · Confirmed · Operations — no safety net around a production financial ledger**
- Evidence: no `.github/` (no CI), no `test` script, no README test instructions (tests run only via `npx tsx --test …`, `tsx` undeclared); migrations are three non-idempotent SQL files applied by hand ("do not replay migrations already applied", README) and copied to `dist/.openai/drizzle`; production deploy is via the separate ChatGPT Sites lifecycle (README "Publishing") so GitHub `main` can silently drift from production; no backup/restore/rollback documentation, no structured logging (only `console.error/warn`), no health endpoint, no invariant check, no error tracking.
- Answer to "if a release corrupts balances tomorrow?": the operator would learn from a user complaint; there is no detection, no kill-switch and no documented restore (D1 Time Travel / R2 recovery are never mentioned). Treat as a production-readiness blocker.
- Fix: CI (install → `tsc` → lint → tests → build), declared `tsx` + `npm test`, migration tracking table and a "migrate → smoke test → promote" runbook, nightly invariant job (Σ balances = 0 per trip, receipts↔R2 reconciliation, orphan scan), backup + restore drill, drift check between GitHub and Sites, structured logs with request ids, `/healthz`. (PR-2 / PR-13.)
- Size: M–L.

### P2 — meaningful weaknesses

**F-07 · P2 · Confirmed · Invitations**
- (a) Email binding is cosmetic: an invite bound to `victim@…` was accepted by a different person who simply *registered* with that address (no verification) — HTTP-confirmed. (b) No revoke endpoint (`mode:'revoke'` → "Choose whether to create or accept") and no pending-invite list; multiple live links per traveller can coexist (Confirmed). (c) Whoever redeems the link *becomes the existing placeholder traveller*, inheriting its entire financial history; the joiner's display name is also written to their profile. (d) Invite preview (`GET /api/invite`) reveals trip name + traveller name to any signed-in token holder (by design).
- Fix: revoke/regenerate (invalidate previous), pending-invite list in Travellers, require a verified email for email-bound invites, show "you will be linked to <name> who already has £x of expenses" confirmation. Size: S–M.

**F-08 · P2 · Confirmed · Receipts — no lifecycle; orphans and unbounded storage**
- Evidence: `app/api/receipt/route.ts` has only POST/GET; deleting an expense/draft never touches `receipts` or R2 (`page.tsx:2078-2084`, `:1157`); upload (R2 put → D1 insert) and the later ledger save are separate requests, so a failed/conflicted save leaves an orphan (`page.tsx:478-501`). HTTP: 15/15 consecutive uploads accepted (no per-user or per-trip quota).
- Impact: deleted receipts (which may carry names, card fragments, EXIF GPS) stay retrievable by any trip member forever; storage abuse by any member; retention/erasure impossible.
- Fix: reference-counted deletion on expense/draft delete, `DELETE /api/receipt`, orphan sweeper (receipts not referenced after N hours), per-trip/user quota. Size: M.

**F-09 · P2 · Confirmed (code) · Mobile receipt capture — hard 5 MB limit, no resize, EXIF retained**
- Evidence: `page.tsx:377`/`receipt-capture.tsx` send the raw `File`; `receipt/route.ts:4` 5 MB; bytes stored verbatim. Impact: a full-resolution Android photo is rejected with a text error at the table; GPS EXIF is stored and served to all members.
- Fix: canvas downscale (≈2000 px long edge, JPEG q≈0.8), strip EXIF, normalise orientation; keep server validation. Size: S–M. (I could not test real iOS/Android cameras.)

**F-10 · P2 (P1 if AI/MCP is opened to the public) · Confirmed (model/API) · Financial — `bankAmount` silently overrides the total even when no conversion is involved**
- Evidence: `lib/model.ts:301-309` `expenseTotal` returns `bankAmount` first, before checking `currency === baseCurrency`; `validateLedger` does not reject it; MCP draft schema allows `bankAmount` for any currency (`app/mcp/route.ts` `bankAmount: money`). Run: `GBP` expense, receipt total 5000, `bankAmount: 100` → accepted; ledger total 100; balances `[+50,-50]`.
- UI path: an AI draft carrying `bankAmount` opens in the editor with the bank-charge panel **hidden** (shown only when `currency !== trip.currency`, `page.tsx:1893`), so the Original-total line says £50.00 while the per-person preview silently splits £1.00. Also `bankAmount: 0` is accepted by the model (UI blocks it; MCP `money` allows 0).
- Fix: in `validateLedger`/`expenseSchema`, reject `bankAmount` when currency equals trip currency and require `bankAmount > 0` and total > 0; surface it in the editor if present. Tests: add to the invariant suite. Size: S.

**F-11 · P2 · Likely (code-traced) · Concurrency UX — stale editor can overwrite or resurrect another member's change**
- Evidence: after a 409 the editor stays open (good) and "Refresh ledger" replaces `ledger`; `submitExpense` then computes `exists = trip.expenses.some(x => x.id === expense.id)` against the *refreshed* trip and either overwrites the other member's edit wholesale or, if the other member deleted it, **re-inserts it as new** (`page.tsx:558-576`). Only receipt-draft edits get a "was removed" check (`editing.expenseId`).
- Fix: carry the expense's last-seen revision/etag into the editor; on mismatch show a diff and require an explicit choice. Size: M (natural with PR-2/PR-3).

**F-12 · P2 · Confirmed · UX — destructive actions have no confirmation or undo**
- UI run: Delete expense, Undo payment, Remove draft, and Record paid all act on one tap, no dialog, no toast-undo; the Delete button sits directly beside Save in the sticky bar. With F-01 the deletion is also untraceable. Fix: confirm sheet for delete, "Undo" toast, soft-delete. Size: S.

**F-13 · P2 · Confirmed · Settlement UX/algorithm**
- `settlements()` (`model.ts:337-351`) pairs debtors and creditors in member order. Counter-example: members `[d1,d2,c1,c2]`, balances `[-3,-7,+7,+3]` → `d1→c1 3, d2→c1 4, d2→c2 3` (3 transfers); the optimum is `d1→c2 3, d2→c1 7` (2). The UI calls it "Suggested transfers" but never says it is a simplification that does not preserve who-owes-whom provenance. There is **no way to see why** a balance is what it is (no per-member statement; expense rows don't show your share).
- Fix: exact minimal-transfer search (subset DP for ≤ ~14 non-zero balances, greedy beyond), deterministic tie-break independent of member order, an explanatory line, and a per-person statement ("your share of each expense, payments made/received"). Size: M.

**F-14 · P2 · Confirmed (server behaviour run; client defaults code-traced) · Date/time handling**
- `today()` is `new Date().toISOString().slice(0,10)` — a **UTC** date (`page.tsx:48`) paired with the **local** time and device timezone (`:277-279`); payments are dated the same way (`:1042`). Between local midnight and the UTC offset the expense lands on the wrong day. For users west of UTC in the evening the combination is a future timestamp and `/api/fx` rejects it: with the server clock at 11:24 UTC, `date=2026-10-04 time=23:25 timezone=Etc/GMT+12` returned *"Reference rates cannot be requested for a future transaction"* (`app/api/fx/route.ts:62`). The timezone `<select>` lists only European zones + UTC + the device zone.
- Fix: derive date from local components; offer the full IANA list; unit-test dates around midnight and DST. Size: S.

**F-15 · P2 · Confirmed · Multi-currency scope/precision**
- All currencies hard-code 2 minor-unit digits (`model.ts:35` comment; `money()` forces 2 fraction digits). ISK/HUF/UAH etc. then settle in fractional units that cannot be paid; JPY, THB, AED, MXN, ZAR, etc. are not offered at all (25 currencies, Europe-centric). `/api/fx` supports only 15 of the 25; the rest require manual rate or bank charge (the UI says so). A manual rate is labelled **"Reference estimate"** in the expense list (`page.tsx:984-988`, Confirmed in UI) — mislabelled provenance. Manual-rate input swallows a leading "0" while typing `0.85` (displays `.85`, value stays correct — cosmetic, Confirmed).
- Fix: ISO-4217 exponent table, broaden currency list, label manual vs reference vs bank, settle-currency rounding rule. Size: M.

**F-16 · P2 · Confirmed · Auth abuse controls**
- `consumeAuthRateLimit` (`auth.ts:183-201`) counts **registrations and failed logins** in one per-IP bucket (8 per 15 min; behind a hotel/office/CGNAT address this blocks friends signing up from the same Wi-Fi — I exhausted it myself while testing) and a per-email bucket that any third party can fill: after 10 wrong-password attempts against `b@…` from another client, the real owner's correct login returned **429** (Confirmed) — a trivial lockout DoS. Registration also confirms whether an email exists (409).
- Fix: separate buckets (register vs login), per-account progressive delay + per-IP caps with generous limits, optional Turnstile on repeated failures, uniform responses. Size: S–M.

**F-17 · P2 · Confirmed · Notifications**
- Every successful ledger save by anyone creates an inbox row for everyone else with the fixed text "*<Trip> updated — Someone updated your shared holiday*" (`store.ts:183-186`) — including draft edits and AI draft saves; no actor, no event type, trip name appears on lock screens; push throttled only to one per 30 s per user. Push subscriptions are keyed by browser endpoint and stay bound to the *previous* account after sign-out on a shared device (`notifications.ts:50-51`), and the service worker displays whatever `/api/notifications` returns for the *current* session. Positives: payload-less push, strict endpoint allow-list, `https` only, `redirect: 'error'`, 5-subscription cap, dead-endpoint cleanup.
- Worth notifying: payment recorded to/from you, expense that changes your balance, invite accepted, trip closed. Not: draft edits. Fix with PR-3's events. Size: S–M.

**F-18 · P2 · Confirmed locally / Potential in production · Missing HTTP security headers**
- Local response for `/` has no `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `Strict-Transport-Security`, `Referrer-Policy` or `Permissions-Policy`; only API/receipt routes set `no-store` and `nosniff`. For a financial UI, clickjacking protection is the main gap. The Sites edge may add some; verify. Fix: add headers in `build/sites-worker.ts`. Size: S.

**F-19 · P2 · Potential · MCP / AI surface**
- Verified good: MCP accepts only the provider identity (never cookies); every tool operates on the caller's trips via `readLedger(user)`; receipt images pass `receiptAccess`; tools write **drafts only** and cannot create `expenseId` links (tests + code); retries are idempotent (`create_holiday` derives the trip id from `user:request_id`; replies by `responseId`).
- Concerns: (a) `get_trip_ledger` returns **every trip the user belongs to** plus all members' names/emails, so one trip's untrusted text (trip/traveller/item names, receipt chat) is in the same model context as every other trip — a crafted string can try to induce the assistant to copy another trip's data into a draft or `reply_to_receipt_chat` (≤ 4,000 chars) visible to *that* trip's members (cross-trip leakage via the user's own assistant). (b) any member's assistant can edit shared drafts. (c) tool descriptions say "treat receipt text as data" but nothing structural enforces it. (d) no MCP rate limit or audit record of AI writes. The human-in-the-loop save step is the real protection and it works.
- Fix: `get_trip_ledger(trip_id)` (scope per trip, drop emails), tag AI-originated drafts with provenance and show it in the review UI, log AI writes in the activity log, caps. Size: S–M. (Prompt-injection effectiveness against a specific model was not tested.)

**F-20 · P2 · Confirmed · Scale limits of the JSON-blob model**
- 1.5 MB cap applies to the *whole ledger the client sends* (all the user's trips together); a 20-member / 1,000-expense / 2-items-each trip is **1.46 MB** — one such trip leaves ~40 KB for everything else, after which *every save for that user fails* "Your ledger is too large". `ledgerSchema` allows 50 trips; a member of >50 trips can no longer save. Each expense can carry up to 100 chat messages × 4,000 chars (`conversation`), so chat-heavy receipts bloat the blob. Validation failures surface as the generic "*Unable to complete this request. Check your entries and try again.*" (e.g., removing a linked member) rather than the specific rule (`failure()` in `store.ts:192-201`).
- Measured (local Miniflare, not production D1): save ≈ 0.25–0.5 s, read 52 ms for the 1.46 MB ledger. Fine now; becomes uncomfortable beyond ~1,000 expenses/trip or ~50 trips. Fix: per-trip rows/entities (PR-2). Size: part of PR-2.

**F-22 · P2 · Confirmed (HTTP) · Unlinked-member removal can rewrite history** (see F-01): `validateLedger` forbids removing a member that is still referenced, but a client can remove references in the same payload. A linked traveller cannot be removed (blocked server-side; Confirmed). There is no UI for removing members at all.

### P3 — polish / hygiene

- **F-21 · P3 · Confirmed — first-member penny bias** (see §D): ±£2 over 500 items; remainder recipient depends on chip click order. Fix: deterministic rotation (e.g., hash of item id) and document.
- **F-23 · P2 · Confirmed — no trip lifecycle:** no close/archive/delete trip, leave trip, remove/rename traveller, edit dates/currency/ownership transfer; account-linked travellers can never leave (server-enforced). Historical records stay intelligible only because nothing can ever be removed.
- **F-24 · P3 · Confirmed —** duplicate traveller names are accepted (two "Uma").
- **F-25 · P2 · Confirmed (code) — default payer is `trip.members[0]`**, not the current user (`page.tsx:281`, also `:498` for uploaded receipts). Every non-organiser must remember to change "Paid by".
- **F-26 · P3 · Confirmed — password hashing:** PBKDF2-SHA256 at 100,000 iterations (the WebCrypto ceiling on Workers; OWASP currently recommends far more for PBKDF2) and `verifyPassword` rejects any digest whose `iterations` differs from the constant, so the work factor cannot be raised without a re-hash path. Expired `auth_sessions`, used `invites` and `auth_rate_limits` rows are never purged.
- **F-27 · P3 · Likely — accessibility gaps (unverified with a screen reader):** header controls 36–40 px (< 44 px), receipt thumbnails `alt="Receipt thumbnail"`, no reduced-motion evidence (`.spin` icons), no `aria-live` for save results outside the editor, contrast not measured. Positives: modal focus trap & restoration, tablist keyboard handling, labelled inputs, `role="alert"` errors, status text accompanying colour.
- **F-28 · P3 · Confirmed — PWA:** SW caches only the offline page and icons (right call for private data), `triptab-public-v1` is manually versioned, no "update available" UI (a `SKIP_WAITING` handler exists but nothing sends it), offline launch shows a generic page with no read-only last-known balances. Offline *saves* fail loudly (`Failed to fetch`, form retained, retry succeeded) — confirmed there is no "believed saved while offline" path. My Playwright offline-navigation check was inconclusive (Playwright's offline mode does not reliably affect service-worker fetches); needs a real device.
- **F-29 · P2 · Confirmed (code) — no live refresh:** the ledger loads on mount and on manual "Refresh"/errors only (`page.tsx:164-191`). A user can read "Vic pays Uma £2.83" off a stale screen and **move real money outside the app**; only the in-app "Record paid" is protected by the CAS. Fix: refetch on `visibilitychange`/focus and before showing settlement amounts, plus a cheap `HEAD`/ETag poll; show "last updated".
- **F-30 · P3 — edge cases in `shares()`/`expenseShares()`:** when every item amount is 0, tax/tip is spread across *all trip members* rather than the selected ones; a zero-total expense with a positive `bankAmount` is split among all members (UI prevents both).
- **F-31 · P3 — dead schema:** `ledgers` table is unused with no migration path or archive note; no FK from `memberships.user_id`/`receipts.owner` to `profiles`.
- **F-32 · P3 — lint:** 0 errors, 3 warnings (`<img>`, `location.assign`); `tsc` clean.

---

## G. Ugly-scenario matrix (observed outcomes)

"HTTP" = run against the local Worker; "model" = run against `lib/model.ts`; "code" = traced, not executed.

| Scenario | Outcome |
|---|---|
| £10 split 3 ways | `[334,333,333]`, Σ=1000 (model, UI preview £3.34/£3.33/£3.33) |
| Several indivisible cases | 1,000 amount × weight combos + 4,000 random trips: Σ always exact |
| One participant pays every expense | Balances Σ0; settlements zero (model) |
| Three-person circular spending | Nets to the minimal transfers; zero after application (model) |
| Expense shared by some members | Others owe 0; later-added members unaffected (model/tests) |
| Itemised receipt, different participant combos | Exact; tax/tip/discount allocated proportionally to item sums (model) |
| Percentage split needing rounding | 33.33/33.33/33.34 conserves every cent for amounts 0–999 (tests) |
| Foreign-currency expense | Single rounding of total, shares proportional; reference rate stored, never re-fetched (model/UI) |
| Manual rate correction | Works; shown as "Reference estimate" (F-15) |
| Payer/member renamed | Allowed for *any* member by any member; ids stay stable so balances unaffected, but identity can be spoofed (HTTP) |
| Expense edited after partial settlement | Partial settlement impossible (F-02); after full settlement, edits flow into recomputed balances: A paid £100 → edit makes debt £120 → "A pays B £20" appears. Mathematically correct; no explanation shown (code/model) |
| Expense deleted after full settlement | Same: balances flip, a reverse suggestion can appear; no trace of the deletion (F-01) |
| Participant leaves owing money | Impossible — no leave (F-23) |
| Participant removed while owed money | No UI; server rejects removing a linked traveller; unlinked traveller removable only if references are also stripped in the same payload (HTTP: history rewritten silently) |
| Expired invitation | Rejected `410` (code; tests do not cover) |
| Reused invitation | `409` "already used" for another account; same account idempotent (HTTP) |
| Two users editing simultaneously | Exactly one `200`, the other `409` (HTTP); the loser's editor keeps its form (UI) |
| Double-tap / double-click Submit | Buttons are disabled while `saving`; even if two requests raced, the stale one would `409` (HTTP) |
| Network timeout after server commit | Retry of identical request → `409`; after refresh the payment is visible; a *fresh* payment with a new id would be accepted (duplicate money possible only by user action) (HTTP) |
| Stale tab writing old state | `409`; stale *editor* can overwrite/resurrect after refresh (F-11, code) |
| Receipt upload succeeds, financial save fails | Orphan R2 object + `receipts` row, retained forever (F-08, code) |
| Financial save succeeds, receipt upload fails | Not possible in the normal flow (upload first); if the upload fails no draft is created |
| Account deletion while in active trips | No account deletion exists (F-04) |
| Wrong/reused/other-trip receipt id | Another trip's participant: `404`; attaching it to own trip: `400 "does not belong"` (HTTP) |
| Cross-origin / no-Origin POST | `400` (HTTP) |
| Oversize receipt / SVG upload | `413` / `400` (HTTP) |
| 20 members / 1,000 expenses | 1.46 MB; save 0.25–0.5 s; within 3% of the hard cap (F-20) |

### Authorization matrix (verified server-side; "any member" = linked traveller or owner)

| Resource | Read | Create | Update | Delete |
|---|---|---|---|---|
| Trip | owner + members | any signed-in user | **any member** (name, members, expenses, payments, drafts) | nobody (omitted trips are retained) |
| Trip currency | — | at creation | **nobody** (server-enforced) | — |
| Expense / payment | any member | any member (any payer / any pair) | any member | any member (hard delete) |
| Traveller (member) | any member | any member | any member (rename) | unlinked: any member if unreferenced; linked: nobody |
| Invite | token holder (preview) | **owner only** | — | none (no revoke) |
| Receipt image | any member (404 otherwise) | any member | — | nobody |
| Notification / push sub | self only | system / self | — | self (unsubscribe) |
| Profile | self | self | self | none |
| MCP tools | caller's own trips only | drafts / holiday | drafts (any member's draft) | none |

All "other user / other trip" attempts I made (read ledger, write trip, upload to trip, read/attach receipt, create invite as non-owner, forged `ownerId`/`userId` on create) were **blocked or sanitised server-side**. The only unconfirmed assumption is F-05.

---

## H. Top ten risks (ranked by likelihood × harm)

1. Silent edits/deletes by any member with no history (F-01) — arguments over money with no way to resolve them.
2. Users cannot record the payments they actually make (F-02) → balances drift from reality.
3. Real money moved from a stale screen (F-29).
4. Forgotten password = lost account; no deletion/export (F-04).
5. Gateway header trust (F-05) — catastrophic *if* wrong, unverified.
6. No backup/rollback/monitoring/CI (F-06); production can drift from GitHub.
7. Global revision lock-step; collisions grow with users (F-03/F-20).
8. Hidden `bankAmount` override and zero totals accepted (F-10).
9. Wrong default payer and UTC/local date mismatch → quietly wrong entries (F-25/F-14).
10. Receipts: orphaned, never deleted, 5 MB wall at the restaurant table (F-08/F-09).

---

## I. Quick wins (≤ 1 day each, high value)

1. Reject `bankAmount` when currency = trip currency and when ≤ 0; reject zero-total expenses server-side (F-10).
2. Declare `tsx` as a devDependency, add `"test"` script and a GitHub Actions workflow (install → tsc → lint → test → build).
3. Default "Paid by" to the signed-in user's traveller; compute dates from local components (F-25/F-14).
4. Confirmation sheet + undo toast for delete expense / undo payment / remove draft (F-12).
5. Refetch the ledger on focus/visibility and before showing settlement amounts; show "last updated" (F-29).
6. Add CSP/frame-ancestors/HSTS/Referrer-Policy in `build/sites-worker.ts` (F-18).
7. Show *your share* on each expense row and a one-line explanation that suggestions are simplified (F-13).
8. Label manual rates and bank charges correctly in the expense list (F-15).
9. Client-side image downscale + EXIF strip (F-09).
10. Surface the real validation message instead of the generic error; block duplicate traveller names; purge expired sessions/invites/rate-limit rows.
11. Verify the gateway strips `oai-authenticated-user-*` (F-05) — an hour of work that retires the biggest unknown.

---

## J. Remediation roadmap (independently reviewable PRs)

| # | PR | Purpose / scope | Likely areas | Depends | Tests | Risk | Size |
|---|---|---|---|---|---|---|---|
| 1 | **Financial-integrity hardening + test/CI foundation** | Server-side rules (F-10, zero totals, bankAmount only for foreign currency, payment sanity), property/invariant test suite (shares=total, Σbalances=0, order-independence, settle→0, round-trip, penny-bias rotation optional), `npm test`, CI workflow, migration test applying `drizzle/*.sql` to SQLite, integration tests for `writeLedger`/invite/receipt via the existing SQLite shim | `lib/model.ts`, `lib/store.ts`, `tests/`, `.github/`, `package.json` | — | the invariants above + store/invite/receipt authz suite | Low | M |
| 2 | **Per-trip revision & granular mutation API** | Replace global `sync_state` with per-trip revision; endpoints per entity with idempotency keys and If-Match; owner-only for member/settings changes; keep atomic D1 batches; server computes balances for sanity checks; client stops uploading whole ledger | `app/api/*`, `lib/store.ts`, `db/schema.ts`+migration, `app/page.tsx` split | 1 | contention, idempotency replay, authz, migration of existing JSON | High (data migration) | XL |
| 3 | **Activity log, authorship, soft delete** | `trip_events`, `createdBy/updatedBy`, tombstones, History tab, "why did my balance change", event-driven notifications | schema, store, UI, notifications | 2 | event-per-mutation, replay equals state, restore | Medium | L |
| 4 | **Payments v2 + settlement v2** | Manual/partial payment form, edit, recipient acknowledgement, over-payment warning, exact minimal-transfer algorithm with deterministic tie-break, "how this was calculated", per-person statement | `lib/model.ts`, balances UI | 1 (3 for history) | partial/multiple/reverse/duplicate, optimality vs brute force, edit-after-settle | Medium | M |
| 5 | **Balance provenance & freshness UX** | Drill-down per balance, share on expense rows, search/filter/sort by date, refetch on focus + `last updated`, conflict diff dialog for stale editors | `app/page.tsx` + new components | 2 (conflict) | UI e2e | Low | M |
| 6 | **Auth & account lifecycle** | Email verification, password reset, change password, session list/revoke-all, account deletion/export with trip-ownership policy, rate-limit redesign, purge jobs | `lib/auth.ts`, routes, mail provider | — | auth flows, abuse tests | Medium | L |
| 7 | **Invitation hardening** | Revoke/regenerate, pending list, verified-email binding, claim-confirmation screen | `app/api/invite`, `trip-sharing.tsx` | 6 (verification) | invite matrix | Low | S–M |
| 8 | **Receipt lifecycle & capture** | Client downscale/EXIF strip, `DELETE`, ref-count + orphan sweeper, quotas, retention policy | receipt route, scheduled cleanup, capture UI | 2/3 | upload/orphan/deletion tests | Medium | M |
| 9 | **Trip lifecycle** | Close/archive, leave, owner-managed member rename/remove with balance checks, edit dates, ownership transfer, delete-with-export | store, UI | 2, 3 | lifecycle matrix | Medium | M |
| 10 | **Currency correctness** | ISO-4217 minor units, wider currency list, local-date handling, full timezone list, correct provenance labels, FX input fix | `lib/model.ts`, `/api/fx`, UI | 1 | per-currency rounding, midnight/DST | Low | M |
| 11 | **Security headers & platform trust** | CSP, frame-ancestors, HSTS, Referrer-Policy, verify/enforce gateway header trust (+ signature if available) | `build/sites-worker.ts`, docs | — | header assertions | Low | S |
| 12 | **Operations** | Backup/restore + drill, migration tracking and deploy runbook, GitHub↔Sites drift check, nightly invariant/orphan job, structured logs, `/healthz`, error tracking | scripts, docs, scheduled Worker | 1 | restore drill | Low | M |
| 13 | **MCP hardening** | Per-trip `get_trip_ledger`, redact emails, AI provenance on drafts, audit entries, rate limits | `app/mcp/route.ts` | 3 (audit) | cross-trip tests | Low | S–M |
| 14 | **Mobile & accessibility polish** | 44 px targets, skeletons, update-available prompt, reduced motion, screen-reader pass (VoiceOver/TalkBack), "quick add" mode (amount + who paid + title), keyboard handling | UI/CSS | 5 | manual + axe | Low | M |

Foundation first (1 → 2 → 3 → 4), then 6/7/8/9, with 11/12 in parallel because they carry no feature risk.

---

## K. Release gates

**Private beta (trusted friends, supervised)** — must have:
- [ ] Confirm gateway header stripping with the platform owner (F-05).
- [ ] F-10 validation fix + invariant tests + `npm test` + CI (PR-1).
- [ ] A working backup/restore procedure that has been exercised once; a way to see who changed what (minimum: an append-only edit log) (F-01/F-06).
- [ ] Custom/partial payment entry (F-02).
- [ ] Confirm-before-delete and refresh-on-focus (F-12/F-29); default payer = me (F-25); local-date fix (F-14).
- [ ] Tell testers plainly: no password reset, no deletion, anyone can edit everything.

**Public beta** — add:
- [ ] Per-trip revisions + granular API (PR-2); activity log with authorship (PR-3).
- [ ] Password reset, email verification, account deletion/export (PR-6); invite revoke (PR-7).
- [ ] Receipt deletion/retention and image downscale (PR-8); trip close/leave (PR-9).
- [ ] Security headers; monitoring/alerting; nightly invariant job; documented rollback (PR-11/12).
- [ ] Rate-limit redesign; privacy notice covering receipts/EXIF/emails.

**Production-ready** — add:
- [ ] Property-based tests for every invariant in §D, e2e tests for the five money-critical journeys (create trip → expense → partial pay → edit after settle → close), run in CI on every change against a real D1.
- [ ] Real-device test matrix (iOS Safari + installed PWA, Android Chrome) including camera, keyboard and notifications; screen-reader audit; WCAG 2.2 AA checks.
- [ ] Exact minimal settlement with provenance explanation; per-currency minor units; ISO list.
- [ ] Load test at 20 members × 1,000 expenses on real D1; independent security review of the auth and MCP surface; DR drill repeated.

---

## G′. Missing-product-capability assessment

| Capability | Class |
|---|---|
| Activity/audit history with authorship | **Must have before wider release** |
| Custom/partial/other-pair payments (+ edit) | **Must have** |
| Password reset, email verification, account deletion/export | **Must have** |
| Close/archive trip, leave trip, member removal/rename with balance rules | **Must have** |
| Balance drill-down / personal statement | **Must have** |
| Invite revoke + pending list | **Must have** (small) |
| Receipt delete/retention + image downscale | Strongly recommended |
| Live refresh / "last updated" | Strongly recommended |
| Recipient acknowledgement of payments | Strongly recommended |
| More currencies + ISO minor units | Strongly recommended |
| Exact minimal-transfer settlement | Strongly recommended (cheap) |
| Read-only offline snapshot of last-known balances | Nice to have (weigh the privacy cost) |
| Export to CSV/PDF summary | Nice to have |
| Categories / charts / recurring expenses | Do not build yet |
| Offline *writes* | **Do not build yet** — it needs client-generated ids + idempotency keys (PR-2) and a per-entity conflict policy (PR-3, F-11) before it is safe; today's loud failure with form retention is the right trade-off |
| In-app payment execution (bank links) | Do not build |
| Built-in OCR | Optional; the ChatGPT/Codex-driven flow is workable but copy-paste heavy |

---

## Appendix 1 — Commands run and results

| Command | Result |
|---|---|
| `npm run install:ci` (`npm ci`) | OK, 687 packages, 22 s; 2 deprecation warnings (`@esbuild-kit/*`) |
| `npx tsc --noEmit` | **0 errors** |
| `npm run lint` | **0 errors, 3 warnings** (`no-img-element` ×2, `no-location-assign-relative-destination`) |
| `npm run build` | OK (≈8 s); page chunk 156 kB, framework 190 kB, index 183 kB (uncompressed); route classification "unknown" warning from vinext |
| `node --test tests/` / `node --test tests/*.test.ts` | **Fail** (module resolution; undocumented) |
| `npx tsx --test tests/*.test.ts` | **64/64 pass** (model 27, MCP 25, auth 12), 2 s; no skips |
| D1 migrations (3 files, wrangler `--local`) | Applied |
| `npm start` (built Worker, local D1/R2) | Up on :8787 |
| `evidence/http-audit.mjs` | 57 recorded outcomes (§F/§G) |
| `evidence/model-audit.ts` | invariants over 4,000 random trips; settlement brute-force comparison; edge cases |
| `evidence/ui-audit.mjs` (Playwright/Chromium, 375×667, 320×568, 430×932, 667×375) | no horizontal overflow at any size; save bar in viewport; destructive actions unconfirmed; offline save fails loudly; touch-target list |

**Not tested / not possible here:** production deployment and its gateway; real iOS/Android (camera, safe-area, keyboard, PWA install, Web Push delivery); the live Frankfurter FX API (sandbox returned "Unable to retrieve the daily reference rate", so only the error path and server validation ran); screen readers; Lighthouse/contrast measurement; real-D1 performance; prompt-injection resistance of any specific model; service-worker offline navigation (inconclusive in Playwright).

## Appendix 2 — Strengths worth keeping

Integer-cent model with exact BigInt allocation and conversion; single FX rounding point; validation that mirrors the UI rules; CAS-guarded atomic D1 batches (including invite acceptance); hashed opaque session tokens and PBKDF2 with per-user salts and constant-time compare; strict Origin checks; Zod everywhere; push endpoint allow-listing and payload-less push; receipt magic-byte validation, `nosniff`, `no-store`; AI output limited to drafts with a human Save step; a distinctly mobile-first layout that survived 320 px.
