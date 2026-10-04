Throw-away audit scripts used to produce the observations in `../TRIPTAB_AUDIT.md`. They target a **local** worker (`npm run build && npm start`, migrations applied) and local D1/R2 only; paths inside assume the repo is at `/home/user/triptab`.

- `http-audit.mjs` — HTTP-level authz/IDOR, invite, concurrency, retry, limits, rate-limit, forged-header checks (`node http-audit.mjs`; clear `auth_rate_limits` between runs).
- `model-audit.ts` — randomised invariants, settlement optimality, edge cases (`npx tsx model-audit.ts`).
- `ui-audit.mjs` — Playwright mobile viewport run (screenshots go to a scratch dir).
- `greedy.ts` — settlement counter-example.
