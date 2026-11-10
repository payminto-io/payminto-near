TxFlow shows the exact NEAR transactions an owner is about to sign, then follows them to final or failed.

## Use
Use it for every owner action on chain: open a Budget, deposit, move credit into a Budget, revoke, reclaim, and a merchant refund.
Use it for a gasless action too, where the wallet signs one call and a relayer sends it.
Use it for a DAO proposal and for a vote on one, with the call the DAO would run shown beneath the transaction.
Do not use it for a Call; agents sign Calls, owners do not.

## Provide
Provide a title naming the action and its object, one sentence on what happens and what does not, plain summary rows, the transactions from the shared builders, the confirm label, and the account that must sign.
For a gasless action also provide the heading that says the relayer sends it, who pays the gas, and the function that runs the flow and reports each step.
For a proposal also provide the inner call, decoded, under its own heading.
Provide a reason when the action cannot be sent as things stand, and the confirm button is disabled with that reason above the review.

## States
Review lists each transaction with receiver, method, arguments, attached deposit and gas, in the order they are sent.
Pending says who is being waited on: the wallet, the relayer or NEAR, and keeps the sheet open, because closing it would hide the outcome.
Final shows each transaction hash with copy and explorer link, and the note for what changed.
Failed names the transaction and the reason from NEAR, and says what was returned.
Sent, not final yet shows the transaction and offers "Check again", which reads and never sends.
The result is unknown is for a transaction nobody could vouch for: it asks for a check of the thing it changes and offers no retry.
A cancel in the wallet returns to Review with a note; it is not an error.

## Rules
Check the connected account against the signer before anything is sent, and refuse a different account with a plain message.
Show the arguments exactly as sent, with a nested `msg` expanded, so the review is the transaction and not a paraphrase.
Say "Final" only for what was read from NEAR, never on a relayer's word.
Keep the flow at the level of the screen with TxFlowProvider, so it stays open when the action removes the control that opened it.
Set account ids inside a sentence with AccountSentence, so they are never broken at a hyphen.
Below 640px it is a bottom sheet with a full-width 44px primary button, and the footer is sticky only there.
Truncate hashes in the middle and keep the last 8 characters.

## Do and do not
Do say "Nothing was sent" after a cancel.
Do say what to do next in every failure.
Do not show "Success" before NEAR reports the transaction final.
Do not offer "Review and try again" when the result is unknown.
