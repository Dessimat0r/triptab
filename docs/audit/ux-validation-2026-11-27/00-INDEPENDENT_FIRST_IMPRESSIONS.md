# Independent first impressions (recorded before reading Sol's findings)

Reviewer: Opus (second opinion). Commit under test: `963d7c8` (`main`, PR #87 merged). Date: 27 November 2026.

This file was written and committed **before** Sol's 21-finding audit (`AUDIT.md`) was available to this review, so the observations below are not shaped by Sol's conclusions. Git history shows this file preceding any reference to Sol's finding IDs.

**One caveat on independence.** The review brief itself summarised five of Sol's high-priority topics (payment/expense edit loss, Save bypassing a discount preview, registration leaving the invitation offscreen, keyboard focus on invisible settings controls, offline failure of the packaged app). I explored those areas knowing they had been flagged. Everything else below came from unprompted exploration. Where an observation matches one of those five topics, it is marked **[primed]**.

## Environment

- Production build (`npm run build`, Node 24.22.3) served by the built Worker (`npm start`, Wrangler local mode) on `127.0.0.1:8787`, with local D1/R2 state in the ignored `.wrangler/` folder and all 20 migrations applied. No production system was contacted.
- Synthetic accounts: `alice@example.test` (two browser contexts, standing in for two devices), `bob@example.test` (joined through an invite). Synthetic holiday "Lisbon Test Trip": 3 travellers, EUR.
- Browser: Playwright 1.63 with Chromium 1243 (headless). Viewports: 390×844 with touch/mobile emulation, 320×640, 1280×860 and 1440×900 desktop, plus dark mode. **WebKit is not installed in this environment**, so nothing here is WebKit-verified.
- Receipt AI is not configured (no OpenAI key; owner email is synthetic). The daily FX reference lookup cannot reach its provider from this sandbox, so it fails (502). That is an environment limitation, not an app defect.

## What works well (to keep)

- **Save feedback:** "Saved 'Dinner at the market'. + Add another" (`evidence/independent/07-after-save-390.png`).
- **Delete:** the confirmation states the settlement impact ("After this deletion, Bob pays Alice Tester €50.33 …"). A persistent **Undo** notice shows the balance delta (`56-…`, `57-…`).
- **Expense concurrency:** saving a stale edit shows a field-by-field "Your edits / Latest saved" merge (`24-…`). Saving a stale payment edit shows "Compare changed payment" with Replace/Cancel, and Cancel preserves the edit (`29-…`).
- **Expense editor:** Escape and the close button ask "Discard unsaved changes?" with focus on *Keep editing* (`14-…`). A `beforeunload` guard protects the draft when leaving the app on desktop.
- **Balances:** clear "Gets back / Owes", suggested transfers, per-traveller statements and a payment review step showing balances before the payment (`09-…`).
- **Connectivity drop:** the running app shows "You're offline. Keep this screen open—your unsaved edits are still here." Save is blocked with a clear message, the draft survives, and retrying after reconnect works (`47-…`, `50-…`).
- **Layout:** 320 px and dark mode both render without horizontal overflow (`58-…`, `59-…`). Touch targets are generally ≥44 px, and focus rings are visible on standard controls (including the `:focus-within` ring on the transparent file inputs, `60-…`).

## Observations (independent, tentative severity)

Severity here is provisional. The final severities are in `CONSOLIDATED_FINDINGS.md`.

### Financial correctness and data integrity

| ID | Observation | Tentative | Evidence |
|---|---|---|---|
| IO-01 | **[primed]** A structured discount (Tip, tax or discount → Add discount) that is filled in and previewed ("New total €54.00 · −€2.00 each") but not confirmed with its inline **Add** button is **silently dropped** when the always-visible **Save expense** is pressed. The expense saves at €60.00 / €20.00 each with no warning. Until Add is pressed, the sticky footer ("Total €60.00") contradicts the inline preview. | High | `19-…`, `20-…`, `21-…` |
| IO-02 | **[primed]** In the payment editor (*Record a payment* / *Edit payment*), **Escape and the close button discard edits immediately**, with no confirmation and no draft restore. This is inconsistent with the expense editor, which asks first. A tap outside the panel is safely ignored. | Medium–High | `10-…` (scripted repro; closed state has no visual) |
| IO-03 | **Browser / Android Back does not close an open editor**: it navigates the page underneath (Balances → Expenses, Expenses → `/`) while the modal stays open. Repeated Back eventually leaves the app. On desktop Chromium a `beforeunload` prompt protects the expense draft, but mobile browsers and installed PWAs may not show it. | Medium | `13-…`, `16-…` |
| IO-04 | **[primed]** **Offline navigation always fails** on the built Worker. The service worker precaches `/offline.html`, but the Worker answers that URL with `307 → /offline`, so the cached entry is a *redirected* response (`redirected: true`). Chromium refuses to use it for a navigation. Reloading or reopening the app offline, or opening "Open capture form", gives `net::ERR_FAILED` and a blank browser error page, **even with offline capture enabled**. The layout suite runs with `serviceWorkers: 'block'`, so CI cannot catch it. Production impact is unverified (it depends on the host's static-asset HTML handling). | High | `49-…`; cache entry `{status:200, redirected:true, url:"/offline"}` |
| IO-05 | Conflict UI rough edges: the copy says "Another traveller changed this expense" when the same account edited on another device. A single-line expense asks for "Name" and "Description" separately (they are the same visible field). After **Keep their version**, closing still prompts "Discard unsaved changes?" (false dirty state). | Low | `24-…` |
| IO-06 | After reconnecting, the alert "You're offline. Reconnect to save" stays until the next save attempt. | Low | `50-…` |

### Accessibility

| ID | Observation | Tentative | Evidence |
|---|---|---|---|
| IO-07 | **[primed, but broader than primed]** The **shared modal focus trap** (`components/modal-accessibility.tsx:92`) intercepts Tab and calls `focus({ preventScroll: true })`, so **scroll containers never follow keyboard focus**. In *Profile & app settings*, every control below the first screen receives focus while the panel stays at `scrollTop 0`: focus moves to y = 997…4,246 px in an 860 px window (`37-…`, `38-…`). The expense editor partly compensates through `useStickyFooterReveal`, but only scrolls **down**, so wrap-around and Shift+Tab land on header controls at y = −222 px (`39-…`). Every `useModalLayer` dialog is affected. | High (keyboard users) | `37-…`, `38-…`, `39-…` |
| IO-08 | The flat *Added tax / Tip / service / Discount* fields have accessible names "tax", "tip", "discount", which do not match their visible labels (WCAG 2.5.3 Label in Name; voice-control users). | Low–Medium | aria snapshot in `17-…` |
| IO-09 | Focus is **lost to `<body>`** after (a) registering from an invite (see IO-14) and (b) pressing **Add item** on an unprocessed receipt. | Medium | `43-…`, `53-…` |
| IO-10 | No skip link. On desktop, 9 sidebar tab stops come before the main content (landmarks exist, so screen-reader users can bypass). | Low | Tab trace in working notes |
| IO-11 | The signed-out invite landing announces a normal state ("Sign in to TripTab to open your ledger.") through an error-styled `role="alert"`. | Low | `41-…` |

### Navigation, onboarding and information architecture

| ID | Observation | Tentative | Evidence |
|---|---|---|---|
| IO-14 | **[primed]** **After registering from an invite link**, the page stays scrolled where the form was (`scrollY 1252`). The *Join Lisbon Test Trip* card and **Confirm history & join holiday** are offscreen above (top −1,027 px / −139 px). The visible primary call to action is **"Create your first holiday"**, which invites creating a separate, parallel ledger. Focus is on `<body>`. | High | `43-…`, `44-…` |
| IO-15 | On the invite landing, **"Create an account or sign in" switches the form to Sign in**. A new invitee must then find "Create an account". | Low–Medium | `42-…` |
| IO-16 | **The Travellers tab is a catch-all** (6,264 px tall at 390 px, about 7.4 screens): travellers, weights and dates, invites, payment handles, holiday details, display names, language preferences, archive/transfer/delete and data export. **History** starts with the invite form before the activity log. | Medium | `31-…`, `33-…` |
| IO-17 | The holiday summary header (title, Add/Scan, totals) repeats at the top of every tab, so tab content starts around y ≈ 660 of 844. The primary actions sit at the top, which is hard to reach one-handed. | Low–Medium | `32-…` |
| IO-18 | The holiday drawer and desktop sidebar action row is text-only and wraps to 2–3 lines ("Split / a / bill", "Activity / and / people"), which looks broken at both 390 px and 1280 px. | Low | `34-…`, `35-…` |
| IO-19 | Signed-out visitors see signed-in chrome: the breadcrumb "Holidays / Your next adventure", a "Y" avatar, "Updates automatically", and disabled New holiday / Split a bill buttons. Each visit logs 3–15 `401` console errors. | Low | `00-…` |
| IO-20 | The main-page **Scan receipt** opens the editor rather than the camera, so scanning takes two taps. | Low–Medium | `52-…` |
| IO-21 | A non-dismissible "Offline expense capture" promotion card sits above the holiday header on Travellers. | Low | `32-…` |
| IO-22 | Receipt tools show every user a long ChatGPT prompt containing internal trip, draft and receipt UUIDs. | Low | `52-…` |

### Financial clarity and expense entry

| ID | Observation | Tentative | Evidence |
|---|---|---|---|
| IO-23 | **Two parallel discount mechanisms** sit side by side: structured *Add discount / Add charge* (with Offer rule, Chosen items or Whole receipt) and flat *Discount / Added tax / Tip* fields. Their relationship is not explained, which compounds IO-01. | Medium | `17-…`, `18-…` |
| IO-24 | The "Still to settle" card is green whether everyone is square or €60 is outstanding. | Low | `07-…` |
| IO-25 | The payment timezone is a free-text field ("UTC", placeholder "Europe/London"). | Low | `10-…` |
| IO-26 | The holiday subtitle shows only the start date ("20 Nov"), not the range. | Low | `04-…` |

## Withdrawn on checking

- **IO-12** (Escape behaviour in dialogs) was merged into IO-02 and IO-07.
- **IO-13** suspected that the transparent (`opacity: 0`) receipt file inputs hide keyboard focus. **Withdrawn:** the wrapper shows a visible `:focus-within` ring (`60-…`).

## Not yet examined at this point

WebKit; installed-PWA behaviour; live receipt recognition (needs a key); 200% text zoom; screen-reader output (only accessibility-tree inspection); large data sets; slow networks; ad-hoc "Split a bill" flows; import/export; multi-currency settlement with a working FX lookup.
