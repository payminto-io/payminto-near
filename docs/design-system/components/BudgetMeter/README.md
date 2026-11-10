BudgetMeter shows what is settled, waiting and remaining in a Budget.

## Use
Use it at the top of Budget detail and in compact form in lists.

## Provide
Provide `settled`, `waiting` and `limit` as exact amounts.

## Rules
Lead with the remaining amount.
The bar is `primary` up to 75 percent used, `warning` above 75 and `negative` above 90.
Segments are separated by a 2px gap, and the waiting segment is hatched in the tone colour, so each stripe holds at least 5.3:1 against the track in both themes.
The legend always shows the waiting amount as well.
Set `role="meter"` with a label and values.

## Do and do not
Do show used percent and the limit in words.
Do not show only a bar.
