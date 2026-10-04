# TripTab: independent second-pass review of the first-pass audit

Reviewed commit: `642e28b` (`main`). Review date: 2026-10-04. Inputs: `docs/audit/TRIPTAB_AUDIT.md` (first pass) and `docs/audit/OPUS_REVIEW_BRIEF.md` (this brief).
Scope: the repository, a clean local build, and the local Worker with local D1/R2. **No fixes were made. No production system was contacted.**

The first pass's evidence scripts (`docs/audit/evidence/`) were not available to this review, so I rebuilt the evidence I needed in `docs/audit/evidence-second-pass/`:

| Script | What it shows |
|---|---|
| `model-recheck.ts` | F-10, unbounded FX, F-13 optimum vs greedy on structured trips, F-21, F-14 per timezone |
| `mcp-bankamount.test.ts` | S-01 through the real `/mcp` route (the existing test harness, unchanged storage mock) |
| `http-recheck.mjs` | S-04, S-06, S-07, F-05 (local), F-03 against the local Worker |
| `ui-409-deadend.mjs` | S-02 in Chromium (390×844) against the local Worker |

Confidence labels follow the first pass: **Confirmed** (executed, or unambiguous code path), **Likely** (clear code path, not executed end to end), **Potential** (depends on something not observable here).

---

## 0. The three answers

1. **Can the numbers be trusted?** The arithmetic can. I re-derived every rounding path and found no error in `allocate`, `convertAmount`, `shares` or `balances`. The *inputs* are less trustworthy than the first pass said, though. Two P1 problems put a wrong total into the ledger in ordinary use:
   - Every expense defaults to the organiser as payer (F-25).
   - An honest AI currency correction leaves a hidden bank charge that silently overrides the receipt total (F-10, reachable through S-01).

   On top of that, any member can still rewrite anything without trace (F-01).
2. **Can several ordinary users rely on it through a real trip?** Not yet, and the main reason is different from the first pass's. The server's compare-and-swap is sound: I could not corrupt a balance or duplicate money through the API. But the counter is global, so **any user's save anywhere makes every other user's open expense form unsaveable**, and the editor offers no way to recover except discarding the entry (S-02, confirmed in a browser). In the AI receipt workflow, the one in-editor refresh that does exist silently overwrites concurrent edits (S-03). The first pass's statement that the CAS makes lost updates impossible is true for the transport layer only.
3. **What should be built or fixed next?** First, a small batch of S-sized fixes before any private beta (§5): default payer, server-side `bankAmount` rules plus the MCP merge, keeping and rebasing the form after a 409, local dates, delete confirmation, and not resetting the IP rate limit on login. Then the first pass's foundation order still stands: PR-1 (tests and CI), PR-2 (per-trip revisions), PR-3 (activity log), PR-4 (payments). The one change I'd make is to pull a minimal append-only edit log forward into the private-beta gate.

**Readiness: Alpha (unchanged).** The private-beta gate is somewhat larger than the first pass listed (§5).

---

## 1. Verdict on the first pass

The first pass is careful and mostly right. Its money-model analysis holds up under independent re-derivation, and its authorisation matrix held in every attempt I made. Where I disagree:

- **Severity:** two P2s are P1 (F-10, F-25).
- **F-11:** the reproduction path is not reachable as described. The real concurrency defects are elsewhere (S-02, S-03).
- **Overrated:** F-13, F-15 and F-17.
- **Factual errors:** a few small ones, listed in the table.

