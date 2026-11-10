RefusalReason explains why a Call was stopped and states that no money moved.

## Use
Use it in the Refusals list, Budget detail, and on a refused Call.

## Provide
Provide the rule title, kind, rule code, agent, Payee, attempted amount, remaining Budget, plain sentence, retry hint, Budget name and time.
Optionally provide one owner action that resolves the Refusal, such as "Move credit into this Budget".

## Rules
Always include "No money moved" and the plain reason in one sentence.
Show the rule code in mono next to the attempted amount and the remaining Budget, as decision 8 requires; the plain sentence still leads.
State the retry hint in one sentence: never, after a time, after settlement, add escrow, or sign a new voucher.
When escrow is short (NET_EXPOSURE counts escrow only) and the owner has hub credit, offer "Move credit into this Budget".
Kinds are "Attack", "Over a limit" and "Budget not usable".

## Do and do not
Do name who tried to pay whom.
Do not write "error" or "failed"; a Refusal is the system working.
