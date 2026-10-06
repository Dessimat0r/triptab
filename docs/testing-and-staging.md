# Testing and staging

Changes are developed on separate pull-request branches against `main`. CI checks the complete source with isolated fixture accounts and databases, mocked OpenAI responses, TypeScript, lint, a production build and Chromium/WebKit layouts. It does not call the paid OpenAI API or modify production data. Native D1/Worker tests cover saved authors, receipt access and ledger/audit persistence; browser fixtures cover responsive interactions.

CI runs the complete regression suite, TypeScript/lint, and each browser engine on independent runners. Both browser jobs build the production Worker from the same checkout and run every viewport and interaction case for their engine, with four isolated browser workers per public Linux runner. Local browser runs retain the default of two workers. The existing `verify` check passes only when all jobs succeed, including both browser engines; failures, cancellations and skipped jobs fail that gate. There are no path filters, reduced pull-request suites or scheduled-only safeguards.

Browser downloads are cached by engine, Ubuntu version, architecture and the locked Playwright browser manifest. Each run still checks and installs the engine's system libraries. Headless Chromium uses Playwright's headless shell, so CI omits the unused full Chromium download. Browser installation has a five-minute limit to fail visibly on a stalled package mirror, and failed browser traces are retained for seven days. Superseded runs continue to be cancelled.

### CI runtime review (2026-10-06)

The latest two successful runs ([main](https://github.com/Dessimat0r/triptab/actions/runs/37532447373), [PR #28](https://github.com/Dessimat0r/triptab/actions/runs/37527231904)) took 4m18s and 3m50s end to end. Their single `verify` job serialized these steps:

| Step | Measured time |
| --- | --- |
| Locked dependency installation | 13–16s |
| All 1,192 regression tests | 57–69s |
| TypeScript | 9–11s |
| Lint | 16–19s |
| Production build | 5–7s |
| Browser/system dependency installation | 47–52s |
| All 66 Chromium/WebKit cases | 59–76s |

An [earlier failed run](https://github.com/Dessimat0r/triptab/actions/runs/37503549532) spent 12m56s on browser installation alone. This is setup latency, not evidence that financial or security tests should be removed.

Keep the regression tests for rounding/conservation, account and trip isolation, guarded writes, immutable history, migrations, receipt ownership and refresh races. Native D1 tests supplement the Node SQLite fixtures: they catch actual Worker/D1 limits that the shim does not reproduce. Browser cases cover real rendering, touch input, split controls, translation fields, upload guidance and conflicts across both engines, including the 480/481px breakpoint and enlarged text. These checks provide complementary coverage.

The [first parallel run](https://github.com/Dessimat0r/triptab/actions/runs/37537016819), with empty browser caches and two workers per engine, passed all 1,192 regression tests and all 66 browser cases in 2m29s end to end: 42% faster than the latest main run. Increasing browser concurrency to four workers and reusing the browser caches should reduce this further; actual times depend on runner queueing and package mirrors. Parallel execution uses more concurrent runner minutes and repeats the short production build for each engine. Further test removal should require equivalent behavioral coverage and a measured saving; a similar test name or source-level assertion alone is not sufficient evidence of redundancy.

TripTab Staging is a separate private Site. It uses independent D1 and R2 resources; production accounts, receipt photos, AI settings and keys are not copied. Sign in or create a staging account, then choose **Create sample holiday** to add fictional multilingual receipt data owned by that staging account. Repeated sample creation generates new IDs. The testing banner and button are enabled only in a build with `NEXT_PUBLIC_TRIPTAB_ENVIRONMENT=staging`.

For future release testing, deploy the candidate PR head to the staging Site, preserving that Site's own `.openai/hosting.json` identity and storage bindings. Record the candidate GitHub SHA in the release record. Once checks and acceptance pass, merge the PR and deploy the verified `main` head to the public Site. Never merge a staging Site's project identity into `main`; the repository's hosting identity continues to identify the production Site. The existing hourly main deployment task continues to target production; staging deployment is manual unless a separate automation is requested.

Shared AI must be configured separately on staging. Upload/chat regression tests use mocked model responses; successful tests prove the integration and financial safeguards, not the model's accuracy on arbitrary real receipts. Real-model acceptance is deliberate and may incur API charges.
