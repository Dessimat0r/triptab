# TripTab UX recovery release candidate

The ordinary flow is image or amount → people → visible shares → Save. No per-item allocation is required. Merge and deployment require owner approval.

## Changes

- Native extraction and connected-tool instructions accept checkout screenshots, order summaries and purchase photos. Missing merchant/date/time is accepted; unknown metadata stays unknown. A neutral bill label supplies the display name. The ledger's default recording date is explicitly labelled as the date added when the purchase date is absent. Partial items survive for correction; unreadable prices still block posting.
- New scanned, imported and manually added lines receive equal cost shares. Participant changes update marked defaults, preserving custom and historical allocations. Purchased quantities remain evidence, independently of cost shares. **Split all equally** resets exceptions with one confirmation. Totals appear beside the participant choices.
- Bill creation has two main actions. Image-only attachments, notes and uncommon options remain accessible through disclosures. Clean reconciliation details collapse to one expandable row; item editors and split methods open only when needed. Receipt review keeps the phone keyboard down.
- Drawer bill rows support swipe-left to reveal Delete. Their menu and the open bill's menu use the same operation. Image-only bills now use recoverable deletion instead of the empty-bill discard endpoint, which previously refused them. Successful deletion removes the active row; failures show an error without a success notice. Undo and the existing 30-day recovery remain available.
- Shared bills retain the approved policy: if another account can open the bill, Delete explains why its records must remain and offers **Remove from my list** directly. Server permissions, notifications, audit history, revision checks and deletion tombstones remain authoritative.

## Interaction comparison

Counts cover app button presses, excluding text entry and the operating system's file picker. Baseline: main `4429749`. Optional notes and advanced settings are excluded.

| Representative journey | Before | Candidate |
| --- | --- | --- |
| Clean image from Expenses through Save | 4 | 3 |
| Allocate ten imported items | One bulk allocation action, or individual overrides | 0 default allocation actions |
| Simple manual bill from the phone drawer | ≤5 | ≤5; same short path |
| Delete from an already open bill | 4 through options/disclosure | 3 through its menu |
| Delete starting in the drawer through bill settings | 6 | 4 through row menu, or 3 taps + swipe |
| Delete an image-only bill | Refused by discard endpoint | Works through either direct route |

The baseline already contained a drawer menu action. This release repairs its image-only failure and adds the missing swipe interaction; it does not claim that every previous deletion route needed settings.

## Verification and evidence

- `tests/ux-recovery.test.ts`: four-item checkout with no merchant/date; omitted/unknown metadata; ten-item equal splits; deterministic pennies; participant changes; explicit exceptions; reset; scoped discount preservation; settled/posted obligations unchanged; partial image correction.
- `tests/browser/ux-recovery.spec.ts`: complete ten-item upload/save at 320, 390 and 1440px, custom override preservation and reset, touch swipe, keyboard menu, image-only deletion, reload persistence, Undo, shared-bill archive alternative, permission refusal and malformed-success refusal. Deletion uses production API, SQL, revision and audit code with isolated D1/R2 fixtures. Chromium uses real dispatched touch input; WebKit also verifies the pointer gesture handlers.
- Existing regression suites retain BOGOF/manual discount, receipt reconciliation, reasoned Save Anyway, two-account permissions/notifications, concurrent edits, offline sync, financial-format refusal and settled-expense checks.
- Type check, production build, lint and the full unit/integration and Chromium/WebKit suites are the release gates. The exact PR commit must pass the existing CI `verify` gate before approval.

Screenshots: [Add bill, 320px](ux-recovery/add-bill-320.png), [split and totals, 320px](ux-recovery/split-bill-320.png), [drawer swipe deletion](ux-recovery/drawer-swipe-delete.png).

Verification limits: provider responses are deterministic fixtures; no paid live vision request or production financial record was used. Physical phones and a genuinely installed PWA were unavailable. Browser suites block service workers; offline and compatibility boundaries are additionally exercised by their existing integration tests. Previous-bundle browser tests need `TRIPTAB_PREVIOUS_URL` and are reported separately when unavailable.
