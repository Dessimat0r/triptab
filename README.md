# TripTab

A mobile-friendly holiday expense splitter with itemised receipts, shared trips and multiple currencies.

**Live app:** [triptab-holidays.dessimat0r.chatgpt.site](https://triptab-holidays.dessimat0r.chatgpt.site)

## Features

- Email/password accounts, editable profiles, holiday dates and traveller names. Owners can list, revoke or replace pending invitation links; joining previews the shared history before confirmation. ChatGPT/Codex is an optional connection for AI assistance.
- Expenses, partial and editable payments with review before confirmation, balances, traveller statements and suggested settlements, with exact rounding of each participant's share.
- Append-only holiday activity records who changed settings, travellers, receipts, items, payments, conversations, invitations and image metadata, with complete before/after details and recording times. Private account history covers profile, sign-in, connection and notification changes. Deleted expenses and payments can be reviewed and confirmed as new entries. Shared-trip members can edit shared entries; there are no approval roles.
- Open a receipt's **Receipt history** view for its saved edits, linked AI drafts, conversations and current/previous image activity. Older pages stay available, and switching back to details preserves unsaved item changes.
- Camera/gallery receipt uploads are capped at 4 million pixels and 8,192 pixels per dimension, preserving detail in long receipts. Photos are orientation-normalised and re-encoded as JPEG within the 5 MiB upload limit, without camera EXIF metadata. The prepared image is stored alongside an editable itemised receipt.
- Split each item equally, assign it to one person, specify percentages or allocate fractional quantities such as 2.5 of 3 blocks. The item amount is its full line price; quantities divide that cost. A whole-receipt percentage split can override item shares, including tax, tip and discount.
- Receipt storage is limited to 500 images per account and 200 per holiday. Removing an image's last saved reference schedules deletion; referenced images cannot be directly deleted. Restoring an expense does not recover a purged image.
- 25 currencies, including GBP, EUR and European currencies. Record transaction date, time and timezone; compare supported daily reference exchange rates with the actual converted bank charge, or enter a manual rate. Reference rates are daily, rather than intraday card-network rates.
- Shared receipt and individual-item conversations retain their item context and authors. Saved receipt notes and aliases remember names such as “blocks” for chocolate, including traveller-specific meanings of “me”, across later questions and receipt review. This context is stored in TripTab and shared across that receipt's item discussions.
- Responsive layouts, automatic dark mode, installable PWA support, an update-available prompt, an offline screen and optional browser notifications. Updates wait until the current form is finished or closed. Private ledger and receipt data are not cached for offline editing.
- Account/holiday JSON downloads and financial/history CSV exports include the shared data the signed-in user can currently access. Financial CSV appends item detail with full line prices, percentages and labelled quantity allocations; JSON also retains receipt memory and conversations. Image bytes and authentication secrets are excluded; downloads are not database backups.

## Stack

React 19 and TypeScript, using [Vinext](https://github.com/cloudflare/vinext) with Next.js App Router conventions. The backend runs as a Cloudflare Worker, with Cloudflare D1 (SQLite) for accounts and trip data, Drizzle migrations, and R2 for receipt images. The `/mcp` endpoint connects the app to ChatGPT/Codex through ChatGPT Sites.

## Local development

Use Node.js **24 LTS** (the version used by CI) and npm. Node.js 22.13.0 or newer is supported. From the repository checkout:

```sh
npm run install:ci
npm run build
```

The initial build generates `dist/server/wrangler.json`. Before the first local run, apply the nine migrations in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_charming_zeigeist.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_regular_maginty.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_windy_cammi.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0003_rainy_blazing_skull.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0004_hot_old_lace.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0005_audit_coverage.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0006_receipt_cleanup.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0007_receipt_message_registry.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0008_receipt_activity_scope.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0009_receipt_link_projections.sql
npm run dev
```

Open `http://localhost:5173` and create an email/password account. Do not replay migrations already applied locally. D1 and R2 preview data persist in the ignored `.wrangler/` directory; these commands do not modify production data.

A clean clone defaults to the portable execution profile on Windows, macOS and Linux. The scripts also support a Sites-managed Linux profile; checkout-local profile settings are ignored by Git. For the development server, a loopback-only optional ChatGPT identity simulation is available at `/signin-with-chatgpt?return_to=/`. It is excluded from production builds; hosted ChatGPT authentication is supplied by Sites.

Useful commands:

```sh
npm run build        # Build the Worker and browser assets
npm start            # Preview the built Worker locally; use its printed URL
npm run lint         # ESLint
npx tsc --noEmit     # TypeScript check
npm test             # Regression tests, including SQLite-backed storage checks
npm run db:generate  # Generate migrations after changing db/schema.ts
```

`npm start` shares the local D1/R2 state but does not simulate ChatGPT sign-in or deploy the app.

Ledger saves allow 1,500,000 UTF-8 bytes of editable content and reserve space for server metadata, with a hard 1,900,000-byte storage ceiling. Structured contact emails belonging to other travellers are omitted from JSON/history downloads; authored names, notes and messages are preserved.

The Worker implements bounded receipt cleanup with a 15-minute UTC Cron declaration. Confirm that Sites installs and runs this timer when deploying; a declaration in the generated Wrangler configuration does not establish an active production schedule. Historical images with unknown upload dates receive a 24-hour grace period from migration `0006`; referenced images and pending uploads remain protected.

`npm test` runs `tests/*.test.ts` with the directly declared `tsx` dependency. It deliberately excludes the historical reproductions under `docs/audit/evidence-*`; those files describe the state reviewed in the original audit. GitHub Actions runs a clean locked install, regression tests, type checks, lint and a production build on pull requests and pushes to `main`, with read-only repository permissions. CI does not contact production or publish the app.

## Accounts and optional services

Core features work without ChatGPT or an AI API key. Existing ChatGPT users can add a password in **Profile & app settings** while preserving their trips. Connecting ChatGPT requires an explicit account-linking action; matching email addresses do not merge accounts. Email verification delivery and password-reset email flows are not currently implemented.

Automatic receipt reading uses OpenAI's native image input through the Responses API. In **Profile & app settings → Receipt AI**, the verified `dessimat0r@gmail.com` account saves one shared OpenAI API key that funds receipt reading for all signed-in app users. Only that canonical owner account can replace or remove the key or change the provider; a password account merely claiming the same email cannot manage it. After the first verified setup, the owner can also manage the key through its existing password login. The server verifies and encrypts the key; browser storage, ledger exports, API responses and audit snapshots never contain it. API usage is billed to the supplied OpenAI API project, separately from a ChatGPT subscription.

Create a project-scoped key in the intended OpenAI project, such as **TripTab**. A `sk-proj-…` key identifies its project automatically; no project name or additional project header is required.

Scanning or uploading saves the image and draft before reading begins. A completed, validated transcription creates a review draft; an untouched initial editor displays its items immediately. Existing or locally edited receipt details show an explicit proposal review instead. **Save expense** remains a separate approval step. Reading never posts an expense, invents exchange rates or assigns personal consumption. Failed, incomplete or stale results leave the saved receipt and manual edits available.

Receipt and item questions retain the full connected ChatGPT/Codex MCP workflow, including aliases, memory and requested cost-share changes. **Ask ChatGPT / Codex** saves the question and prepares a prompt for that client; model processing takes place there. Returned replies and proposals refresh automatically while the receipt is open, and **Check for replies** remains available. The web app's automatic image reader is limited to transcription; it does not silently replace those tool-capable discussions. See [receipt quantities, conversations and memory](docs/receipt-context.md).

Configure `RECEIPT_AI_TOKEN_KEY` as a Sites secret containing 32 cryptographically random bytes encoded with base64url. Keep it stable: rotating it requires keys to be entered again. `OPENAI_RECEIPT_MODEL` optionally selects a native-image/structured-output Responses model; the default is `gpt-6.1-sol`, which supports image input, streaming and structured output. Apply the new `0010_receipt_ai_access` migration once before serving this release. Earlier migration SQL must not be replayed or edited.

Reading requires current holiday membership and a saved matching receipt image. Requests are limited per user and, for the shared API provider, across the whole app to protect the owner's API usage. Removing the shared key disables new API reads for everyone without deleting receipts or manual entries.

The SIWC ChatGPT-plan provider is retained behind `CHATGPT_PLAN_ENABLED=true` and is **disabled by default**. The owner can select it only after an approved hosted plan-usage client is configured with `CHATGPT_PLAN_CLIENT_ID`, an exact registered `CHATGPT_PLAN_REDIRECT_URI` ending in `/api/chatgpt-plan/callback`, and a separate `CHATGPT_PLAN_TOKEN_KEY` secret; confidential clients also need `CHATGPT_PLAN_CLIENT_SECRET`. If selected in future, each participant connects their own ChatGPT plan; the shared API key is not used as a fallback. `CHATGPT_PLAN_MODEL` is optional. Identity-only Sites sign-in and MCP credentials do not grant inference permission. The separate PKCE/OIDC flow requires `resource.invoke` and `chatgpt.tokens.use.direct`, encrypts tokens, validates signature/identity/nonce and serializes refresh-token rotation. It sends `store:false`, `stream:true` and account-available models to the supported public Responses endpoint. OpenAI's [SIWC open-source guide](https://developers.openai.com/siwc/token-sharing-open-source) requires a local loopback callback for its dynamic registration flow and directs remotely hosted apps to its interest form; TripTab does not bypass that restriction.

Push notifications require Worker environment values `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (a P-256 private JWK encoded as JSON) and optionally `VAPID_SUBJECT`. Keep private keys and other secrets in the deployment environment, never in Git. Notifications also depend on browser support and user permission.

Notification subscriptions are bound to their current account. Signing out clears that browser's subscription without removing the account's other devices. Activity notifications use a generic lock-screen title; finer recipient controls remain future work.

## Repository layout

- `app/`: application UI and HTTP/MCP routes.
- `components/`: receipt editor, chat, account, sharing and PWA interfaces.
- `lib/`: financial model, authorization, storage and notifications.
- `db/` and `drizzle/`: SQLite schema and ordered migrations.
- `build/` and `scripts/`: Sites Worker integration and development/build helpers.
- `tests/`: financial-model, authentication, storage, route and MCP regression tests.
- `public/`: PWA manifest, service worker, icons and offline page.

## Publishing

GitHub hosts this source mirror. Pushing here does **not** automatically deploy or update the live app. The existing production app is published through ChatGPT Sites, whose managed source repository and deployment lifecycle are separate.

For Sites changes, use the Sites build/publish workflow, including its production migrations and environment configuration. `.openai/hosting.json` identifies the existing Site and declares the `DB`, `RECEIPTS` and MCP capabilities. It contains no account credentials. Running `npm run build` or `npm start` alone does not publish anything.

See [the operations runbook](docs/operations.md) for release records, migration precautions, D1/R2 backup and recovery steps, and the checks still needed before broader production use. A documented procedure is not an exercised restore or an automated backup service.

See [audit coverage](docs/audit-coverage.md) for the shared/private write-path matrix, image-storage boundaries, exports and legacy-history limits. Earlier unlogged changes are not reconstructed.

The audit reports under `docs/audit/` remain historical evidence. [Implementation status](docs/audit/IMPLEMENTATION.md) maps their findings to these changes and the work still outstanding.
