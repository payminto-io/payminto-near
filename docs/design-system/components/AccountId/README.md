AccountId displays a NEAR account of up to 64 characters so it stays readable and copyable.

## Use
Use the wrapped form wherever a person must check the account, and middle truncation in rows.

## Provide
Provide the full `value`, a `mode` of `wrap` or `middle`, and optional `name` and `explorer` link.

## Rules
Middle truncation keeps the last 8 characters and the full value in the title.
Copy always copies the full value and confirms for 1200ms.
Controls are 24px with a pointer and keep a 44px hit area on coarse pointers through an invisible pseudo-element, so rows keep their rhythm.
Middle truncation happens only when space runs out; a named account that fits is shown whole.

AccountSentence sets every named account inside a sentence as one unbroken piece, for messages that name accounts.

## Do and do not
Do show the friendly name above the ID when known.
Do not truncate the end of an account ID.
