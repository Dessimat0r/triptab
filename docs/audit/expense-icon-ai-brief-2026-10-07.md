# Brief for Sol: reliable expense icons from receipt reading

Prepared 7 October 2026 against `7c35d35`. Implementation brief only; no code changed yet.

## Problem

Expense icons often come out wrong or fall back to the generic indigo **Receipt** icon, most of all after an AI receipt scan.

## Root cause (verified in source)

1. **The AI never chooses the icon.** Neither the transcription schema nor the prompt in `lib/receipt-ai.ts` asks for an expense type or icon. The connector proposal schema in `lib/receipt-proposals.ts` does not ask either. The icon comes only from `inferExpenseIcon()` in `lib/expense-icons.ts`, a client-side keyword matcher that reads `title` and `items[].name`.
2. **The matcher reads the wrong evidence after a scan.** The AI is told to return `title` as the merchant name and `item.name` in the receipt's original language. The English `translatedName` is stored in `item.translations` but is never passed to the matcher (`IconReceipt.items` is `{ name }` only). A merchant name ("Casa Lucio") plus Spanish/Italian/Japanese item names rarely match any English keyword.
3. **Rule order produces wrong picks.** The first matching title rule wins, and the matcher counts keyword hits per item.

Running the current `inferExpenseIcon` against realistic inputs:

| Input (title / items) | Current result | Expected |
| --- | --- | --- |
| Casa Lucio / Huevos rotos, Solomillo, Vino tinto | Receipt (fallback) | Meals |
| Da Enzo al 29 / Cacio e pepe, Carbonara, Acqua frizzante | Receipt | Meals |
| 一蘭 / ラーメン, 替玉 | Receipt | Soup or Meals |
| La Venencia / Fino, Manzanilla, Mojama | Receipt | Wine or Cocktails |
| Horno San Onofre / Pan de pueblo, Napolitana | Receipt | Bakery |
| Café de Flore / Croque monsieur, Salade niçoise, Steak frites | Coffee | Meals |
| Restaurante Bar El Paso / Paella | Cocktails (`bar` beats `restaurante`) | Meals |
| Shell / Coffee, Diesel, Diesel | Fuel | Fuel ✓ |
| Boat tour (manual) | Receipt | Ferry or Exploring |
| Food shop (manual) | Shop | Groceries |

## Goal

After an AI scan, the automatic icon reflects what the expense actually was, whatever the receipt language. Manual entry, user-chosen icons and saved records behave exactly as they do now.

## Must keep (current behaviour)

- **A user's chosen `icon` always wins** and survives scans and proposals (`receiptProposalEditor` keeps `editor.icon`). "Automatic" in the picker still clears it (`icon: undefined`).
- **Saved records are never rewritten.** Existing expenses and drafts without the new field keep resolving through `inferExpenseIcon` as today. No migration, no backfill.
- **The icon is cosmetic.** It must not affect `receiptEditableValue`, reconciliation, the readiness checklist or Save gating. A server-supplied suggestion must not count as unsaved work in the discard guard (`EditorWork` in `components/trip-app.tsx`).
- **Stable catalogue IDs.** Use only `ICON_CATALOG` IDs and `ICON_BACKGROUNDS`. The `expenseIconSchema` stays strict.
- **The manual, offline and no-AI paths work** with the improved local matcher only. A manual expense never calls a model.
- **Existing tests** in `tests/expense-icons.test.ts` and `tests/receipt-editor.test.ts` (icon cases) and the activity-history icon test pass unchanged.

## Implementation

### 1. Ask the model for an expense type (server)

`lib/receipt-ai.ts`:
- Add `expenseIcon: { symbol: <ICON_CATALOG id enum> | null, confidence: 'high'|'medium'|'low'|null }` to `receiptTranscriptionSchema`. Add it to `transcriptionJsonSchema` and to its `required` list (strict output needs every key).
- Add one line to `INSTRUCTIONS` saying roughly: *Choose expenseIcon.symbol for the kind of expense: what was bought and the type of merchant, judged from the whole receipt and not a single line, e.g. a restaurant bill with wine is Meals. Use null when unclear. This only sets a display icon.*
- In the function that applies a transcription to a draft (around lines 430–500), store the result as `suggestedIcon` only when `symbol` is non-null and confidence is not `low`. The background comes from the symbol's group (export a `defaultBackground(symbol)` from `lib/expense-icons.ts` built on `groupColors`/`TITLE_RULES`, so the colours match today's).