| ID | First pass | Verdict | Evidence / reason |
|---|---|---|---|
| F-01 | P1 Confirmed | **Confirm P1** | `writeLedger` authorises membership only, then replaces the trip JSON (`lib/store.ts:129-177`). F-22 is a sub-case; merge it here. |
| F-02 | P1 Confirmed | **Confirm P1** | The only payment creation is "Record paid" on a suggestion (`app/page.tsx:1037-1045`). |
| F-03 | P1 (wide) / P2 (few) | **Confirm, and stronger than stated** | Re-run: an unrelated user's save → the next user's save gets `409` (`http-recheck.mjs`). In the UI that `409` also discards the user's in-progress entry (S-02, browser-confirmed), so the defect bites even with a handful of users, as soon as more than one group is active. |
| F-04 | P1 Confirmed | **Confirm P1** | Plus S-06: unverified emails also let a squatter block a ChatGPT user from ever adding a password. |
| F-05 | P1 until verified, Potential | **Keep as a gate item; likelihood revised to low** | See §2.4. |
| F-06 | P1 Confirmed | **Confirm P1** | No `.github/`, no `test` script; `tsx` is only transitive. |
| F-07 | P2 Confirmed | **Confirm P2** | (a) is defence-in-depth only: the 256-bit token is the real secret, so email binding matters only once a link leaks. Extended by S-06. |
| F-08 | P2 Confirmed | **Confirm P2** | No `DELETE` in `app/api/receipt/route.ts`; nothing removes `receipts` rows or R2 objects. |
| F-09 | P2 Confirmed (code) | **Confirm P2 (code only)** | Not device-tested here either. |
| F-10 | P2 (P1 if AI public) | **Upgrade to P1** | The trigger is not "MCP opened to the public". An honest assistant reaches it today through the receipt workflow (S-01, executed through the real route). The editor then hides the bank-charge panel, while its preview and the expense row use the overridden total (`app/page.tsx:651-664`, `:984-988`). `bankAmount: 0` on a foreign-currency expense is also accepted and zeroes the expense (`model-recheck.ts`). It is the top priority class (wrong money), with no warning, and the fix is S. |
| F-11 | P2 Likely | **Partly reject; replace with S-02 and S-03** | The described path ("editor stays open → Refresh ledger → overwrite/resurrect") is not reachable. The editor is a full-screen modal (`.overlay` `position: fixed; inset: 0; z-index: 50`, `app/globals.css:808-814`), every header control sits below it (highest z-index 40), and Playwright could not click "Refresh ledger" while the editor was open. A plain edit therefore cannot be refreshed and re-saved without closing the editor. The real defects are the dead end (S-02) and a silent overwrite through the receipt-check refresh (S-03). Resurrection of a deleted expense *is* guarded on that path (`editing.expenseId`, `app/page.tsx:559-562`). |
| F-12 | P2 Confirmed | **Confirm P2** | One-tap Delete, Undo payment, Remove draft and Record paid. Raises the value of F-18 (clickjacking a one-tap destructive action). |
| F-13 | P2 Confirmed | **Split: algorithm → P3; explanation gap stays P2** | Counter-example confirmed (`[-3,-7,+7,+3]` → greedy 3, optimum 2). On 3,000 structured "couples + group" trips (4–8 people, whole-pound receipts) greedy was worse in **27 (0.9%)**, always by exactly one transfer. That is never wrong money and rarely an extra transfer. Exact subset DP isn't worth it; pairing equal and opposite balances before greedy catches the couples case. The lack of a per-person statement / "why is my balance this?" is the real problem and belongs with F-01/F-02. |
| F-14 | P2 Confirmed | **Confirm P2; scope is larger than reported** | Daily hours with a wrong default date: London 1, Berlin 2, Istanbul 3, New York 4, Los Angeles 7, Tokyo 9, Sydney 11 (on DST-change day 4 Oct 2026). `/api/fx` **rejects every evening lookup in the Americas**: New York 20:00–24:00, Los Angeles 17:00–24:00 local. The claim is confirmed, and the realistic trigger is a device zone such as `America/Los_Angeles`, not the contrived `Etc/GMT+12`. USD/CAD/AUD are offered currencies. Payments have the same UTC-date bug (`:1042`). |
| F-15 | P2 Confirmed | **Downgrade to P3; partly corrected** | Of the 25 offered currencies only **ISK** has 0 minor units in ISO 4217. HUF, UAH, AMD, ALL, RSD and MKD have 2, so "ISK/HUF/UAH settle in fractional units that cannot be paid" is overstated. The effect is sub-krona ISK amounts (< £0.01). The "Reference estimate" label on manual rates is confirmed (`app/page.tsx:984-988`: the label depends only on `bankAmount` and currency, never `fx.source`), but it is cosmetic. Currency coverage is a product decision, not a defect. |
| F-16 | P2 Confirmed | **Confirm P2; extended by S-04** | A successful login also clears the per-IP bucket, so the per-IP limit is bypassable. |
| F-17 | P2 Confirmed | **Downgrade to P3** | Noise and a generic lock-screen text; no money or access impact. The shared-device case shows the *current* session's notifications (the service worker fetches `/api/notifications` with the current cookie), not the previous account's, so nothing leaks across accounts. |
| F-18 | P2 Confirmed locally / Potential | **Confirm** | No CSP / `frame-ancestors` / HSTS / Referrer-Policy on `/` locally; `_headers` holds only the static-asset cache rule. |
| F-19 | P2 Potential | **Confirm P2 Potential** | Code matches; prompt injection still not tested against a model. |
| F-20 | P2 Confirmed | **Confirm P2** | Not re-measured. The 1.5 MB cap is visible at `lib/store.ts:118,169`. |
| F-21 | P3 Confirmed | **Confirm P3; direction clarified** | `£10 ÷ 3 → [334,333,333]`. The first selected person *owes* the extra penny, so by default the organiser pays slightly more; nobody gains. |
| F-22 | P2 Confirmed | **Merge into F-01** | Same root cause: any member can strip references and remove an unlinked traveller in one save. |
| F-23 | P2 Confirmed | **Confirm P2** | |
| F-24 | P3 Confirmed | **Confirm P3** | |
| F-25 | P2 Confirmed (code) | **Upgrade to P1** | `payer: trip.members[0].id` for new expenses (`app/page.tsx:281`) and uploaded receipts (`:498`). Every expense entered by anyone except the organiser is attributed to the organiser unless they notice and change it. This is the most likely route to a wrong balance in normal use. It is visible ("Alice paid" on the row), which is why it isn't worse, but it is easy to miss when entering things quickly at the table. Fix S. |
| F-26 | P3 Confirmed | **Confirm P3** | 100,000 is the Workers PBKDF2 ceiling, so the claim is accurate. |
| F-27 | P3 Likely | **Not re-verified** | No screen reader available here. |
| F-28 | P3 Confirmed | **Confirm P3** | |
| F-29 | P2 Confirmed (code) | **Confirm P2** | |
| F-30 – F-32 | P3 | **Confirm** | Lint: 0 errors, 3 warnings; `tsc` clean; 64/64 tests (re-run). |

