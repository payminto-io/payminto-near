# Live run: one real any-chain payment on NEAR mainnet

This is the checklist for the product owner's one real payment for the demo video, planned for 2026-11-14.
A buyer pays 1 to 2 USDC from Base through NEAR Intents (the 1Click API), and the business receives exactly that amount of USDC in its own NEAR mainnet account.
You do every signing and every transfer yourself, in your own wallets.
Nobody on the team signed a mainnet transaction or asked 1Click for a real deposit address while building this; the screens below were tested with a fake wallet and the simulated 1Click server.

Only the any-chain rail is live.
The hub, the Budgets and the local accounts stay on the local chain of `pnpm local`.
In live mode checkout offers only "Any chain": the "NEAR wallet" tab and agent vouchers would pay with local test money, so they are off for every business, and every Paid invoice is real money.
In Settings, Payment methods, the NEAR wallet and voucher methods show "Off in live mode: the hub runs on a test network, and this server takes only real money from other chains." and cannot be turned on.

## What you need

- A NEAR mainnet wallet that NEAR Connect lists for mainnet and that can sign messages and transactions (for example Meteor Wallet, Intear Wallet or HOT Wallet).
- About 0.1 NEAR for the new dev account and its fees.
- On Base, in your own wallet: 2 USDC and a little ETH for gas (an ERC-20 transfer on Base costs well under 0.05 USD).
- This repository on `main` with `pnpm install` done, and a machine where `pnpm local` already runs (it needs the near-sandbox binary).
- About 45 minutes, of which the payment itself takes 2 to 5.

## Costs

- The storage deposit that registers the account with USDC: 0.00125 NEAR, once.
- Gas on NEAR for creating the account and the storage deposit: a few thousandths of a NEAR.
- The swap: the buyer pays it, so the business receives the full invoice.
  Every fee is read from the signed 1Click quote and shown on the deposit screen before you send anything; none is a constant.
  For scale, a free dry quote on 2026-11-10 for 1.50 USDC from Base asked the buyer to send 1.501678 USDC: 0.000176 USDC of swap and delivery cost, and a 0.001502 USDC price buffer that goes back to the refund address if the price holds.
- If a deposit is returned, 1Click keeps its refund fee (0.0024 USDC in that quote) and sends the rest back to the refund address on Base.
- Gas on Base for your USDC transfer, paid in ETH.
- Payminto takes no fee on this rail.

## Risks, in plain words

- This is real money on NEAR mainnet and on Base.
- Send only USDC, only on the Base network, only to the deposit address the screen shows, and only the exact amount it says.
  Another token, another network (for example USDC on Ethereum to the same address) or a wrong address may be lost for good.
- Send before the deadline the deposit screen counts down to (at most 30 minutes after you ask for the address).
  A deposit that arrives after it may be returned to your refund address, less the refund fee, or may be lost.
- Sending less than the screen says makes 1Click return the deposit, less the refund fee; the payment then stays unpaid.
- The deposit address and the price come from 1Click, a third party.
  The node checks 1Click's signature and every field of the quote before it shows the address, which proves where the quote came from, not that the price is fair.
- The refund address you type is where any returned money goes: use your own Base address and read it twice.
- Stopping `pnpm local` stops the local chain, and the next start deletes its database, including the payment's record; capture the result first (step 11).
  The USDC itself is in your NEAR mainnet account and stays there.
  While the database still holds a live quote that is not final (a deposit address waiting, or a payment on its way), the next `pnpm local` refuses to start and names the quotes; `pnpm local --reset` deletes them anyway.

## Steps

0. Check that NEAR Intents is quoting today - see eight signed quotes, each with "1Click signature: valid; checks: passed".
   This is free and needs no wallet: it asks the live 1Click API for dry quotes, which create no deposit address, so nothing can be sent.

   ```sh
   pnpm --filter @payminto/near-addons intents quote-in --from all --usdc 1.5 --merchant <your account>
   ```

   Each quote prints what the buyer sends, what the business receives, the swap and delivery cost, the price buffer and the refund fee, read from the quote 1Click signed.
   On 2026-11-12 all eight origins (USDC on Base, Ethereum, Arbitrum, Solana and Polygon, USDT on Ethereum, ETH on Base and Ethereum) answered in about 6 seconds and passed every check the node runs before it shows a deposit address.
   If a line says the signature is not valid or a check failed, stop here: the node would refuse that quote too, and the live run would show no deposit address.