`lib/receipt-proposals.ts` (connected ChatGPT `update_receipt_draft`): accept the same optional `expenseIcon` field, so assistant-driven drafts get the same suggestion. The external prompt in `lib/receipt-chatgpt.ts` gets one short sentence asking for it.

### 2. Store it separately from the user's choice (model)

- `lib/model.ts`: add `suggestedIcon: expenseIconSchema.optional()` to both `expenseBaseSchema` and `draftSchema`. Carry it from draft to expense on save, wherever `icon` is copied in `components/trip-app.tsx` (`storeEditorReceipt` and the save path).
- `lib/store.ts` ~line 698: add `'suggestedIcon'` to `knownFields`.
- `lib/notifications.ts`: do **not** add `suggestedIcon` to the "name or icon" activity entry. A scan updating it is not a human change.
- `receiptProposalEditor` (`lib/receipt-processing.ts`): take `suggestedIcon` from the incoming proposal and keep `icon` from the editor.

### 3. One resolution order (`lib/expense-icons.ts`)

Extend `IconReceipt` with `suggestedIcon?` and `titleSource?` (from `fieldSources.title`), and let items carry `translations?`. Then `resolveExpenseIcon` becomes:

1. `icon` (user choice)
2. if the title was typed by a person (`titleSource === 'user'`) and a title rule or label matches it → that match. A renamed expense such as "Taxi home" must not keep a stale "Meals" suggestion.
3. `suggestedIcon` (AI)
4. `inferExpenseIcon` (local matcher, improved below)

`ExpenseIconBadge` and `ExpenseIconPicker` must pass the new fields through, and the `useMemo` deps must include them.

### 4. Improve the local matcher (manual entries and fallback)

- Score item **`translations` values as well as `name`**, so English reading names count.
- Fix title precedence: rank by the most specific match instead of first-rule-wins. At minimum, restaurant/meal terms beat `bar`/`cafe` when both appear, and the title "Hotel … Bar" with only drink lines gives a drinks icon.
- Add common terms: tapas, osteria, brasserie, trattoria (in items), izakaya, ramen, tabac, food shop → Groceries, boat/tour.
- When item hits are spread across categories, prefer the group with the most hits over a single stray line.

### 5. UI: picker and badge (mobile first)

No layout redesign. Wording changes only, which must fit the current components:
- The editor trigger's subtitle (`showLabel`) says `Automatic · Meals · Orange`, as today. When the AI suggestion was used, the picker preview's small text says **"Suggested from the receipt reading"** instead of "Suggested from this receipt".
- Keep the trigger to one subtitle line that wraps cleanly (`overflow-wrap: anywhere` already). No new chips or badges in the expense list row. The 45 px badge and the draft thumbnail overlay (`.draft-visual`) stay as they are.
- Check that the picker modal at 320 × 740 and 390 × 844 has no horizontal scroll, that 44 px targets are kept and that the 3/4/5-column grid breakpoints still apply. Check desktop at 1440 × 900.

## Tests to add

- `tests/expense-icons.test.ts`: the table above as cases. Also a translated-name case, the precedence order (user icon > user-typed title > AI suggestion > matcher) and a renamed title overriding a stale suggestion.
- `tests/receipt-ai.test.ts`: a transcription with `expenseIcon` sets `draft.suggestedIcon`. A `low` or `null` value does not. A user `icon` is untouched by a scan.
- `tests/receipt-editor.test.ts`: a scan that only sets `suggestedIcon` does not mark the editor dirty. The value carries through to the saved expense.
- Browser (`tests/browser/expense-layout.spec.ts` viewports, or `receipt-upload.spec.ts` with the mocked AI response): a processed receipt shows the suggested icon in the list and editor at 390 px and 1440 px. The icon picker has no horizontal overflow at 320 px.

## Out of scope

- A separate AI call just for the icon, or classifying manual expenses with a model.
- Re-inferring icons for existing saved expenses.
- New icons or colours in the catalogue.

## Done when

`npx tsc --noEmit`, `npm run lint`, `npm test` and the Playwright browser specs pass, with the known `pwa-live-refresh.test.ts` failures unchanged. The cases in the table above resolve as expected.