**Register hygiene:**
- **Ordering:** F-22 is listed among the P2s before F-21, which sits under P3. The IDs and their text agree, and §H/§I cite them correctly; it's an ordering issue only.
- **Mislabelled severities:** F-23, F-25 and F-29 are labelled **P2** but sit under the "P3 — polish" heading. Anyone triaging by heading would under-rate them.

---

## 2. Where the brief asked me to push hardest

### 2.1 F-10 (`bankAmount`)
**It is reachable without a malicious AI.**
- **Model:** `expenseTotal` returns `bankAmount` before the same-currency check (`lib/model.ts:301-309`).
- **Validation:** `validateLedger` never rejects a same-currency `bankAmount`, nor a `bankAmount` of 0 (`cents` allows 0).
- **UI:** the browser blocks both by clearing `fx` and `bankAmount` when currency changes (`app/page.tsx:1650-1659`) and by refusing a zero charge.
- **MCP:** the merge does not clear `bankAmount`. It spreads `...existing, ...args.draft` (`app/mcp/route.ts:311-313`) and explicitly clears only `fx` on a currency change (`:330`).

So when the assistant does what the copied prompt asks ("identify the printed currency") and corrects a draft's currency to the trip currency, the user's earlier bank charge survives, hidden. Executed through the real route: a £100.00 GBP receipt ends up with ledger total £87.00 (S-01). A draft can also target an existing expense (`expenseId`), so approving the update silently changes a posted expense's total.

**Verdict:** P1, fix S:
- server-side: reject same-currency `bankAmount`, `bankAmount ≤ 0` and zero totals;
- in MCP: clear `bankAmount` whenever currency changes, mirroring the UI;
- in the editor: show the override whenever it is present.

### 2.2 Concurrency and the D1 batch pattern
**Server: I could not build a sequence of individually valid requests that corrupts a balance, duplicates money, or lets a stale write commit.** The reasoning:
- **Atomicity:** a D1 `batch()` runs as one transaction. Statement 2 is the CAS on `sync_state`, and every later statement is gated on the per-batch `marker` in `last_write`. A failed CAS turns the rest into no-ops, because the old `last_write` can't equal a fresh UUID.
- **Out-of-batch reads:** `existingRows`, `linkedRows`, `receiptRows` and `profile` are read outside the batch. They can only be stale if another write committed in between, and every writer of `trips` and `memberships` (`writeLedger`, `acceptInvite`) bumps the same counter, which makes this request's CAS fail.
  - `receipts` is insert-only, so a stale `receiptRows` can only cause a false rejection.
  - `createInvite` writes only `invites`.
  - `notifyMembers` runs after commit under `waitUntil`, and its failures are swallowed.
  - Identity re-mapping (`auth_links`) is re-checked inside the CAS (`NOT EXISTS … oai_user_id = ? AND user_id <> ?`).