1. Create and fund the dev mainnet account in your own wallet - see it on NearBlocks.
   Create a new named account in your wallet, for example `yourname-payminto-demo.near`, separate from any account you use for anything else.
   Fund it with about 0.1 NEAR.
   Open `https://nearblocks.io/address/<your account>` and see the account with its NEAR balance.
   Keep the wallet signed in to this account for the rest of the run.

2. Register the account with USDC - see `storage_balance_of` answer a balance instead of null.
   You can send it now from NEAR CLI, or later from the dashboard in step 6, which shows the same transaction before your wallet opens.
   The exact transaction, from your account:

   ```json
   {
     "signerId": "<your account>",
     "receiverId": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
     "actions": [
       {
         "type": "FunctionCall",
         "params": {
           "methodName": "storage_deposit",
           "args": { "account_id": "<your account>", "registration_only": true },
           "gas": "30000000000000",
           "deposit": "1250000000000000000000"
         }
       }
     ]
   }
   ```

   The receiver is native USDC on NEAR mainnet, the deposit is 0.00125 NEAR and the gas limit is 30 Tgas.
   With NEAR CLI (near-cli-rs) and your account's key in its keychain:

   ```sh
   near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit \
     json-args '{"account_id":"<your account>","registration_only":true}' \
     prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' \
     sign-as <your account> network-config mainnet sign-with-keychain send
   ```

   To check it, run `near contract call-function as-read-only 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_balance_of json-args '{"account_id":"<your account>"}' network-config mainnet now` and see `{"total":"1250000000000000000000","available":"0"}`.

3. Start `pnpm local` with the live option - see the red-flag banner, then the guide.

   ```sh
   pnpm local --intents live --intents-payout <your account>
   ```

   See the banner "LIVE - real money on NEAR mainnet" first, before anything starts; press Ctrl-C now if you did not mean it.
   Without `--intents-payout` it refuses to start and says why, and no environment variable can turn live mode on.
   After 1 to 3 minutes (longer the first time, while the dashboard compiles) see the line "LIVE any-chain checkout: `<your account>` exists on NEAR mainnet and is registered with USDC" (or "is not registered with USDC yet" if you skipped step 2).
   Then the guide prints, with the banner again and how the node checks a live delivery.
   Leave this terminal open until step 12.

4. Note how the node confirms a live payment - see the paragraph under the banner.
   When 1Click reports the USDC delivered, the node reads the delivery transaction on NEAR mainnet itself and looks for USDC's NEP-141 `ft_transfer` to your account for at least the invoice amount; that is `rpc_checked`.
   NEAR RPC asks for the account that signed a transaction; the node tries `INTENTS_DELIVERY_SENDERS` (the `--intents-senders a.near,b.near` option) and then your account.
   On 2026-11-10 `https://rpc.mainnet.near.org` found a mainnet transaction under any sender account, so no `--intents-senders` is needed with the default RPC.
   With `--intents-rpc <https url>` pointing at an RPC that tracks only some shards, the read can miss; if the node cannot read the delivery for 10 minutes it confirms on 1Click's word and marks it `provider_only` ("Reported by 1Click only" in the dashboard).
   The payment's proof page reads the delivery again in your browser either way.

5. Sign in as the business - see Northwind Coffee's dashboard.
   Open `apps/local/data/logins.txt` and use the second login, the business Admin of Northwind Coffee, at `http://localhost:3210/login`.
   See Home for Northwind Coffee.

