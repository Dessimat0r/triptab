# Brief: independent second-pass review of the TripTab audit

## Your role
You are the second reviewer. A first-pass audit of TripTab (`github.com/Dessimat0r/triptab`) was produced by another model (Sonnet 5.5). Your job is to **verify, challenge and extend it**, not to restate it. Be sceptical but fair. Do not implement fixes.

## Inputs
- Repository at commit `642e28b` (branch `main`).
- First-pass report: `docs/audit/TRIPTAB_AUDIT.md` (findings F-01…F-32, scorecard, invariants, scenario and authorisation matrices, 14-PR roadmap, release gates).
- Evidence scripts: `docs/audit/evidence/` (`http-audit.mjs`, `model-audit.ts`, `ui-audit.mjs`, `greedy.ts`).
- If the report is not on GitHub yet, ask the user for the file.

## Product context
TripTab is a mobile-first shared-expense / settle-up app (same category as Splitwise and Settle Up). Stack: React/TypeScript on Vinext (Next-style), Cloudflare Worker, D1 (SQLite) with hand-written SQL, R2 for receipts, optional ChatGPT/Codex via an MCP endpoint. Production is deployed through ChatGPT Sites, separately from the GitHub source.

Priority order for judging severity: wrong financial result > lost/corrupted data > unauthorised disclosure or mutation > ambiguous financial UX > reliability > ordinary bugs > polish. Do not inflate severity, and label every finding Confirmed / Likely / Potential.

## What the first pass concluded (headline)
- Money arithmetic is sound: integer cents, exact BigInt allocation, single FX rounding point. 4,000 randomised trips held every invariant (shares = total, balances net to zero, order independence, settlements zero the balances).
- Overall rating: **Alpha**.
- Biggest problems: no audit trail or authorship (any member can silently edit or delete anything); payments can only be one-tap suggested transfers; no account recovery or deletion; one global revision counter for the whole database; no CI, backup or rollback; identity depends on gateway headers that were not verified.

## Where I want you to push hardest (verify independently)
1. **F-10 (`bankAmount` override).** Re-trace `expenseTotal` in `lib/model.ts` and the MCP draft schema. Is it exploitable only via AI/API, or also through a normal UI path? Is P2 right, or should it be P1?
2. **Concurrency claims.** Re-read `writeLedger` in `lib/store.ts` and `acceptInvite` in `app/api/invite/route.ts`. Try to construct a sequence of individually valid actions that corrupts a balance, duplicates money, or lets a stale write succeed. The first pass could not. Consider D1 batch semantics, the "marker" pattern, and anything done outside the batch (`existingRows` reads, `notifyMembers`).
3. **Authorisation.** Try to break the matrix in section G: IDOR/BOLA through trip, member, receipt, invite, notification and push-subscription ids; MCP tool scoping; `tripAccess`/`receiptAccess`; the invite flow (`json_each`/`json_set` SQL); the auth-link/ChatGPT-linking logic in `lib/auth.ts` (account takeover or data-merge paths).
4. **F-05 (gateway trust).** Assess the realistic likelihood that forged `oai-authenticated-user-*` headers work in production. State what evidence would settle it and who must provide it. Do not probe production without the owner's explicit authorisation.
5. **Settlement algorithm (F-13).** Confirm the greedy counter-example and judge whether exact minimisation is worth the complexity.
6. **Currency model.** Check the claims about rounding order, 2-decimal assumptions (ISK/HUF), and the UTC-vs-local date bug (F-14), especially the claim that the evening-in-the-Americas case triggers the FX "future transaction" rejection.
7. **Severity calibration.** Which findings are over- or under-rated? Which P2s should be P1, and which P1s should be P2? Justify each change.

## Things the first pass could not test (please cover if you can)
- Production deployment and the gateway's header handling (do not test without authorisation).
- Real iOS/Android: camera capture, safe areas, virtual keyboard, PWA install, Web Push delivery.
- The live Frankfurter FX API (blocked in the sandbox).
- Screen reader behaviour, contrast measurements, reduced motion.
- Service-worker offline navigation (the Playwright check was inconclusive).
- Real D1 performance at 20 members × 1,000 expenses.
- Prompt-injection resistance of a specific model against the MCP tools.

## Known caveats about the first pass
- It audited only a local build with local D1/R2.
- Findings F-21/F-22 were reordered while writing, so check the numbering in the register against the text.
- Some UI findings are code-traced, not executed (marked "Likely" or "code").
- The roadmap sizes are rough estimates.

## How to run the project
```
npm run install:ci
npm run build
npx tsc --noEmit
npm run lint
npx tsx --test tests/*.test.ts      # no npm test script exists; node --test fails on extensionless imports
# local Worker: apply drizzle/0000..0002 with wrangler d1 execute --local, then npm start (port 8787)
```
Clear the `auth_rate_limits` table between local HTTP test runs (all local requests share one IP bucket).

## Deliverable
One report with:
1. **Verdict on the first pass:** which findings you confirm, which you downgrade or reject (with evidence), and which you upgrade.
2. **New findings** the first pass missed, in the same format (ID, severity, confidence, evidence with file and function, scenario, impact, fix, tests, size).
3. **Revised scorecard** (0–10 per area) and readiness rating, with reasons for any change.
4. **Revised top ten risks** and a minimal "must fix before private beta" list.
5. A clear statement of anything you could not verify.

Answer three questions at the end: Can the numbers be trusted? Can several ordinary users safely rely on it through a real trip? What should be built or fixed next?