- **Invite acceptance:** `acceptInvite` re-validates every precondition inside its CAS statement. Its `json_set` path is built from the integer `key` of `json_each`, not from user text. All values are bound parameters.
- **Upsert syntax:** the upsert's `INSERT … SELECT … WHERE … ON CONFLICT` form has the `WHERE` that SQLite needs to parse it correctly.

**Caveat (hardening, not a defect):** this safety rests on an unwritten invariant: *every endpoint that writes `trips` or `memberships` must bump `sync_state` inside the same batch.* A future endpoint that forgets it reopens a time-of-check/time-of-use gap on the authorisation checks in `writeLedger`. State the invariant in `lib/store.ts` and test it (PR-1).

**Client:** this is where lost work and lost updates actually happen (S-02, S-03).

**Duplicate money:** none at the transport layer (a retried POST returns `409`). Two members recording the same real payment is also blocked, because the second sees a `409` and then a recomputed suggestion. The remaining risk is a human entering a *new* payment by hand once F-02's form exists, so that form needs an idempotency key and a duplicate warning.

### 2.3 Authorisation
**I could not break the matrix in §G.** Attempts (code review, plus HTTP where noted):

| Surface | What I tried / checked | Result |
|---|---|---|
| Trip ids | Foreign trip id in a ledger POST; pre-creating a trip id | `403` via `existingRows`, and the upsert's `ON CONFLICT … WHERE owner OR membership` re-checks inside the batch. Pre-squatting only causes a `403`, i.e. DoS, and needs the id. `create_holiday` ids are `sha256(user:request_id)`, so squatting needs the assistant's UUID. |
| Member ids / `userId` / `email` | Client-supplied `userId`/`email` on members | Overwritten from `memberships`/previous JSON on every write (`lib/store.ts:138-148,152`). Cannot block invites by faking `userId`. |
| Receipts | Foreign receipt id on an expense/draft; GET of another trip's receipt; MCP `get_receipt_image` | `400 "does not belong"`; `404`; MCP requires both a ledger reference and `receiptAccess`. MCP cannot attach a new `receiptId` to a draft. |
| Invites | Non-owner create; reuse; member removed after invite; JSON path injection | Owner-only (SQL `t.owner = ?`); used/expired/removed all rejected inside the CAS; path index is numeric. |
| Notifications / push | Other user's inbox; registering someone else's endpoint | Inbox is `user_id`-scoped. Claiming an endpoint needs the endpoint URL (DoS only). |
| MCP scoping | Every tool | All operate on `readLedger(user)`; drafts only; `expenseId` and `conversation` are preserved from the stored draft. |
| ChatGPT linking (`lib/auth.ts:281-310`) | Account takeover / data merge | Linking needs **both** a password session and a provider identity. It links only an empty provider id or the legacy self-id, so no data merge exists. Unlinking needs a password. A legacy id that added a password and then unlinked is refused (`:119-120`). No takeover path beyond F-05 itself. |

New issues near this area, all P2–P3: S-04 (rate-limit reset), S-06 (email squatting), S-07 (`/mcp` has no Origin check).

### 2.4 F-05 (gateway header trust): realistic likelihood
**Likelihood that forged `oai-authenticated-user-*` headers work in production: low, but unproven.** Evidence for low:
1. The vendored `@openai/sites-vite-plugin` (`build/sites-vite-plugin.ts:47-52`) emulates the platform. It **strips every inbound `oai-authenticated-user-*` header before injecting its own**, from its own `HttpOnly; SameSite=Lax` cookie, and refuses cross-site sign-in requests. The emulation exists to mirror the production contract.
2. The first pass's single `curl -I` to production returned `403`, consistent with a gateway in front.
3. The app is designed around the gateway: `.openai/hosting.json` declares the Sites project, and `/mcp` deliberately accepts only provider identity.

