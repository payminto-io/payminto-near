ApprovalSheet confirms one Call on a phone with explicit From, To, Amount and Rule rows.

## Use
Use it when a rule asks the owner to decide, such as a Call over a limit.

## Provide
Provide the agent and Payee accounts, the exact amount, the rule, an optional risk message, and approve and refuse handlers.

## Rules
Lead with a large Amount.
Wrap the To account in full; never truncate what is being approved.
Keep actions in a sticky footer: Refuse at 44px and Approve at 48px.
Add `max(12px, env(safe-area-inset-bottom))` beneath them.
Show the risk block before the actions, on `warning-soft`.
Disable Approve while submitting and show progress in the button.

## Do and do not
Do let the body scroll while the footer stays fixed.
Do not place Approve where a dismiss tap could land on it.
