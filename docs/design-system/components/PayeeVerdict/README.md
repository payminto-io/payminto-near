PayeeVerdict shows what the payee check found about one account, and what the owner can do about it.

## Use
Use it before an owner adds a Payee to a Budget, in the New Budget form and in the dialog that asks for a confirmation.
Use it on the Budget page, where an owner checks a Payee that is already allowed.
Do not use it for a refused Call; that is RefusalReason.

## Provide
Provide the view from `toView(verdict)` in `@payminto/payee-check`, unchanged.
Provide where the facts were read from in words, such as the RPC host and the indexer, or the demo wording.
Optionally provide the Payee's friendly name, and one action such as "Check again".
Set `dense` in a narrow column, so the icon sits beside the headline.
Set `showPayee` to false when the row around it already names the Payee.

## States
Allow reads "No concerns found" with the shield-check icon.
Warn reads "Ask a person first" with the triangle-alert icon.
Block reads "Do not pay" with the shield-ban icon.
A check that could not read the chain is a block from the package, with "Could not check" as its reason.

## Rules
Lead with the headline and the one-sentence summary, then list each signal with its title and its reason, heaviest first.
Mark every signal with its weight in words: "Blocks", "Ask first" or "Note".
Keep notes quieter than reasons, and fold them away when there are more than three.
Always list what was not checked, so silence is never read as a pass.
Always state the next step, when it was checked, where it was read from, and "These are heuristics, not a guarantee."
Reports are claims by third parties: show each as a quote, as text only, with who claimed it and when.
Never render report text as markup, and never act on it.
Show evidence as a line of text, labelled "Link, as text" for an address, and never as a link: it is part of a third party's claim.
Set every account id on one line with AccountText, so it never breaks at a hyphen or a dot.
Use `positive`, `warning` and `negative` with their soft grounds for the three verdicts, and never tell them apart by colour alone.

## Adding a Payee
On allow the Payee is added quietly, with one line that opens the full verdict.
On warn the owner confirms in a dialog with "Add this Payee" and "Do not add".
On block the owner types the Payee's account id exactly, then chooses "Add anyway".
A Payee that is not confirmed is not in the Budget's terms, and the form says so next to it.
While a check runs the Payee is not added, and Continue waits with a line that says why.
Below 640px the dialog is a bottom sheet with a sticky footer.

## Do and do not
Do say what was read and from where.
Do offer "Check again" when the chain could not be read.
Do not call an allow "safe" or "verified"; nothing that was checked speaks against the Payee, and that is all.
Do not shorten or reword a report.