What keeps it a gate item:
- **Blast radius:** the Worker trusts these headers on **every** route, not just `/mcp`. So any ingress that bypasses the gateway is a full account takeover for any known id. That includes a `*.workers.dev` or preview hostname, a misconfigured custom domain, or a future platform change.
- **Legacy ids:** profile ids that *are* the provider id are especially exposed.

**Evidence that would settle it:**
1. Written confirmation from the Sites platform (OpenAI) that inbound `oai-authenticated-user-*` headers are always stripped at ingress, and that the Worker has no other reachable hostname.
2. One probe, explicitly authorised by the owner (Dessimat0r): from a client with no cookies, `GET https://<production>/api/profile` with `oai-authenticated-user-id: audit-probe-<random>` and a matching email header. Expect `401`. Repeat against any `workers.dev`/preview hostname. The probe id must be a fresh random value, never a real user's.

**Who:** the owner, with Sites support. Defence in depth, if the platform offers it: a signed or secret header from the gateway, verified in `trustedChatGPTIdentity`.

### 2.5 Settlement (F-13)
Confirmed as covered in §1. Exact minimisation is NP-hard in general. The bitmask DP in `model-recheck.ts` is fine for ≤ 16 non-zero balances but adds code for a ~1% improvement. **Recommendation:** pair equal and opposite balances first, then greedy largest-debtor → largest-creditor, with a tie-break on member id rather than list position. Put the effort into explaining balances instead.

### 2.6 Currency and dates
- **Rounding order: confirmed.**
  - The original total is converted once, half-up, by exact decimal expansion of the stored double (`convertAmount`).
  - It is then allocated by original-currency shares with BigInt largest-remainder.
  - The whole-receipt percentage path converts the total and then allocates.
  - The float branch of `allocate` is unreachable from current callers, because all weights are integers.
- **2-decimal assumption:** corrected in §1 (ISK only).
- **UTC vs local date:** confirmed and broader than reported (§1, F-14).
- **New:** FX rates and converted totals have no plausibility bound (S-05). Reference-rate precision for weak base currencies is a possible issue (S-08, unverified).

### 2.7 Severity calibration (summary)
| Change | Findings | Reason |
|---|---|---|
| **Up to P1** | F-10, F-25 | Wrong money in ordinary use; S-sized fixes |
| **Down to P3** | F-13 (algorithm), F-15, F-17 | No money/access impact, or rare |
| **Partly rejected** | F-11 | Path not reachable as described; replaced by S-02 and S-03 |
| **Merged** | F-22 → F-01 | Same root cause |
| **Unchanged P1** | F-01, F-02, F-03, F-04, F-06, F-05 (gate) | |

---

## 3. New findings

**S-01 · P1 · Confirmed (real `/mcp` route) · Financial: an AI currency correction keeps a hidden bank charge that overrides the receipt total**
- **Evidence:** `app/mcp/route.ts:311-333`. The draft is `draftSchema.parse({ ...existing, ...args.draft, …, fx: args.draft.fx ?? (existing?.currency === args.draft.currency ? existing.fx : undefined) })`. `fx` is cleared on a currency change; `bankAmount` is not. The browser clears both (`app/page.tsx:1650-1659`).
- **Scenario:**
  1. GBP trip. The user enters a receipt as EUR with their card's charge, £87.00.
  2. They ask their assistant to read the receipt. It correctly sets the currency to GBP and omits `bankAmount`, as the tool description instructs ("only include bankAmount … from the user's stated details").
  3. Result: `{currency: 'GBP', bankAmount: 8700}`, receipt total £100.00, ledger total **£87.00** (`mcp-bankamount.test.ts`).
  4. The review editor hides the bank-charge panel for same-currency drafts (`app/page.tsx:1893`). The per-person preview splits £87.00 while the footer says "Original receipt total £100.00".
- **Impact:** a wrong total that a user approves without any visible cue. If the draft targets an existing expense, approving it rewrites that posted expense.
- **Fix:** clear `bankAmount` in the MCP merge whenever `currency` changes, plus the F-10 server rules, and show a `bankAmount` warning in the editor whenever one is present.
- **Tests:** an MCP currency-change test asserting `bankAmount` is dropped; `validateLedger` rejects a same-currency `bankAmount`.
- **Size:** S.

