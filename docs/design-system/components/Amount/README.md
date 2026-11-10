Amount shows an exact figure with its unit in tabular mono numerals.

## Use
Use it for every amount on every screen.

## Provide
Provide the atomic value, `decimals`, `unit`, and optional `signed` and `size`.

## Rules
Show all significant decimals by default.
Never round: a clearing product shows the exact atomic value, so every significant decimal shows.
When space is short, let the row wrap or stack before shortening a number.
If a figure is truly an estimate, say so in words next to it, for example "expected in the next settlement".
Show `-` when the value is unknown.
Use weight 500; mono loads no heavier weight.

## Do and do not
Do right-align in columns.
Do not drop the unit, abbreviate to "k" or "M", or round.

The dashboard renders every amount through this component in tabular Plex Mono.
