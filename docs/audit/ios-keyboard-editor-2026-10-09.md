# Expense editor under the iOS keyboard

9 October 2026 · Base: `main` at `598b88d`

## The defect

On an iPhone, typing in the expense editor showed the expenses list below the Total / Save bar and through the keyboard. The reported screenshot came from an iPhone 16/17 Pro (402 × 874 pt), with the receipt question focused.

## Cause

Measured from the screenshot:

- The editor surface ends at 478 pt. The 396 pt below it, the keyboard and its AutoFill bar, shows the trip page.
- That page area is the undimmed page background, `#0f1424` against `--bg` `#0e1526`. Seen through the overlay's backdrop (`#040812b8`, blurred), it would be about `#070c18`. The strip was outside the overlay altogether, not showing through it.
- The editor's heading was above the top of the screen.

iOS opens the keyboard by shrinking only the visual viewport. It then pans that viewport down to keep the focused field in view. Every overlay was `position: fixed; inset: 0` and sized to `100dvh`, so it stayed attached to the layout viewport. The pan carried the whole editor up by the keyboard's height. The page below the layout viewport filled the gap, and iOS 26's translucent keyboard shows it. The sticky footer behaved correctly: it is the editor's bottom edge.

`overflow: hidden` on the root does not stop this scroll. Nothing in the app tracked `visualViewport`. `100dvh` does not respond to the keyboard. The WebKit sticky-element bug cited in the first audit does not apply, because the footer sticks inside `.editor` and not to the viewport.

## Fix

- **`components/visual-viewport.ts`:** every `ModalA11y` overlay publishes `--viewport-top`, `--viewport-height` and `--keyboard-inset` from `visualViewport`. It follows them through the keyboard opening and closing, and resets when iOS 26 leaves a stale offset after dismissal. It stands down while the page is pinch-zoomed.
- **`.overlay`:** moves down by the pan and stays screen-tall. A transparent bottom border the height of the keyboard keeps content above the keyboard, while the overlay's own background still covers the page behind it.
- **Phone editor:** the height is the visible area, so Total / Save sits directly above the keyboard. The backdrop is the editor's surface, so nothing else shows behind the translucent keyboard.
- **Centred dialogs:** payment, receipt upload, confirmation, icon picker, photo and the others cap their height at the visible area.
- **Focus:** when the keyboard shrinks the editor after focus has moved, `editor-footer-reveal.ts` scrolls the focused field above the footer before the next paint.
- **Safe areas:** the phone footer clears the home indicator when the keyboard is closed, and the phone heading clears the status bar.
- **AutoFill:** free-text notes and questions set `autocomplete="off"`, so iOS stops offering contacts.

## Verification

- The new `phone keyboard` tests in `tests/browser/expense-layout.spec.ts` report iOS's keyboard geometry (396 pt keyboard, with and without the pan). They check that the overlay spans the screen, that the editor ends at the keyboard with Save above it, that the focused field stays visible, and that dismissal restores the full screen. All three tests fail on the base and pass now.
- Full Chromium browser suite: 126 passed. Unit tests: 4 notification tests fail, identically on the base. Type-check passes, and lint shows only existing warnings.
- **Still needs a physical iPhone.** No desktop engine shows the iOS keyboard, and WebKit is not installed here. Check in Safari and the installed app:
  - the receipt question, an item amount and the expense name, with the keyboard opening, switching fields and closing;
  - that nothing but the editor is visible above or behind the keyboard;
  - that Save stays above the keyboard;
  - that no offset remains after closing.

## Follow-up: the page still showed on a device

After #46 was deployed, a screen recording (iPhone, decimal keypad, amount field) still showed the expenses list below Total / Save, scrolling under the keyboard. The list was crisp and undimmed, so it was outside the overlay. The editor itself sat correctly above the keyboard.

Two explanations fit the recording, and the device's measurements were not available to tell them apart:

- The app was still running the previous build. The service worker caches no app code, but an installed app left open keeps the old page.
- WebKit does not paint a fixed element beyond the layout viewport. The overlay's extension behind the keyboard is then clipped, and the page shows there anyway.

The fix no longer depends on that painting:

- **Phone editor:** while it is open, the page (`.shell`) is hidden and the page background matches the editor. Nothing of the page is visible around the editor anyway, so only the editor's colour can show behind the keyboard.
- **Other dialogs:** while a keyboard is open over one, `data-keyboard-open` on the root element hides the page. The page returns when the keyboard closes.
- **`?viewport-debug`:** shows the visual viewport, window and overlay measurements on the device for the rest of the tab. It makes the next physical check conclusive.
