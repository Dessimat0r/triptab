# TripTab: manual acceptance tests

These tests cover behaviour that **neither this review nor Sol's audit could verify**, because both ran browser engines on Linux in emulated mobile viewports. They need physical devices, an installed PWA, hosted staging infrastructure, paid services or real assistive technology.

Run them on **TripTab Staging** with synthetic accounts and the synthetic receipts in `tests/fixtures/receipts/v1/images/`. Never use production data. Record a result for each step: **Pass / Fail / Blocked**, with the device, OS, browser version and app SHA.

## Device and service matrix

| Ref | Device / environment | Minimum coverage |
|---|---|---|
| D1 | iPhone (current iOS), Safari tab | All MATs marked iOS |
| D2 | iPhone, TripTab installed with Add to Home Screen | MAT-02, MAT-04, MAT-12 |
| D3 | Small iPhone (375×667 class, e.g. SE) | MAT-07 |
| D4 | Android phone (current Chrome), browser tab | All MATs marked Android |
| D5 | Android, TripTab installed as a PWA | MAT-02, MAT-03, MAT-04, MAT-12 |
| D6 | Low-memory Android device (≤ 4 GB RAM) | MAT-04 |
| D7 | iPad or tablet with a hardware keyboard | MAT-05 |
| D8 | Desktop Safari (macOS) and Firefox | MAT-05, MAT-06, MAT-10 |
| S1 | Staging Site with its own D1/R2 | All |
| S2 | Staging with a funded OpenAI project key (receipt AI) | MAT-08 |
| S3 | Staging with VAPID keys and Resend email configured | MAT-11, MAT-12 |
| AT | VoiceOver (iOS, macOS), TalkBack (Android), NVDA (Windows) | MAT-10 |

---

### MAT-01 · Hosted offline document routing (TT-09) — S1

**Purpose:** Find out whether the hosted Site redirects `/offline.html` the way the local Worker does. If it does, TT-09 affects production users today.

1. `curl -sI https://<staging-host>/offline.html` and `curl -sI https://<staging-host>/offline`.
2. Load staging in Chrome with DevTools, enable *Offline expense capture* (Travellers), then in Application → Cache Storage inspect `triptab-public-v7` → `/offline.html`. In the console, run `(await caches.match('/offline.html')).redirected`.

**Expected before PR-04:** If step 1 shows `307 → /offline` and step 2 prints `true`, production is affected. Raise urgency.
**Expected after PR-04:** The cached entry is non-redirected (`false`), and the cache name is `…-v8`.

### MAT-02 · Installed PWA cold start offline (TT-09) — D2, D5

1. Install TripTab (iOS: Share → Add to Home Screen; Android: Install app). Sign in, open a holiday, enable *Offline expense capture*.
2. Fully close the app. Turn on aeroplane mode.
3. Launch TripTab from the home screen.
4. Add one expense in the capture form. Close the app, turn off aeroplane mode, and relaunch.

**Expected after PR-04:** Step 3 shows "You're offline" and the capture form, not a browser error page. Step 4 syncs exactly one expense, visible once in Expenses and History.
**Record:** whether iOS shows the offline page at all for a standalone launch, and any safe-area clipping.

### MAT-03 · System Back and swipe-back with open editors (TT-12, TT-02) — D1, D4, D5

1. Open Balances → Expenses → open an expense **without editing** → Android Back gesture or button / iOS edge swipe.
2. Repeat after **editing** the amount.
3. Repeat with *Record paid* (edited) and on its Review step.
4. On the Android PWA, repeat Back until the app would close.

**Expected after PR-09:** Step 1 closes the editor and stays on Expenses. Steps 2 and 3 ask "Discard…?", and *Keep editing* keeps every value. Step 4 never closes the app with unsaved edits without a prompt or a resumable draft.

### MAT-04 · App switching and OS tab discard (TT-07) — D2, D5, D6

1. Open a **saved** expense, change its name and amount. Switch to the camera app, take 10 photos, open two other heavy apps, and return after 5 minutes.
2. Repeat with a receipt draft after typing three manual lines.
3. Repeat with an edited payment.
4. Control: repeat with a **new** unsaved expense.

**Expected before PR-07:** Steps 1–3 lose the edits if the OS reloaded the page. Step 4 offers *Resume*.
**Expected after PR-07:** Every case either keeps the page or offers *Resume* with all values. If another device changed the record meanwhile, the merge view appears.

### MAT-05 · Keyboard focus on real devices and Safari (TT-01) — D1, D7, D8

1. iPad with a hardware keyboard (enable *Keyboard navigation* if required) and macOS Safari with "Press Tab to highlight each item" on: open Profile & app settings and Tab through every control, forwards then backwards.
2. In the expense editor, Tab to the end and wrap around; then Shift+Tab to the top.
3. On an iPhone with the on-screen keyboard, tap through the amount, name and date fields of a long receipt, and confirm that tapping a row selects that row (the earlier "pointer jump" defect must not return).
4. Check how `<summary>` disclosure markers render (they should be native triangles, not emoji).