6. Set up the business's any-chain payout - see three passed checks and the switch on.
   Open Settings, Payment methods, and scroll to "Accept any chain (NEAR Intents)".
   See the label "Live - NEAR mainnet" and a note "NEAR mainnet: Real money. Signing here opens a separate NEAR mainnet wallet connection, for two steps only".
   That connection is separate from the dashboard's own (the local signer of `pnpm local`), and it signs only the ownership message and the storage deposit.
   Type your account and read the message under it: `Payminto intents payout <business id> <your account> <time> network near:mainnet hub <local hub>`.
   Press "Sign with a NEAR mainnet wallet", pick your wallet in NEAR Connect (it lists mainnet wallets only), check that it shows your account and the same message, and approve.
   See "Signed by `<your account>`", then press "Save and check account" and enter your dashboard password when asked.
   See the checks read from NEAR mainnet: "The account exists on NEAR mainnet", the USDC registration, and the signature.
   If you skipped step 2, press "Review the storage deposit": the review shows "Network: NEAR mainnet", the receiver `17208628...36133a1`, the method `storage_deposit`, its arguments, "0.00125 NEAR, once" and the gas, before any wallet opens.
   Press "Open my NEAR mainnet wallet", approve the same transaction in your wallet, and see "Final on NEAR" with a NearBlocks link; the checks are read again.
   Turn on "Accept any chain (NEAR Intents)" and see "Customers can now pay from other chains."

7. Create a payment link for 1 to 2 USDC - see its address.
   Open Payment links, "New link", give it a title such as "Live demo", a fixed amount of 1.50 USDC, and save.
   See the link's page with its address, `http://localhost:3210/l/<slug>`.

8. Open the link as the buyer - the checkout opens at once, on one screen.
   Open the link in a new tab.
   A fixed-amount link that asks for nothing goes straight to its checkout: there is no "Continue to pay" step.
   See "Live - NEAR mainnet" and "Pay with": USDC, USDT or ETH, and the chains for each (Base, Ethereum, Arbitrum, Solana, Polygon); there is no "NEAR wallet" tab in live mode.
   Do steps 9 and 10 within 20 minutes: a deposit address needs at least 10 minutes left on the payment, and if the page says it expires too soon, open the link again for a new payment.

9. Pick "USDC" and "Base" - the payment address is already there.
   The page asks 1Click for a real deposit address as soon as a chain is picked (free until money is sent to it); picking another chain gets that chain's own address, and picking Base again shows the same one.
   No refund address is asked for: if a deposit cannot complete (too little, or too late), NEAR Intents returns it to your NEAR account (`--intents-payout`), and you send it back to the buyer.
   See "Send exactly `<amount>` USDC on Base", about 1.5018 USDC for 1.50 USDC, and one block with the QR code, the amount, "USDC on Base" and the address, each with a copy button.
   See one status line, "Waiting for your payment. Send before `<time>` UTC", and the warning about other tokens, networks and late deposits; the fee lines and the progress steps are under "Details".

