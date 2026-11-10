# Design references

Real-world patterns from Mobbin that shaped the v2 dashboard.
Each line names the app and screen, what we borrowed, and why it fits a clearing console.

## Navigation and overview

- [Whop, business home](https://mobbin.com/screens/db402b81-a03c-414f-b51a-ec6914cb35d3): a sidebar grouped into labelled sections, so we split navigation into Clearing, Controls and Audit instead of one flat list.
- [Airwallex, payments dashboard](https://mobbin.com/screens/f0165978-3117-45a7-88f0-1a8a97007275): grouped money products in the rail with one quiet accent, which kept our calm cobalt-on-paper palette instead of a crypto look.
- [Deel, home](https://mobbin.com/screens/520a8cef-49aa-4139-a150-4a6482faebb9): a "needs your attention" card next to the totals, which became the Overview "Waiting to settle" and "Attacks blocked" cards that lead straight to an action.
- [Mercury iOS, home](https://mobbin.com/screens/82e8f14d-9bf6-4956-bb4d-8d9306d167d3): failed and pending states as inline pills on each transaction row, which is how blocked calls now read in the live stream.
- [Revolut Business iOS, home](https://mobbin.com/screens/41c74abd-3820-4130-b6b9-b08b7a5a77f4): a bottom tab bar for the four most used areas, which replaced the hamburger-only navigation at phone width.

## Sidebar review (November 2026)

Four Mobbin searches (Stripe, Mercury, Linear, Attio) compared with the Payminto sidebar.
Vercel returned no indexed sidebar screens, so Attio's collapsible web sidebar stands in for it.

- [Stripe, home with Products section](https://mobbin.com/screens/e8ddbdc5-bc89-454f-9ebb-846905b83df4): section labels are small sentence-case text, not tracked capitals, and the chevron sits right after the label; we dropped our uppercase headers for the same quieter hierarchy.
- [Stripe, payment link detail](https://mobbin.com/screens/e8f9d27d-7f88-472c-a70e-811faf24228a): the active item is the only coloured element in the rail, which is why our active icon now takes `--primary` while every other icon stays `--subtle`.
- [Linear, team issues](https://mobbin.com/screens/fd1b4d88-f021-49a3-98af-4cd3a87e1d29): about 30 px rows at 13 px with a 1 px gap fit far more pages without scrolling; our rows went from 32 px at 14 px to 30 px at 13 px.
- [Linear, customize sidebar](https://mobbin.com/screens/f81c0f0b-aaf3-45a0-9985-d79c9b0c0cca): section chevrons appear on hover only while the section is open, so open sections read as plain labels; a closed section keeps its chevron so hidden pages are discoverable.
- [Mercury, home](https://mobbin.com/screens/d575358b-679b-4d52-aa98-5026970291b3): "Tasks 1" is a plain right-aligned number; colour is kept for problems, so our sign-up requests count is now neutral and only Blocked stays red.
- [Attio, home](https://mobbin.com/screens/cb4005f4-a91f-46da-be8e-63a28a24ead8): search with the shortcut hint lives in the sidebar under the workspace switcher, which we already had and kept; its collapsed sections still show a count, as ours do.

What we kept: the account switcher on top, Settings, Help and the user menu pinned at the bottom (Stripe pins Developers the same way), and the 64 px icon rail with a flyout per section.

## Budgets as spend controls

- [Revolut Business, card spend controls](https://mobbin.com/screens/f3bc2b86-b6c6-47d6-a2db-640502c359a9): a list of controls where each row has an icon, a name and its current setting, which is the model for the budget "Spend controls" panel.
- [Airwallex, card details](https://mobbin.com/screens/68dac915-4d2f-4239-9c04-f10cb5a85b90): "Card controls" with a used-of-limit bar and the reset rule beside it, which we use for the daily cap row.
- [Wise, card limits](https://mobbin.com/screens/63f79444-67f7-4c71-a964-cfee71cad090): each limit stated as a sentence with "remaining" under its bar, so every cap reads in plain words.
- [Navan, budget detail](https://mobbin.com/screens/bfe4fd2e-f11f-4088-960e-eb24ace86ab4): one large spent versus left bar above the analysis, which became the Budget hero with settled, pending and remaining segments.
- [Cursor, spending limit](https://mobbin.com/screens/32551509-499c-4cdb-9002-a850b00bca24): a single "used / limit" figure pinned to the right of the bar, which we copy for every cap.

## Create budget wizard

- [Mercury, send money review](https://mobbin.com/screens/cd2dc4bc-de9e-447e-93bf-c12e92c2f2dc): a named step list and a final label/value review before the irreversible action, which our three-step wizard keeps.
- [Navan, set your limits](https://mobbin.com/screens/1835b7cc-8f00-499d-bd95-d6bf5b30da2a): a live preview of the resulting policy beside the inputs, which is why the wizard shows a plain-language policy summary while you type.
- [Airwallex, creating a card flow](https://mobbin.com/flows/d805374d-0c1a-478f-beac-40b4e01813b6): a success toast and the new card's used-of-limit bar right after creation, which is where the wizard lands you.

## Netting and settle

- [Gusto, pay contractors review](https://mobbin.com/screens/eeeecee8-9984-410b-844c-006585e5a934): a summary row of totals and payment count above the line items before submit, which became the before versus after netting hero.
- [Wise, transfer review](https://mobbin.com/screens/ced7c24f-5381-4d74-8c7c-313b54f94540): one huge figure and one primary button, which is why "Settle now" sits in the hero next to the numbers it changes.
- [Deel, payment confirmed](https://mobbin.com/screens/eb392439-083f-4863-b60b-baa13493780b): a green status panel with completed steps and a tracking link, which is the settled state with the transaction hash.

## Transaction detail and receipts

- [Stripe, payment detail](https://mobbin.com/screens/464dcf70-a0d4-4ba9-b23d-ca6ba18e60f5): amount and status badge as the page title, a timeline, then details, which shapes batch and receipt detail headers.
- [Wise, transaction updates](https://mobbin.com/screens/ea2fde3e-8b3e-4ef8-92d9-ea5dc9e51fda): a checked step timeline that ends on the final state, used for the settle progress.
- [Wise, account details match](https://mobbin.com/screens/00a2b34b-0695-4310-9f20-54799eb858bc): a single headline verdict above a list of individually ticked checks, which is the receipt "Verified on chain" moment.
- [Coinbase, you're all set](https://mobbin.com/screens/33903eac-a797-410b-8f40-1328fa2db23f): one solid circular check as the verified mark, kept restrained rather than celebratory.

## Denials and attacks

- [Stripe Radar, block rules](https://mobbin.com/screens/1453565d-f739-47e9-870b-a3b22d47f054): blocked count and blocked volume above a table of rules with a per-rule blocked count, which is the new Blocked calls page.
- [Whop, declined resolution](https://mobbin.com/screens/5694166b-f5c5-4837-9a34-26786ef1d75a): a banner that says "No funds have been moved" in so many words, which every denial now states next to its rule.
- [Vercel, firewall traffic](https://mobbin.com/screens/ad2026a6-3dc6-40d6-8350-4e0af017f6d3): a "Firewall is active" shield card beside the denied counts, which became the "Policy engine active" status on the blocked page.

## Providers, ledger, settings and sign-in

- [Midday, apps](https://mobbin.com/screens/03313f42-04ef-4481-80db-96429e4a63c7): a card grid with an installed badge and two equal actions, which is the providers catalog layout.
- [YNAB, account register](https://mobbin.com/screens/fd551b69-3a52-4ef6-9eba-6a6199694f41): the "cleared + uncleared = working balance" equation over the register, which is the ledger "debits = credits" balance statement.
- [Mercury, journal entries](https://mobbin.com/screens/48a96e2c-7c93-46a5-ac20-ccff5a21f216): debit and credit accounts as columns with the amount on the right, which keeps journal rows scannable.
- [Twingate, generate token](https://mobbin.com/screens/6cd98656-1006-4a51-be6e-807770b3838d): a centred card with one labelled token field and helper text, which is the admin token sign-in.
- [Revolut Business, requesting a card flow](https://mobbin.com/flows/131f05ae-3964-442d-8992-a665c389f7ff): a single icon, one line and one action for empty lists, which every empty state follows.

## Gateway (checkout, links, developers)

Patterns for the payment gateway layer: the hosted checkout a human payer opens from a link, and the merchant pages behind it.
References come from twelve targeted Mobbin searches in November 2026.
Mobbin returned no indexed screens for Coinbase Commerce, Polar, Lemon Squeezy, Paddle or Razorpay, so Stripe, Kraken, OKX, Acctual and developer tools stand in for them.
Everything below reuses the existing tokens (`--primary`, `--positive`, `--warning`, `--negative`, `--info-soft`) and primitives (`Chip`, `Money`, `CopyButton`, `Address`, `Hash`, `Panel`, `Field`, `EmptyState`, `TimeAgo`, `StatStrip`).

### 1. Hosted checkout

References:

- [Stripe, hosted checkout](https://mobbin.com/screens/071ba0ab-1135-4e40-908c-563e1dd740f6): left column is merchant, item and a large amount with the line items and total under it, right column is the payment form ending in one full-width "Pay US$18.47" button.
- [Stripe, payment link preview](https://mobbin.com/screens/ffb06d29-b252-42ea-a2b2-6a732a669a8c): the two-column page reduced to merchant mark, title, amount and description on a solid brand panel, with the fastest method (Apple Pay) above an "Or pay with card" divider.
- [Kraken, deposit USDC](https://mobbin.com/screens/55bf0aa1-ff50-4cff-aaf2-8debd869b868): QR, full address, one "Copy address" button, then a label/value list of network, fee, minimum, confirmations and processing time, then a warning that names the network.
- [OKX, crypto deposit](https://mobbin.com/screens/8eb89bfb-a701-401e-9182-450c89ddd8af): QR beside the full address with a green tick after copy and a "Copied" toast, plus "Token contract: ends with A02913" so the payer can check the token.
- [Acctual, paying a bill flow](https://mobbin.com/flows/eb7b00d8-ba79-4e91-a21c-ff8dad5d9d9c): "Awaiting wallet confirmation" with a spinner and "Please do not close or refresh the browser" while the wallet signs, above a read-only transfer summary.
- [Luma iOS, payment sheet](https://mobbin.com/screens/2b87d56e-02ec-48c1-b0de-9630222bdbc3) and [Posh iOS, payment sheet](https://mobbin.com/screens/5dcdfba7-b84f-420a-9292-62778a069934): on phones the item and amount sit at the top, methods stack in one column, and the pay button is pinned at the bottom with the amount in its label.

Copy:

- Desktop is two columns at 1024px and up: left is the order (merchant logo and name, item title, description, amount), right is the payment panel.
- Below 1024px it collapses to one column in this order: merchant row, amount, item, payment panel, footer.
- The amount is the largest element on the page, set as `Money` with tabular figures, written "25.00 USDC" with the network as a small chip next to it ("on Base").
- The payment panel has two tabs in this order: "Connect wallet" (default) and "Send manually".
- "Connect wallet" is one primary button; once connected it shows the short address, the payer's USDC balance and a single "Pay 25.00 USDC" button.
- "Send manually" shows a 200px QR, the full address in mono broken into groups of four, a `CopyButton` for the address and a separate `CopyButton` for the exact amount.
- Under the QR, a label/value list in the Kraken style: Network, Token (with "contract ends with" the last six characters), Amount, Expires in.
- A one-line warning in `--warning-soft`: "Send only USDC on Base. Other tokens or networks will be lost."
- A countdown "Expires in 14:52" sits in the panel header and turns `--warning` under 2 minutes.
- Footer: "Powered by Payminto", a "Self-hosted, non-custodial" note, Terms, and the merchant's support email.

States (each is one panel body, the left column never changes):

- `awaiting_payment`: QR or wallet button, countdown, helper "We will detect your payment automatically. Keep this page open."
- `wallet_signing`: spinner, "Confirm in your wallet", secondary "Cancel", and the Acctual line "Do not close this page."
- `confirming`: progress with "2 of 3 confirmations", the tx `Hash` linking to the explorer, helper "Payment received. Waiting for the network to confirm it."
- `paid`: hands over to the success view in section 2.
- `underpaid`: `--warning` chip "Partly paid", "Received 20.00 of 25.00 USDC. Send the remaining 5.00 USDC to the same address.", with a new QR for the remainder and the countdown kept.
- `overpaid`: treated as paid, with a neutral note "You sent 0.50 USDC more than required. The merchant can refund the difference."
- `expired`: neutral clock icon, "This payment request has expired.", "No funds were taken." and a primary "Start a new payment" button when the link allows it.
- `failed` or `reverted`: `--negative` chip, the reason in plain words, "No funds were moved.", and "Try again".
- `link_inactive`: "This payment link is no longer active." with the merchant's name and support email and no pay controls.
- Loading uses `BlockSkeleton` in the panel only, so the amount never jumps.

Avoid:

- A brand-coloured full-bleed left panel like Stripe's default; keep the merchant colour to the logo and the pay button so it stays calm and readable in dark mode.
- Truncated addresses in "Send manually"; the payer must be able to read and compare the whole address.
- Asking for email or any account before paying; it is optional and goes after the pay controls.
- Celebratory confetti, chain logos as decoration, or a network picker when the link is fixed to one network.

### 2. Payment success and receipt

References:

- [Uvodo, thanks for your payment](https://mobbin.com/screens/f47a3603-030c-4052-aba1-613439cf0bcb): merchant name at the top, one card with a check, "Thanks for your payment", then order number and date as label/value pairs, and "Powered by" in the footer.
- [Stripe, payment successful](https://mobbin.com/screens/8379a44e-9b7e-4341-8913-9cd1a4be3fa8): one check icon, one headline, one sentence with the amount in it, and two buttons side by side ("View receipt", primary next action).
- [Deel, payment confirmed](https://mobbin.com/screens/eb392439-083f-4863-b60b-baa13493780b): a green status panel above the details with "Share receipt", "Download PDF" and a tracking link.

Copy:

- Same two-column frame as checkout so the page does not jump; the right panel swaps to the success card.
- Solid `--positive` circular check (the existing "Verified on chain" mark), headline "Payment complete", sub-line "25.00 USDC paid to Acme Store."
- Label/value receipt: Amount, Network, From (payer `Address`), To (merchant `Address`), Transaction (`Hash` linking to the explorer), Paid at, Payment ID.
- Actions: primary "Return to Acme Store" when a redirect URL exists, secondary "Download receipt".
- When a redirect URL exists, auto-redirect after 5 seconds with a visible "Returning you to Acme Store in 5s" line and a "Stay on this page" link.
- The receipt URL is permanent, so a payer can reopen it from their history.

Avoid:

- Auto-redirecting with no visible countdown or way to stop it.
- Hiding the transaction hash behind a "details" toggle; for crypto it is the proof of payment.
- Confetti or large illustrations; the existing dashboard keeps verified states restrained.

### 3. Payment links: list, create form, share sheet

References:

- [Stripe, payment links list](https://mobbin.com/screens/bbc81130-2236-4c92-971a-2dc2c396d472): name with an "Active" chip inline, price with a sub-line for the price model, created date, overflow menu, and filter pills (Created, Status) above the table.
- [Squarespace, pay links](https://mobbin.com/screens/eef6584c-6aba-44ec-9326-d3a4091277aa): a copy-link icon button on every row so the most common action needs no menu.
- [Stripe, create payment link](https://mobbin.com/screens/ffb06d29-b252-42ea-a2b2-6a732a669a8c): form on the left, live preview of the hosted page on the right with a phone and desktop toggle, "Create link" in the top-right, and a type selector ("Customers choose what to pay").
- [Stripe, payment link detail](https://mobbin.com/screens/e8f9d27d-7f88-472c-a70e-811faf24228a): a label/value details list, an Events list and API logs under the link, with the live preview pinned to the right.
- [Deputy, share modal](https://mobbin.com/screens/3788b420-fc9d-4d44-a805-6d74d0e7375e) and [Delphi, share modal](https://mobbin.com/screens/2b05c0a4-18e1-4a35-843e-9dd32d3c6ab9): the URL in a read-only field with a "Copy" button, then QR code download, with a "link copied" toast.
- [Bonsai, share form](https://mobbin.com/screens/7629bd57-5751-4040-a044-1df5208095b8): "Public link" and "Embed code" as tabs, with the embed snippet in a mono box and "Copy to clipboard".

Copy:

- List columns: Title (with status `Chip` inline), Price ("25.00 USDC" or "Customer chooses"), Payments (count), Volume (`Money`), Created (`TimeAgo`), then a copy icon button and an overflow menu.
- Status filter as segmented tabs with counts: All, Active, Expired, Archived.
- Create is a full-page sheet: form left, live checkout preview right with a phone and desktop toggle, "Create link" primary top-right, "Cancel" secondary.
- Form order: Title, Amount type (segmented "Fixed amount" / "Customer chooses"), Amount (with a USDC suffix, or optional min and max for customer chooses), Description (optional), Redirect URL after payment (optional, validated as https), Expiry (Never, 24 hours, 7 days, Custom date), then "Advanced" collapsed for metadata and max number of payments.
- Mark optional fields with a muted "Optional" label instead of asterisks on required ones.
- After create, land on the link detail with the share sheet already open.
- Share sheet: URL field with "Copy link", a QR with "Download PNG" and "Download SVG", and an "Embed" tab with a button snippet and an iframe snippet, each with its own copy button.
- Link detail: amount and status as the title, then a `StatStrip` (Payments, Volume, Conversion), the payments made through this link, then the details list, with "Deactivate" in the overflow menu.

Avoid:

- Social share icon grids (Biosites, GoFundMe); merchants share in their own channels and the icons add noise.
- Hiding "Copy link" in an overflow menu.
- A create form without a live preview; the payer page is the product.
- Deleting links; use "Deactivate" so old links show the inactive state instead of a 404.

### 4. Payments list and payment detail

References:

- [Stripe, transactions](https://mobbin.com/screens/80054ec0-bb9d-4438-9a66-4f7bcd8f103f): status tabs as count cards (All 6, Succeeded 1, Refunded 0, Failed 3), filter pills, amount first and bold with currency, status chip right after it, then description, customer and date.
- [Whop, payments](https://mobbin.com/screens/b3d17af6-37c1-45bd-aaa7-7aa86c9b4dbc): filter chips with a plus icon, "Export" and an "Edit" column picker, and a "Showing 1 to 2 of 2" footer.
- [Stripe, payment detail with refund](https://mobbin.com/screens/c16180c0-adea-4054-b67d-8bc187348fcb): amount and status chip as the page title, "Charged to" sub-line, Timeline on the left, a Details rail on the right, and a payment breakdown with net amount.
- The existing [Stripe, payment detail](https://mobbin.com/screens/464dcf70-a0d4-4ba9-b23d-ca6ba18e60f5) and [Wise, transaction updates](https://mobbin.com/screens/ea2fde3e-8b3e-4ef8-92d9-ea5dc9e51fda) references above still apply to the timeline.

Copy:

- Status tabs with counts: All, Paid, Pending, Underpaid, Expired, Refunded.
- Filter pills: Date, Amount, Network, Link, Customer; plus a search box that accepts payment ID, tx hash or address.
- Row: Amount (`Money`, bold, right-aligned figures), status `Chip`, Link or description, Payer (`Address` short form), Network, Date (`TimeAgo`), overflow.
- Rows link to the detail; the whole row is the hit target, not only the ID.
- Detail header: "25.00 USDC" with the status chip, sub-line "Paid by 0x12ab...9f3c via Payment link: Pro plan", and "Refund" plus overflow on the right.
- Detail body left column: Timeline, then Payment breakdown (Amount requested, Amount received, Network fee paid by payer, Net to merchant), then Webhook deliveries for this payment.
- Detail body right rail: Payment ID, Link, Network, Token contract, Deposit address, Transaction `Hash`, Block, Customer email, Metadata.
- Timeline events, newest at the bottom with a checked step style: Created, Checkout opened, Wallet connected, Transaction broadcast, Confirmed (n of n), Paid, Webhook delivered (200), Refunded.
- Failed or warning events use the matching `Chip` tone and say what happens next ("Waiting for the remaining 5.00 USDC").

Avoid:

- Card-style payment-method columns copied from fiat dashboards; show network and payer address instead.
- More than seven default columns; put the rest behind a column picker.
- Timestamps without a timezone on the detail page; show local time with UTC on hover.

### 5. Developers: API keys, webhooks, delivery log

References:

- [OpenAI Platform, save your key](https://mobbin.com/screens/701c79c6-3a8d-4309-a6f5-373634664a6d): "Save your key" with the warning sentence in bold ("you won't be able to view it again"), the key in a field with an inline "Copy" button, permissions listed under it, and a single "Done".
- [Gamma, keep it safe](https://mobbin.com/screens/3762fc5a-915b-4783-a48b-01f01c95c49a): a short title, a warning banner "You will not be able to see this key again", and a close button that says what it does ("Close and hide forever").
- [Stripe, webhook destination](https://mobbin.com/screens/065bf8c6-7bb0-4ddf-ab61-af29f505d0a3): Overview and Event deliveries tabs, delivery and response-time charts, and a details rail with the signing secret masked behind "Reveal".
- [Resend, webhook detail](https://mobbin.com/screens/e5079320-66e3-4ae3-86e3-336a72fd9a6c): endpoint header with status and masked signing secret, events list on the left with "Success" chips, and on the right the selected event's ID, timestamp, HTTP status, attempts, response body, payload and a "Replay" button.
- [Sentry, request log](https://mobbin.com/screens/de9d35ab-8456-4255-8fa7-49000ea9b7a2): a dense log of time, status code chip, event type and URL with an "Errors only" toggle.
- [Teachable, webhook history](https://mobbin.com/screens/b06b6684-800c-426f-8a73-dbe6e8072125): a banner "Webhook disabled after several failed attempts" with an inline "Re-enable" action.

Copy:

- Developers page has three tabs: API keys, Webhooks, Logs.
- API keys table: Name, Key (prefix and last four only, "pm_live_...9f3c" in mono), Created, Last used, Status, overflow with "Roll key" and "Revoke".
- Create key: name and scope first, then the reveal-once dialog with the OpenAI and Gamma pattern: title "Save your secret key", one bold sentence "You will not be able to see it again.", full key in a mono field with an inline copy button, and the close button reads "I have saved it".
- The close button is disabled until the key has been copied once, or the user ticks "I have stored this key".
- "Roll key" asks for an expiry for the old key (Now, 1 hour, 24 hours) so integrations can switch without downtime.
- Webhook endpoints list: URL, events count, status chip (Enabled, Disabled, Failing), success rate over 7 days, last delivery.
- Add endpoint form: URL, events as grouped checkboxes (payment.created, payment.confirming, payment.paid, payment.underpaid, payment.expired, refund.created, refund.completed), then show the signing secret once with the same reveal pattern.
- Endpoint detail follows Resend: header with URL, status, signing secret masked with reveal and copy, "Send test event" button; below it a split view of deliveries list on the left and the selected delivery on the right.
- Delivery row: event type, status code `Chip` (2xx positive, 4xx and 5xx negative, timeout warning), attempt count, `TimeAgo`.
- Delivery detail: Event ID, Payment link, HTTP status, Duration, Attempt "2 of 8", Next retry time, request payload and response body in mono blocks with copy, and "Retry now".
- Filters above the log: All, Succeeded, Failed, plus an event-type select.
- When an endpoint is auto-disabled, a `--negative-soft` banner at the top: "Disabled after 8 failed deliveries. Fix the endpoint, then re-enable it." with "Re-enable" inline.

Avoid:

- Showing full secrets again after creation, or a reveal toggle on API keys; only the webhook signing secret is revealable, and only to admins.
- Silent retries; every attempt is a row with its own status code.
- Raw JSON without wrapping, syntax colour or copy.

### 6. Refunds

References:

- [Stripe, refund payment](https://mobbin.com/screens/c16180c0-adea-4054-b67d-8bc187348fcb): a small dialog with an info line on timing and fees, refund amount prefilled to the full amount with currency suffix, a reason select, an optional note, and a primary button that repeats the amount ("Refund MYR 0.50").
- [Shopify, refund order](https://mobbin.com/screens/bd222a58-7e8e-426d-93f1-2b30fb2521cb): a summary rail with "Refund total", "$182.00 available for refund" under the amount field, a reason that says who can see it, and "Send notification" as a checkbox.
- [Upwork, request a refund](https://mobbin.com/screens/ba3c0289-ffba-4e55-8ec7-fbef9383c0fd): "Total amount" versus "Other amount" as radios, which is the clearest full or partial choice.

Copy:

- Refund opens as a dialog from the payment detail, never as a separate page.
- Fields in order: Amount (radios "Full amount: 25.00 USDC" and "Partial amount" with an input showing "Up to 25.00 USDC available"), Send to (payer address prefilled, editable, with a check that it is a valid address on the same network), Reason select (Requested by customer, Duplicate, Overpayment, Other), Internal note (optional, "Only your team can see this").
- An info line in `--info-soft`: "Refunds are sent on-chain from your wallet and cannot be reversed. The network fee is paid by you."
- The primary button repeats the exact action: "Refund 25.00 USDC".
- If the refund needs a wallet signature, the dialog moves to the same "Confirm in your wallet" state as checkout, then closes on broadcast with a toast.
- The payment status becomes "Refunded" or "Partly refunded", and a "Refund sent" event with its tx `Hash` is added to the timeline.
- A Refunds tab in Payments lists: Amount, Status (Pending, Sent, Confirmed, Failed), Original payment, Recipient `Address`, Reason, Date.
- Failed refunds say why in plain words and offer "Retry".

Avoid:

- Card-world copy like "5-10 days to appear on a statement"; on-chain refunds land in minutes and the copy should say so.
- Letting the refund amount exceed what is left to refund; disable the button and show the limit inline.
- A refund flow without a recipient address check; a wrong address loses the funds.

### Build checklist

1. Use only the existing tokens and primitives; status colour comes from `Chip` tones, never ad hoc hex values.
2. Every amount is `Money` with tabular figures, the token after the number ("25.00 USDC"), and the network named nearby.
3. Every address, hash, key and ID is mono and has a `CopyButton` with a "Copied" confirmation.
4. Show full addresses wherever the payer must send funds or the merchant must verify a refund; short forms only in tables.
5. Each checkout state has its own headline, one sentence on what is happening and one on what happens next, and failure states say "No funds were moved" when true.
6. The checkout amount and merchant column never move between states; only the payment panel changes.
7. Checkout is two columns at 1024px and up and one column below, with the pay action reachable without scrolling on a 390px wide phone.
8. Primary buttons state the exact action and amount ("Pay 25.00 USDC", "Refund 25.00 USDC", "Create link").
9. Secrets are shown once, in a dialog that cannot be dismissed until they are copied or acknowledged.
10. Lists use status tabs with counts, filter pills and a whole-row link to a detail page with a timeline.
11. Webhook deliveries and refunds are logged per attempt with status code, time and a retry action.
12. Every list has an `EmptyState` with one icon, one line and one action, every load uses skeletons in place, and every page is checked in both light and dark.

## Operator (merchants and fees)

Patterns for the operator area of GATEWAY.md section 14: merchants, fee plans, payment methods and platform earnings.
References come from four targeted Mobbin searches in November 2026.

- [Semrush, campaign setup flow](https://mobbin.com/flows/88710d01-fc4e-4e32-8490-75720f070d13): a numbered step bar ("1 Select platforms, 2 Add details, 3 Review and launch") above one centred card with a single primary "Continue", which is the merchant create wizard (Profile, Payout proof, Fee plan, Methods, Review).
- [Shopify, set up payments flow](https://mobbin.com/flows/ea4c1432-cbee-426d-951f-ed12139f522a): fee terms stated in one plain line under the provider name ("No transaction fees, card rates starting at 2.5% + $0.30") and "Back" and "Next" pinned under each step, which is how every fee plan and method row reads.
- [Square, plans](https://mobbin.com/screens/2e95c78e-89cd-4cbe-8a9f-cb6b64cccad8): fees written as "2.9% + 30¢" per channel inside each plan, which is the format for a fee plan ("0.5% + 0.00 USDC, min 0.05, max 5.00") and for each method fee.
- [Zillow, costs and fees](https://mobbin.com/screens/4318114f-93b5-4736-af8c-ad9a434dc9ff): a toggle that decides whether a fee is folded into the shown price, with tips beside the form, which is the "Customer pays this fee" bearer switch with a live example payment next to it.
- [Snowflake, account switcher](https://mobbin.com/screens/41e8b27f-bbca-4be6-9136-a536e37c17b4): the current account with a check in a menu grouped by account, plus "View account details", which is the merchant switcher at the top of the rail.
- [Square, item sales report](https://mobbin.com/screens/23053271-4a95-4a5b-8c8f-e0208ff03d98) and [Shopify, reports](https://mobbin.com/screens/3dccd8f9-da77-4d27-a588-26428fedcd8b): a date range and a "Summary / Display by" control above one chart and a table with a total row, which is the platform earnings report (by merchant, by method).

Copy:

- The merchant switcher sits in the rail above the navigation, shows the merchant name and status, and lists every merchant with a check on the current one and "All merchants" at the bottom; it only appears for the operator.
- The create wizard has five steps; the payout step asks the connected wallet to sign "Payminto payout change {merchantId} {newPayout} {timestamp}" and shows "Signed by 0x12ab...9f3c" before Next unlocks, so nobody can register a payout they do not control.
- A fee plan reads as one sentence ("0.5% of each payment, at least 0.05 USDC") with a live breakdown for a sample 25.00 USDC payment computed with `computeFees`: Amount, Surcharge, Amount due, Platform fee, Method fee, Net to merchant.
- Payment methods are rows with a switch, the fee in Square's format, and who pays it ("Merchant pays" or "Customer pays, shown at checkout"); a merchant sees them read-only except the switch.
- Earnings show three figures (Fees earned, Volume, Payments) above a by-merchant table with a total row and a by-method table.

Avoid:

- Fee math anywhere but `computeFees`; the preview must match what the node charges to the base unit.
- Hiding the surcharge: the checkout names the method in the line ("Manual transfer fee") and the refund dialog says fees are not returned.
- Letting a payout change happen without a wallet signature from the new payout.