**Expected after PR-12:** The focused control is always visible and not hidden by the sticky footer, and taps never activate a different row.

### MAT-06 · OS and browser text scaling (TT-05) — D1, D4, D8

1. Android: Settings → Display → Font size at maximum (and Chrome → Accessibility → Text scaling 200%).
2. iOS: Settings → Accessibility → Larger Text at maximum, then Safari AA → 200%.
3. Desktop Chrome, Firefox and Safari: default font size 32px (or the largest), browser zoom 200%.
4. On each, inspect the bottom tab bar, the holiday summary cards, the quick expense editor footer and the payment review.

**Expected after PR-14:** No overlapping or clipped labels, no horizontal page scroll, and all actions reachable. Record which settings actually change TripTab's text size on each platform.

### MAT-07 · Small screens, safe areas and orientation (TT-06, TT-17) — D3, D1, D4

1. On a 375×667-class phone, switch through all five holiday tabs. Note whether the selected section's heading is visible without scrolling.
2. On a notched or home-indicator phone in portrait and landscape: check the tab bar, editor footer, drawer and dialogs against the safe areas.
3. Open a bill and check the Bill/History tab bar spacing.

**Expected after PR-14:** Section headings are visible after tab switches, nothing sits under the home indicator or notch, and the bill tabs use the full width.

### MAT-08 · Live receipt recognition (accuracy and review) — S2, D1, D4

**Requires a funded key, so API costs apply.** Use only synthetic receipts: the corpus in `tests/fixtures/receipts/v1/images/` (BOGOF, coupon, item discount, foreign currency, comma decimals, long receipt, blurry amount, ambiguous dollar) plus printed copies photographed in poor light.

1. For each receipt, *Scan receipt* → wait for reading → compare items, prices, printed total and detected offers with the fixture's expected values (`corpus.json`).
2. Correct one wrong line manually, add one missing line (verifies OP-04 after PR-11), then save.
3. For BOGOF and coupon receipts, check the proposed offer review and the per-person shares.
4. Interrupt reading (aeroplane mode for 30 s) and confirm the draft and photo survive and reading resumes or offers retry.

**Expected:** No posting without review. Printed-total mismatches block Save until reconciled or acknowledged. Offers are reviewable. Record accuracy per receipt; this is the first real-model evidence for this build.

### MAT-09 · Camera, HEIC and file picker — D1, D4

1. *Scan receipt* opens the rear camera (`capture="environment"`). *Choose image* opens the gallery.
2. Capture an iPhone HEIC photo, a 12 MP Android photo and a very long receipt photo.
3. Deny camera permission, then retry.

**Expected:** The image is normalised to JPEG within limits with EXIF removed (README). The upload progresses with visible status. Permission denial is explained and recoverable. After PR-10, upload failures show a scoped, plain-language error with *Try again*.

### MAT-10 · Screen reader announcements — AT

With VoiceOver (iOS and macOS), TalkBack and NVDA, perform:
1. Sign up from an invite and join (TT-04: is "Join {holiday}" announced and focused after PR-08?).
2. Add an expense with a missing amount, press Save, fix it, and save (blocker announcement, then the "Saved" announcement).
3. Open a pending discount and press Save (after PR-01, the blocker is announced).
4. Trigger an expense conflict (two devices) and use the merge choices.
5. Go offline in the open app, then come back online (banner announcements; OP-10).
6. Delete an expense and use *Undo*.

**Expected:** Each state change is announced once, in plain language. Focus never lands on `<body>`. Dialog titles are announced on open.

### MAT-11 · Push notifications and photo share target — S3, D2, D5

1. Enable browser notifications. From a second account, add an expense to the shared holiday. Check that the notification title and summary contain no amounts, notes or emails (README guarantees).
2. Tap the notification with an editor open: the editor and its values must survive.
3. From the OS Photos app, share one receipt photo to TripTab, choose the holiday, and confirm it opens as an editable receipt with no automatic posting.

### MAT-12 · Standalone exit and account email flows — S3, D2, D5

1. In the installed PWA, start a new expense and close the app from the app switcher. Reopen it: *Resume* should be offered (F-18). After PR-07, repeat with a saved-expense edit.
2. *Forgot password* → receive the email (Resend on staging) → reset → other sessions are signed out → the editing device follows the re-auth flow (TT-07 / OP-05 expectations).
3. *Send verification email* → verify → the status text updates (TT-16 contrast check in light and dark).

---

## Results template

| MAT | Device / env | App SHA | Step | Result | Notes / evidence |
|---|---|---|---|---|---|
| MAT-01 | S1 | | 1 | | |
