Attestation shows what Payminto could check about the enclave that answered one model turn on NEAR AI Cloud.

## Use
Use the panel under a model turn in the agent run Timeline.
Use the one-line form in a short timeline, such as the one under the ask box.

## Provide
Provide the turn's attestation as the node stored it: status, summary, signature kind, signing key, request and answer hashes, and the ids of the checks that failed or did not run.
Take every word from `attestationView` in `apps/dashboard/lib/agents.ts`, so the wording has one source.

## Rules
Lead with the result in words: "Verified", "Partially verified", "Verification failed", "Could not be checked" or "No attestation".
Use `shield-check`, `shield-half`, `shield-alert`, `shield-question` and `shield-off` for those five results, at 16px in the panel and 14px on one line.
Use `positive` only when every check passed.
Set a partial result in `foreground` on a `muted` ground, because it is the normal result and not a settled one.
Use `negative` when a check ran and failed.
When the evidence never arrived, keep the text in `foreground` and colour only the shield in `warning`, as ProofPanel does for a Proof it could not read.
Say in the first sentences who signed, what the node checked and how many checks did not run.
List what was checked, then each check that did not run in plain words, and say what it would take to run it.
Say what to do next when a check failed or the evidence is missing.
Show the signing key and both hashes on one line each with AccountText and copy, so the middle truncates and the end never does.
Label the key "Signed by" only when the checks tie it to an enclave, and "Key in the signature" otherwise.
Keep a failed or unchecked result fully open.
Let a verified or partial result fold, with the newest turn open and a 44px fold control on coarse pointers.
End every signed result with the limit: an attestation shows which enclave signed the request and the answer, not that the answer is correct.
Keep words such as TDX quote, TCB or measurement inside the folded details and the node's note, not in the result or its first sentences.

## Do and do not
Do say "This is the normal result" on a partial result signed by the model enclave.
Do say that an answer signed only by the gateway is not tied to a model.
Do not show a green seal, a check mark or the word "Verified" for a partial result.
Do not say or imply that the answer is right, safe or private.
