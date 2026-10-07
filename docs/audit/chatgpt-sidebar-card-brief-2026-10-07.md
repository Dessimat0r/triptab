# Brief for Sol: hide the ChatGPT setup card once ChatGPT is connected

Written 7 October 2026 against `main` at `7c35d35`. Implement it on one branch with one PR.

## The problem

The sidebar always shows the "Your assistant, optionally." card, including after the user has connected ChatGPT. It still tells them to "Link your ChatGPT identity in Your account", which is now out of date. On a phone the card also takes up a large part of the 250 px drawer.

## Root cause

`components/trip-app.tsx:2110-2122`: the `.account-note` block inside `.side-bottom` is rendered with no condition at all. Nothing in it reads connection state. Two connection signals already exist in the same component:

| Signal | Source | Already used at |
| --- | --- | --- |
| ChatGPT identity linked | `profile?.chatgptConnected \|\| profile?.authMethod === "chatgpt"` | `trip-app.tsx:1906` (passed to the receipt chat as `connected`) |
| ChatGPT plan connected for receipt processing | `receiptAI?.accountId === profile?.id && receiptAI.provider === "siwc" && receiptAI.connected` | `receiptAI` state, `trip-app.tsx:256`, refreshed by `refreshReceiptAIStatus` and `useLiveRefresh` |

Both signals refresh on their own. `profile` updates through `onSaved` from the account panel (link and unlink) and through live profile refresh, and `receiptAI` refreshes on the `triptab:receipt-ai-settings` event (`trip-app.tsx:319`). If the card is derived from them during render, it updates without a reload.

## What to build

1. **Derive one flag** next to the other derived values in `Home`, rather than adding new state:
   ```ts
   const chatgptConnected = !!(profile?.chatgptConnected || profile?.authMethod === "chatgpt")
     || (!!receiptAI && receiptAI.accountId === profile?.id && receiptAI.provider === "siwc" && receiptAI.connected);
   ```
   Reuse it at `trip-app.tsx:1906` only if the meaning stays the same there. That prop is about the identity link only, so leave it alone if in doubt.

2. **Not connected (including signed out and while `profile` is still loading):** keep the current card exactly as it is: same copy, same `How to connect` button, same styles. Don't change it.

3. **Connected:** replace the card with a compact status row in the same place, above the `.personal` account button:
   - Sparkles icon, then the text "ChatGPT connected" (use `<strong>`, with no paragraph of instructions).
   - A `textbutton` labelled "Help" (or "Using ChatGPT") that runs `setHelp(true)`. **This must stay.** The help modal holds the "Copy receipt-reading prompt" action and the tool-enablement steps. When a trip has drafts, the sidebar is the only place that opens it, because the receipts empty-state button (`trip-app.tsx:1767`) only appears with zero drafts.
   - Optional: if the copy needs to remind users that tools must be enabled per conversation, put it in the help modal, not in the sidebar.
   - Give it a new class (for example `.account-note.connected` or `.assistant-status`). Don't restyle the existing `.account-note`.

4. **Don't change behaviour anywhere else.** Linking and unlinking stay in the account panel. The plan connection stays in receipt AI settings. The `?connect=chatgpt` link flow (`trip-app.tsx:441`, modal at about `:3104`) and the `chatgpt_plan` return handling stay as they are.

### Related item (include it if it's small, otherwise leave it out)
The receipts empty state (`trip-app.tsx:1758-1768`) has a button labelled "Connect ChatGPT or Codex", which is stale in the same way. When `chatgptConnected` is true, relabel it "How to use ChatGPT or Codex". It should still open the same help modal.

## Layout requirements (mobile first)

The sidebar is a fixed drawer: it is hidden below 900 px and opened by `.mobile-menu`, and it is 250 px wide with z-index 40 below 700 px. See `app/globals.css` around lines 96, 1265, 2143, 2246 and 2261.

- **Mobile (390×844 and 360×640):** the connected row is one line, or two at most, with no horizontal overflow at 250 px drawer width. The Help button's tap target is at least 44 px tall (use padding, not the font size). The trip list and the `.personal` button must not move or overlap compared with today. On a 360×640 viewport the account button must still be fully visible without scrolling the drawer.
- **Desktop (1280×800) and the 1150 px breakpoint (210 px sidebar):** the row fits inside the sidebar padding, and the account button stays at the bottom (`.side-bottom` keeps `margin-top: auto`).
- **Dark mode:** add the new class to the `prefers-color-scheme: dark` rule that already styles `.account-note` (about `globals.css:2332`), so it uses `var(--surface-raised)` and does not show a white box.
- Keep using existing tokens (`--line`, `--muted`, `--primary`) and don't add new colours.

## Tests

Add `tests/browser/sidebar-assistant.spec.ts`. Base its fixtures on the route-mocking pattern in `tests/browser/expense-layout.spec.ts` (`/api/profile`, `/api/receipt/ai-status`, `/api/ledger`).

1. Profile with `chatgptConnected: false` and status not connected: the card text "Your assistant, optionally." is visible, and "How to connect" opens the dialog titled "Connect ChatGPT or Codex".
2. Profile with `chatgptConnected: true`: the setup text is absent, "ChatGPT connected" is visible, and Help opens the same dialog, which still contains "Copy receipt-reading prompt".
3. Profile not linked, but ai-status `{ provider: 'siwc', connected: true, ... }`: the connected row is shown.
4. Run cases 1 and 2 at 390×844 (first open the drawer with the `.mobile-menu` button, aria-label "Open holidays") and at 1280×800. In each, check that `.personal` is in the viewport, that `document.documentElement.scrollWidth <= innerWidth`, and that the Help button's bounding box is at least 44 px tall on mobile.

Then run `npm run lint`, `npx tsc --noEmit`, `npm test` and `npm run test:layout`. All of them must pass.

## Acceptance

- Once ChatGPT is connected (by identity link or plan), the sidebar no longer tells the user to link ChatGPT, and this happens without a page reload.
- Unlinking in Your account brings back the original card without a reload.
- The help modal and its copy-prompt action can still be reached from the sidebar in both states.
- No layout regression at 360, 390, 900, 1150 or 1280 px widths, in light or dark mode.