10. Pay from Base in your own wallet - see the status line move, then "Payment complete".
    The easiest way is "Pay `<amount>` USDC with your wallet", shown when this browser has an Ethereum wallet (an extension such as MetaMask or Rabby, or a wallet app's own browser on a phone).
    It switches the wallet to Base and asks it to send the exact USDC transfer to the deposit address; check the token, network, amount and address in the wallet before you approve.
    Otherwise, in your Base wallet, send exactly the amount shown, of USDC, on the Base network, to the address shown.
    For USDC the QR code holds the deposit address only, never an EIP-681 request: that request names the USDC contract first, and a wallet that reads only that address would send the money to the contract, where it is lost.
    So after scanning, type the exact amount yourself, and check all four against the screen before you approve.
    Optionally paste your Base transaction hash under "Details", "I've sent it"; it only speeds up detection.
    See "Payment received. Converting it for `<business>`" within about a minute of Base confirming (the steps under "Details" show "Deposit received", "Converting to USDC", "Delivered to merchant"); 1Click estimated 35 seconds for this route.
    See "Payment complete" with "Paid from Base through NEAR Intents", the Base deposit transaction and the NEAR delivery transaction.
    In all, 1 to 5 minutes from sending.
    In the dashboard, Payments lists the payment as Paid with "Any chain - USDC on Base"; its page has a "NEAR Intents" card with "Delivery checked on NEAR" (or "Reported by 1Click only", see step 4).
    Open the payment proof from the success screen (`http://localhost:3210/receipt/<payment id>`): see "Verified on NEAR mainnet", the delivery read in your browser from NEAR mainnet, and 1Click's status beside it as the server last read it.
    Your wallet shows 1.50 USDC more on your NEAR mainnet account.
    If you left an email on the checkout ("Email me a receipt"), the receipt is in the dashboard's Platform, Email outbox (sign in as the platform owner), and in `apps/local/data/logs/node.log` as `[email] to=... kind=receipt`: `pnpm local` sends no real email.

11. Capture the result for the README - see a dated JSON file and the list of accounts in it.
    With `pnpm local` still running, in a second terminal:

    ```sh
    pnpm live:capture <payment id>
    ```

    The payment id starts with `pay_`; it is in the payment's address in the dashboard and in the checkout address.
    See "Saved docs/live-run/2026-11-14-`<payment id>`.json" and the accounts and addresses it contains: your NEAR account, your Base refund address, 1Click's deposit address and the account that signed the delivery.
    The file holds the quote as the node keeps it with the signed 1Click quote, 1Click's status read now, and the NEAR delivery transaction read now from NEAR mainnet; it holds no email, name, order metadata or API key.
    Read the file.
    Commit it only if every account and address in it is a dev account or address you approve: `git add docs/live-run && git commit -m "Live run of the any-chain checkout on NEAR mainnet"`.

12. Stop - see every part stop.
    Press Ctrl-C in the `pnpm local` terminal and see "Stopping".
    That stops the local chain, and the next start deletes its database; the USDC stays in your NEAR mainnet account, and the dashboard's mainnet wallet connection is forgotten with the next "Disconnect" or when you clear the site's data.

## If it does not go as planned

- You need to refund the buyer: open the payment in the dashboard and press Refund.
  A payment from another chain cannot be refunded on NEAR, so the dashboard shows the chain, the buyer's full refund address on it and the deposit transaction.
  Send the refund from your own wallet on that chain (USDC on Base here), then record it with the chain and your transaction hash; the node marks the refund succeeded and moves nothing itself.
- The next `pnpm local` says "Not starting: the previous run took real money through the any-chain checkout": a live quote of the last run is not final yet.
  Capture what you need, look each deposit address up with 1Click, or run `pnpm local --reset` to delete the database anyway.

- "Your deposit was returned": 1Click sent the deposit back to your refund address on Base, less its refund fee, usually because less than the exact amount arrived.
  The screen says how much and why, the payment is open again, and "Try again" gets a new address.
- "Converting" or "Delivered" for more than 10 minutes: leave the page open.
  1Click keeps watching the deposit, and the node checks every few seconds while the page is open (every 15 seconds otherwise).
  Use 1Click's correlation id from the payment's NEAR Intents card in the dashboard if you contact 1Click.
- You sent after the deadline: the address stays watched for a day.
  1Click may still swap it or return it; the checkout page shows the outcome, and "Get a new address" starts over.
- "Failed": nothing reached your NEAR account; the screen names who to contact and the reference.
- The NEAR Connect window does not open on `localhost`: try another wallet from the list, or allow pop-ups for `localhost:3210`.
- `pnpm local` says the payout account could not be read: NEAR's public RPC may be rate limiting; start again with `--intents-rpc <another mainnet RPC you trust>`.

## Reference

- The settings, the checkout screens and the proof page: [apps/dashboard/README.md](../apps/dashboard/README.md), "Any-chain checkout (NEAR Intents)".
- The live option of `pnpm local`: [apps/local/README.md](../apps/local/README.md).
- The API: [docs/DEVELOPERS.md](DEVELOPERS.md), "Any-chain checkout (NEAR Intents)".
