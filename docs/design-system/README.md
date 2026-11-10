Payminto is a self-hosted clearing layer on NEAR.
Owners give AI agents bounded Budgets, each paid Call is checked against rules, and many Calls settle as a few USDC transfers.
Build every Payminto screen as a clearinghouse console: cool paper surfaces, one cobalt accent for action, and three quiet colours that only mean settled, waiting or refused.

## Content voice

Write plain, exact statements of what happened.
Use sentence case for titles, buttons and labels.
Address the owner as "you" and name agents and Payees by their own names.
Never use emoji, exclamation marks or em dashes; use a plain hyphen.

Use these product words and no synonyms for them.

| Word | Meaning |
|---|---|
| Budget | The bounded spending permission an owner gives an agent. |
| Call | One paid request made by an agent. |
| Refusal | A Call stopped by a rule, always with a stated reason. |
| Settlement batch | The group of Calls cleared together. |
| Proof | The check of one Call against an on-chain root. |
| Payee | The account that receives payment. |

State the reason for every Refusal in one sentence, for example "The Call was over the Budget's limit per Call."
Put "No money moved" next to every Refusal.
Label buttons with the action and its object: "Stop this Budget", "Open Proof".
Keep technical words such as Merkle or leaf inside tooltips and Proof details, not in row labels.

## Foundations

### Color

Set page ground in `background` and panels in `card`, with `foreground` for primary text and `muted-foreground` for secondary text.
Use `primary` only for action, links and the focus ring.
Use `positive` only for settled, `warning` only for waiting and `negative` only for refused.
Pair each with its soft ground: `positive-soft`, `warning-soft`, `negative-soft`.
Never tell status by colour alone; StatusPill always carries the word.
Use `subtle` for quiet text a step below `muted-foreground`; it holds 4.5:1 on every ground in both themes.
Keep `flow-1` to `flow-5` and the `chart-` tokens for charts only.
The dashboard contains one exception to the three-colour rule: the "Over a limit" chip on a Refusal uses `warning`.
Do not extend that exception.

Light is the primary theme and dark is the second.
Dark fills lighten the accent, so text on `primary` uses `primary-foreground` and text on `destructive` uses `destructive-foreground`, never white.

### Type

Set interface text in IBM Plex Sans through `--font-sans` and start from `body-sm` at 14px.
Set amounts, account IDs and hashes in IBM Plex Mono through `--font-mono`.
Use weights 400, 500, 600 and 700 in sans, and only 400 and 500 in mono.
Keep the body feature `"ss02" 1` on.
Use one `page-title` per page and `panel-title` for each panel.
Use `overline` only for section labels in BatchSummary.

### Space, radius and borders

Space with the `space-` tokens on the 4px base.
Use `radius-md` for controls, `radius-xl` for panels and `radius-full` for pills and meters.
Separate panels and rows with 1px `border` lines.
Keep shadows to `shadow-xs` on controls and `shadow-lg` on Dialog, Sheet and menus; panels have none.

### Focus and motion

Draw focus as a solid 2px `ring` outline with a 2px offset, which holds at least 7:1 on `background` and `card` in both themes.
Keep motion to 150 to 250ms, ease-out, opacity and small shifts.
Remove motion under `prefers-reduced-motion`.

## Iconography

Use lucide icons only, as 24px-grid strokes that inherit `currentColor`.
Draw at 12px in Timeline dots, 14px in copy and link actions, 16px in buttons and rows, 18px in the bottom navigation, and 24px in ProofPanel seals.
Use stroke width 2, or 1.8 and 2.2 for inactive and active navigation.
Mark decorative icons `aria-hidden` and give icon-only buttons an `aria-label`.
Standard meanings: `shield-ban` for a Refusal, `triangle-alert` for risk, `copy` for copy, `external-link` for the NEAR explorer, `circle-check` for a verified Proof.

## Logo

There is no logo file in scope, so set the name "Payminto" in plain type.
The dashboard has a favicon only; do not enlarge it into a logo.

## Layout grid

Cap page content at 1320px and center it.
Use gutters of `space-4` below 640px, `space-6` from 640px and `space-8` from 1024px.
Stack panels with a `space-5` gap.
Show the sidebar from 1024px and a five-item bottom navigation of 64px plus safe area below it.
Use a 9rem label column for detail fields once the field list itself is 28rem wide, and stack label over value below that, so a narrow side panel never squeezes an account id.

## Responsive rules

Design at 375px first and check 768px and 1024px.
Reflow columns; do not shrink type.
Turn tables into stacked CallRow lists below 768px.
Move Dialog content to a bottom Sheet below 640px when it holds a decision or a form.
Keep the wide two-panel Proof and BatchSummary layouts as a single column below 620px of container width.

## Mobile rules

Make every touch target at least `touch-min` (44px); primary actions are 48px.
Give a 24px icon button a 44px box on coarse pointers.
Keep the deciding action in a sticky footer with `padding-bottom: max(12px, env(safe-area-inset-bottom))`.
Offset fixed navigation and Sheets by the same safe area.
Set input text to 16px below 768px so iOS does not zoom.
Use `inputmode="decimal"` for amounts.
Never hide an account ID or amount that a person is approving.

## Data-display rules

Show every amount with its unit, using Amount.
Never round an amount; show the exact atomic value, and say in words when a figure is an estimate.
Right-align amounts in columns and keep numerals tabular.
Show a missing value as `-`.
Treat account IDs as up to 64 characters: wrap them when a person must check them, and truncate the middle elsewhere, always with copy.
Show the status word in every row; StatusPill has exactly three values.
Filter ledgers by status first, and keep filter state visible above the table.
Give times in monospace, with the exact timestamp available.

## Reference note

Interaction patterns were informed by public screens from Cash App, Venmo, Starling, Lloyds, Lightyear, Stripe, Shopify and Square, as inspiration only.
No brand look or copy was taken from them.

## Not synced

Previews are static HTML using the tokens; there is no React bundle.
The 13 other shadcn parts in use (alert dialog, dropdown menu, label, popover, progress, scroll area, select, separator, skeleton, sonner, switch, textarea and tooltip) have no card and follow the dashboard's source.
Fonts are hosted Google faces, so `type.fonts` is empty and only the families are named.