**S-02 · P2 · Confirmed (Chromium, local Worker) · Reliability/UX: a `409` inside the editor is a dead end, and with the global revision any user's save triggers it**
- **Evidence:**
  - `save()` sends the `revision` from React state (`app/page.tsx:237-262`) and leaves it unchanged on error.
  - Inside the modal, the only control that refreshes state is the receipt "check" (`checkEditorReceipt`, `:432-456`), which requires a receipt draft (`:434-437`).
  - The page's "Refresh ledger" buttons (`:769`, `:831`) sit under the `.overlay` (`z-index: 50`).
- **Reproduction** (`ui-409-deadend.mjs`):
  1. Alice opens a new expense and types it in.
  2. Carol, an unrelated user on an unrelated trip, saves.
  3. Alice taps Save three times. Each attempt fails with "Your ledger changed in another tab or in ChatGPT. Refresh before saving again."
  4. "Refresh ledger" can't be clicked while the editor is open, and the in-editor refresh answers "Ask a receipt question or copy the receipt prompt first…".
  5. Stored expenses: 0. Alice has to close the editor and lose the entry.
- **Impact:** losing an itemised entry at the table is the most common way users will meet concurrency. Its frequency grows with total activity across all users and groups, not just the user's own trip (F-03). This is the practical face of F-03 before any scale.
- **Fix:** on `409`, re-fetch the ledger, keep the form, and retry once if the expense being edited is unchanged since the editor opened. If it changed, show both versions and ask. Carry a last-seen copy (or hash) of the edited expense in editor state. Per-trip revisions (PR-2) reduce the frequency; this fix removes the dead end.
- **Tests:** UI e2e like the script; a unit test of the rebase decision.
- **Size:** S–M.

**S-03 · P2 · Likely (code-traced, deterministic) · Integrity: in the receipt workflow, the in-editor refresh silently overwrites other members' concurrent edits**
- **Evidence:**
  - `checkEditorReceipt` (`app/page.tsx:432-456`) sets the fresh ledger *and revision* while the editor is open, but updates only `editing.conversation` (`:450`).
  - `submitExpense` (`:522-580`) then replaces the expense wholesale with the editor copy (`:574-576`) using the fresh revision, so no `409` occurs.
- **Scenario:**
  1. Alice opens expense E (which has a receipt) and asks the AI a question.
  2. While she waits, Bob edits E's payer or items and saves.
  3. Alice taps "check" for the reply, then Save.
  4. Bob's change is gone, with no warning and no record (F-01).
