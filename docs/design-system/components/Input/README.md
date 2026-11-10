Input collects one short value, with a visible label above it.

## Use
Use it for Budget names, limits and account IDs.

## Provide
Provide a label, a `value`, optional help text, and `aria-invalid` with an error sentence when invalid.

## Rules
Set account IDs and amounts in mono.
Below 768px use the 44px touch height with 16px text.
State errors exactly: "USDC has 6 decimal places."
The `input` border holds 3:1 against every ground in both themes; still never drop the label.

## Do and do not
Do use `inputmode="decimal"` for amounts.
Do not use the placeholder as the label.
