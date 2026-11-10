Proposals lists the owner DAO's proposals that concern one Budget, each in plain words, with the votes so far and the two votes a member can cast.

## Use
Use it on a Budget whose owner is a DAO, and on the page that follows a Budget proposed to a DAO.
Do not use it for an owner that is a single account; that owner acts at once through TxFlow.

## Provide
Provide the DAO account and the Budget id.
The panel reads the DAO's policy and proposals itself and decodes each proposal with the shared builders.

## States
Loading shows three skeleton rows.
Empty says that owner actions appear here once proposed.
An error says what could not be read and offers "Read again".
A pending proposal shows "Waiting for votes" in the waiting colour, the approvals out of the number needed, who approved and who rejected, and when voting closes.
An approved proposal is in the settled colour and a rejected one in the refused colour, always with the word.
A proposal whose voting period has passed says "Voting closed" and that it can no longer pass.
A proposal that was approved and whose call then failed says so, and that nothing changed for the Budget.

## Rules
Say what the connected account may do in one sentence above the list: propose and vote, propose only, vote only, or neither, and what to do when it is neither.
Offer Approve only for a call that decodes to one of the five Budget actions, to an account the policy lets approve, that has not voted yet.
Label any other call to the hub or the token "Unrecognized call, review on chain", show its method and receiver, and never offer Approve for it.
Send every vote through TxFlow, with the call the DAO would run decoded beneath the vote.
Write amounts exactly, with the unit: "Deposit 25.00 USDC into this Budget".
Set every account with AccountText or AccountId, so none is broken at a hyphen.
On a phone, Approve and Reject share one row at 44px.

## Do and do not
Do say when the person has already voted, and that the proposal needs other members now.
Do not show a proposal the DAO removed.
Do not name a DAO interface as integrated; the proposals are standard Sputnik DAO proposals.