- **Impact:** lost update of a financial record, during exactly the workflow that keeps an editor open for minutes.
- **Fix:** same as S-02. Compare the stored expense against the copy the editor opened with before adopting a new revision.
- **Tests:** e2e with two sessions.
- **Size:** S (shares S-02's mechanism).

**S-04 · P2 · Confirmed (HTTP, local) · Auth abuse: any successful login resets the per-IP rate-limit bucket**
- **Evidence:** `clearRateLimit(keys)` deletes **both** the IP key and the email key after a successful login or password set (`lib/auth.ts:202-204, 236, 277`).
- **Reproduction:** 24 failed logins against 24 different emails from one IP, with a successful login on the attacker's own account after every sixth. Result: **0 rate-limited** (the per-IP limit is 8 per 15 min). Interleaved logins also let one IP register far more than eight accounts.
- **Impact:** the per-IP control, the main defence against credential stuffing (one password per email), is bypassed with one valid account. The per-email limit still caps guesses per victim. Each attempt also costs the Worker a 100k-iteration PBKDF2.
- **Fix:** on success, clear only the email key; keep separate register and login IP buckets (with F-16).
- **Tests:** the reproduction as a test.
- **Size:** S.

**S-05 · P3 · Confirmed (model) · Financial input: no plausibility bounds on exchange rates or converted totals**
- **Evidence:** `fxSchema.rate` is any positive finite number (`lib/model.ts:47-51`). Converted totals aren't held to the `cents` cap (100,000,000) that every other money field has (`expenseTotal`, `:301-309`).
- **Reproduction:**
  - A manual rate typo of `8567` instead of `0.8567` on a €100 dinner is accepted as **£856,700.00**.
  - A converted total of 4,000,000,000,000,000 is accepted.
  - Summing a few such expenses can pass `Number.MAX_SAFE_INTEGER`, where `balances` would lose exactness.
- **Impact:** a one-keystroke error produces an absurd but valid ledger, with no warning beyond the "to split" line.
- **Fix:**
  - Cap converted totals at the same 100,000,000.
  - Warn and require confirmation when a manual rate differs by more than ~10% from the reference rate (when one is available) or when the converted total exceeds the original by an implausible factor.
- **Size:** S.

**S-06 · P3 · Confirmed (HTTP, local) · Accounts: email squatting blocks a ChatGPT user from adding a password**
- **Evidence:** `register` accepts any unverified email (`lib/auth.ts:206-226`). `set_password` for a ChatGPT identity then collides on the unique `auth_credentials.email` (`:256-276`).
- **Reproduction:** after a third party registers `user@…`, the genuine ChatGPT user with that email gets `409 "This email already has a password account…"` for ever. The squatter also passes the email binding of any invite addressed to that email (F-07a).
- **Impact:** a permanent lock-out from password sign-in for the real user.
- **Fix:** email verification before an email becomes unique (F-04/PR-6). Until then, don't treat an unverified registration's email as reserved.
- **Size:** part of PR-6.

**S-07 · P3 · Potential · MCP: `/mcp` performs no Origin, Content-Type or Fetch-Metadata check**
- **Evidence:** `app/mcp/route.ts:191-201` parses `request.text()` regardless of content type. Locally, a `text/plain` request with `Origin: https://evil.example` and provider headers ran `get_trip_ledger` (`200`), while the same Origin on `/api/profile` got `400`.
- **Exploitability:** depends on whether the production gateway injects identity on cross-site browser requests. The vendored emulation uses a `SameSite=Lax` cookie, which would not be sent on a cross-site POST, so this is probably not exploitable. Even if it were, write tools need the current global revision and trip/member ids, and an attacker can't read responses.
- **Fix (defence in depth):** reject requests carrying `Sec-Fetch-Site: cross-site` or a browser `Origin`, and require `application/json`.
- **Size:** S.

**S-08 · P3 · Potential (unverified: the FX API is blocked here) · Currency: reference-rate precision for weak base currencies**
- **Evidence:** `/api/fx` requests `base=from&symbols=to` and stores the provider's number as-is (`app/api/fx/route.ts:77-79,106`). The UI displays it with `toFixed(5)` (`app/page.tsx:1923`). If the provider rounds cross rates to about 5 decimal places, HUF→GBP (≈0.00214) carries up to ~0.2% relative error. That is about £0.50 on a 100,000 HUF bill, for ISK, HUF and similar.
- **Fix:** request the inverse pair (`base=to&symbols=from`) and invert exactly, or request a large `amount`.
- **Verify:** compare the two directions for HUF/ISK/CZK against the live API.
- **Size:** S.

---

## 4. Revised scorecard

| Area | First pass | Second pass | Reason for change |
|---|---|---|---|
| Financial correctness | 8 | **7** | Arithmetic is still excellent. Default payer (F-25) and the honest-AI `bankAmount` path (S-01) put wrong totals in through normal use. No bounds on FX (S-05). |
| Settlement correctness | 6 | 6 | Greedy matters less than stated (F-13 → P3); the missing payment form (F-02) matters as much as stated. |
| Multi-currency | 5 | 5 | F-15 partly overstated, but F-14 is broader (Americas evenings, Asia-Pacific mornings). |
| Data integrity | 6 | **5** | Server is sound, but the client has a silent lost-update path (S-03) and an entry-destroying conflict path (S-02). |
| Security | 5 | 5 | F-05 likelihood is lower; S-04 and S-06 offset that. |
| Collaboration / concurrency | 5 | **4** | Browser-confirmed: one unrelated save makes every open editor unsaveable (S-02). |
| Mobile UX | 6 | 6 | Not device-tested here. |
| Product completeness | 3 | 3 | |
| PWA / reliability | 5 | 5 | |
| Accessibility | 6 | 6 | Unverified by either pass. |
| Testing | 5 | **4** | No client tests at all; the MCP merge's currency-change behaviour is untested. That is how S-01 survived 25 MCP tests. Zero `store.ts`/route tests. |
| Operational readiness | 2 | 2 | |
| Maintainability | 5 | 5 | Add the unwritten "every writer bumps `sync_state`" invariant to the risks. |

**Readiness: Alpha (unchanged).**

---

## 5. Revised top ten risks and a minimal private-beta list

**Top ten (likelihood × harm):**
1. Expenses silently attributed to the organiser (F-25). Near-certain in a group, and wrong money.
2. Silent edits/deletes by any member with no history (F-01, incl. F-22).
3. Entries lost to conflicts caused by *other* users' saves; silent overwrite in the receipt flow (S-02, S-03, F-03).
4. Users cannot record the payments they actually make (F-02).
5. Hidden `bankAmount` overrides, reachable by an honest assistant (F-10, S-01).
6. Forgotten password = lost account; no deletion or export; email squatting (F-04, S-06).
7. No backup, rollback, monitoring or CI; production can drift from GitHub (F-06).
8. Real money moved from a stale screen (F-29).
9. Wrong default date, and FX lookups refused in the evening outside Europe (F-14).
10. Gateway header trust (F-05). Catastrophic if wrong, low likelihood, cheap to settle.

**Must fix before a private beta (minimal; most are S):**
- [ ] Default payer = the signed-in user's traveller, for expenses and uploaded receipts (F-25).
- [ ] Server rules: no same-currency `bankAmount`, `bankAmount > 0`, total > 0, converted total ≤ 100,000,000; MCP clears `bankAmount` on currency change (F-10, S-01, S-05).
- [ ] On `409` in the editor: re-fetch, keep the form, compare against the opened copy, and ask if it changed. Apply the same check in `checkEditorReceipt` (S-02, S-03).
- [ ] Local-date defaults for expenses and payments (F-14).
- [ ] Confirm before Delete, Undo payment and Remove draft (F-12).
- [ ] Manual/partial payment form with an idempotency key (F-02).
- [ ] Minimal append-only edit log: who, when, what entity, before/after JSON, written in the same batch. A plain list view is enough at first (F-01).
- [ ] `npm test` + CI, plus one exercised D1 Time Travel restore (F-06 minimum).
- [ ] Written platform confirmation of header stripping, plus the owner-authorised probe (F-05).
- [ ] Keep the IP bucket after successful logins (S-04).
- [ ] Refresh on focus/visibility before showing settlement amounts (F-29).
- [ ] Tell testers plainly: no password reset, anyone can edit anything, and one tester's save can interrupt another's entry until S-02 ships.

---

## 6. What I could not verify

- **Production:** I did not contact production. F-05 and F-18 in production remain unverified.
- **First-pass evidence:** the first pass's own scripts (`docs/audit/evidence/`) were not available. I re-derived the claims I relied on and accepted the rest (F-20 timings, the first pass's Playwright layout checks, its 57 HTTP outcomes) on the first pass's word.
- **External services:** the live Frankfurter FX API (blocked by this sandbox's proxy, so S-08 is unverified).
- **Devices and accessibility:** real iOS/Android camera, safe areas, keyboard, PWA install and Web Push; screen readers, contrast, reduced motion; service-worker offline navigation.
- **Scale and AI:** real D1 performance at 20 members × 1,000 expenses; prompt-injection resistance of any model against the MCP tools.
- **S-03:** code-traced, not executed with two browsers. Its path is deterministic given the cited lines, and S-02's execution confirmed the state handling it relies on.

## Appendix: commands run

| Command | Result |
|---|---|
| `npm run install:ci` | OK (687 packages) |
| `npx tsc --noEmit` | 0 errors |
| `npx tsx --test tests/*.test.ts` | 64/64 pass |
| `npm run lint` | 0 errors, 3 warnings |
| `npm run build`; 3 migrations via `wrangler d1 execute --local`; `npm start` | OK on :8787 |
| `npx tsx docs/audit/evidence-second-pass/model-recheck.ts` | §1/§3 numbers |
| `npx tsx --test docs/audit/evidence-second-pass/mcp-bankamount.test.ts` | pass (S-01 demonstrated) |
| `node docs/audit/evidence-second-pass/http-recheck.mjs` (after `DELETE FROM auth_rate_limits`) | S-04, S-06, S-07, F-05 local, F-03 |
| `node docs/audit/evidence-second-pass/ui-409-deadend.mjs` (global Playwright, Chromium) | S-02 |
| `curl api.frankfurter.dev` | blocked by the sandbox proxy (403) |
