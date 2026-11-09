# Master script review

Four separate verification passes over `MASTER_SCRIPT.md`, each followed by a fix.
Draft 1 is the first full script (28 scenes, 311 s planned); the final is 27 scenes, 281.2 s as voiced.

## Pass A: story and emotion, against `RESEARCH.md`

| Check | Finding on draft 1 | Fix |
|---|---|---|
| Warm greeting, not a flat product intro | Opened with "Hi there, and welcome. This is Payminto." over a dark card | Kept the greeting, put a soft-focus pass over the real dashboard behind it (`clips/S01-teaser.mp4`) so the product is on screen from second one (research pattern 4, Dropbox) |
| Human story hook within about 20 s | S02 story worked ("their newest customer was not a person. It was an AI agent.") but ran 20 s and 56 words | Cut to 47 words; kept the turn and the pain line "they had no way to take that money" |
| "That is my problem" before "that is your product" | Problem act had three beats (fees, open wallet, hosted trap) before the product: 28 s | Cut the hosted-trap scene; its point moved into the Moat slide (S21), so the product arrives at 0:35 |
| Story payoff | The Pune team never came back; the story felt like a device | Added the callback in the close: "That team in Pune can finally take that money." |
| One refrain (iPhone pattern) | "Budget. Netting. Proof." was spoken once and never paid off | Added refrain chips that light up on the real screens: Budget in S12, Netting in S14, Proof in S15 |
| Snap transitions between acts | Act changes were implied only | Every act opener gets a cobalt snap panel and an act label (built into the HyperFrames scenes) |
| Tone markers | Draft used one cue per scene, including `[sarcastic]` on the hosted-trap line | Removed with the scene; cues now follow the emotional arc: warm, frustrated, worried, confident, curious, excited, proud, sincere, warm |

## Pass B: facts and claims, against the repository and sources

| Claim in draft | Check | Result and fix |
|---|---|---|
| "One stablecoin transfer costs about thirty-four thousand gas" | `docs/GAS.md`: 34,444 gas to an existing recipient | Correct, kept |
| "That can cost as much as the call itself" | `README.md` says the transfer "rivals" a 0.002 USDC call; that rests on the 500 gwei mainnet base fee (`docs/HASHKEY.md`) and an HSK price not in the repo | Softened to "That fee can rival the price of the call itself", matching the README |
| "a fifth of a cent per call" | 0.002 USDC is the README's example price | Kept, framed inside a "Picture" story so it is not presented as a real customer |
| "Each transfer is wrapped as an HSP payment and verified" | `README.md` honesty notes: our own adapter signs and verifies; HashKey's HSP server answers 403 until our IP is allowlisted | Rewritten: "Each transfer is wrapped as an HSP payment. HashKey's live HSP server has not allowlisted us yet, so our own HSP adapter checks it today." |
| "Paid, with the fee split in the same transaction" | The fee split is the platform operator's fee (`README.md`, Payment gateway); the pitch says "we take zero percent", which could look contradictory | Now "the platform fee split off", and the pitch says "We never take a cut of your payments" |
| "Hosted players hold the money" | `research/03-market-competitors.md` section 2.7: they hold funds or wallets | Now "hold the money or the wallets" |
| "Those teams will meet foreign agents first" | A prediction, not a sourced fact | Reworded as a judgement: "Those teams should meet foreign agents first." |
| "In ninety days: an audit, escrow on delivery, and mainnet" | `docs/SUBMISSION.md` 90-day roadmap lists escrowed vouchers and an audit, not a mainnet date | Now "escrow on delivery and an audit, ahead of mainnet"; the mainnet date is an open question for the founder |
| "$316 billion of stablecoins" | Transak citing DefiLlama, 12 June 2026, fetched 2026-11-03 | Correct; the slide shows the date |
| "$3-5 trillion of agentic commerce by 2030" | `research/03-market-competitors.md` 4.2, McKinsey as reported by Stellagent | Kept with "is reported to" in voice and on screen |
| "75% of Indian SaaS revenue from global sales" | Nasscom FY2020 via The News Minute, fetched 2026-11-03 | Kept with the year spoken |
| "Real Circle testnet USDC on Ethereum Sepolia" | The live run brief; Sepolia USDC is testnet money | Kept; "testnet" is now said in the line itself, and the badge stays on screen |
| "This is a real OpenAI model, not a script" | `apps/agent/README.md`: `PAYMINTO_AGENT_PROVIDER=openai` runs the same runtime on OpenAI | Correct for the recorded run; the shot list says to record with the OpenAI provider |
| Refund "goes out gasless" | `README.md`: gasless refund through the router | Correct; the shot list notes the business's approval rule must be on so a human approves |
| Testnet honesty | Said once in draft 1 | Said in S08 title, S09 line, the persistent badge, the traction slide and the close |
| No mention of other companies' products as ours | Checked every line | Only x402, AP2, HSP and Circle USDC are named, each as a standard or rail we use |

Placeholder handled for voice: `<ASK_SPOKEN>` is spoken as "design partners, and help to reach mainnet" until the founder sets the real ask; the on-screen slide still shows `<ASK>`.

## Pass C: Track 2 judge criteria (HSP, agent-to-agent settlement, live HashKey transactions, real AI agents)

| Criterion | Draft 1 | Fix |
|---|---|---|
| HSP is required for the payments track (`docs/SUBMISSION.md` requirement 2) | Mentioned once, as a claim, with no screen | S14 now shows the HSP status chips on the batch page, a cut to Settings, Payment methods with HSP "Waiting for HSP access", and says plainly who checks it today; S07 names HSP as the settlement rail |
| Agent-to-agent settlement | Shown in S14 but not tied to settlement | S13 (agent pays agent pays agents) runs straight into S14 (netting across all of them, one HashKey transaction) |
| Live HashKey Chain transactions | Explorer only in the closing tour | Explorer cut inside S14 as well as the S26 tour of the hub, factory, router, token, mandate and settlement |
| Real AI agents | "A buyer agent gets a task" could read as scripted | S10 shows the merchant's own OpenAI key; S11 says "a real OpenAI model, not a script"; S16 shows the ops agent's real run timeline |
| Merchant point of view (past HashKey winners) | Present | Kept: the story is a merchant, and the demo ends in refund and reconciliation |
| Mainnet deployment (`docs/SUBMISSION.md` requirement 3 says no mainnet contracts can forfeit demo selection) | Not addressed | Cannot be fixed in a script; the video says "No mainnet deploy yet" honestly, and this is raised as an open risk for the founder |
| Video length | ETHGlobal limits videos to 2 to 4 minutes, and `docs/SUBMISSION.md` plans a 2-minute video | The brief asks for 4 to 5 minutes; `STORYBOARD.md` lists a 2-minute cut (acts 1, 3, 4 and 7) if the DoraHacks form needs it |

## Pass D: timing at about 150 words a minute

| Measure | Draft 1 | After cuts, first voice (speed 0.95) | Final voice (speed 1.08) |
|---|---|---|---|
| Words | 717 | 717 | 693 |
| Planned or voiced length | 311 s planned | 318.6 s of voice, 339 s with gaps | 263.8 s of voice, 281.2 s with gaps |
| Pace | 138 words a minute | 135 words a minute | 158 words a minute (spoken), 148 with scene gaps |

Fixes from this pass:
- Cut the hosted-trap scene (8 s).
- Trimmed S02, S05, S07, S09, S12, S14, S19, S23, S24 and S26 by one clause each (24 words).
- Shortened the spoken ask fallback.
- Set the voice speed to 1.08, which lands at about 150 words a minute across the cut including the gaps between scenes.
- Each scene now lasts exactly its voice plus 0.25 s lead and 0.35 s tail, so nothing is cut off and no scene holds dead air.
- Longest scene: S14 at 18.7 s, which carries the HSP honesty line and is worth the time for Track 2.

## Voice checks

- Test clip first: the S02 story line in two voices (Slax and Ethan) at speed 1.0 under `audio/test/`; Slax read at 165 words a minute, Ethan at 200, and Slax was picked for the calmer, clearer delivery.
- Full run: 27 lines, 263.8 s, every line between -22.4 and -20.5 dB mean volume.
- No cue words leaked into any word list (checked programmatically over all 27 lines).
- Independent transcription (`hyperframes transcribe -m base.en`) of S03, which carries a `[frustrated]` cue, matches the script word for word; the cue is not spoken.
- Whisper writes "Payminto" as "Payment 2" and "HashKey" as "Hashki"; this is a transcription limit, but a human should listen to S05, S07 and S14 before upload and, if needed, regenerate those lines with `--only 5,7,14`.

## Pass E: fact update from the live runs (2026-11-03)

| What changed | Script change | Lines regenerated |
|---|---|---|
| Merchant agents run on Claude Haiku 5.5 with the business's own Anthropic key; OpenAI, Google Gemini, OpenAI-compatible endpoints and Replicate are also supported (`docs/AGENTS.md` section 1) | S10 now names Claude Haiku from Anthropic and the other providers; S11 says "a real Anthropic model" | S10, S11 |
| The buyer buys a live HSK quote from Market Data (CoinGecko), then pays the seller's market-brief skill with that quote, and the brief is written only from those figures | S13 rewritten as a three-party chain | S13 |
| The wallet payment ran on HashKey Chain Testnet; Sepolia carried the settlement, AI skill settlement and refund | S09 now says "paid in test USDC on HashKey Chain Testnet"; S26 now names the payments, the refund and the settlements, then "the same contracts on Ethereum Sepolia, settling Circle's testnet USDC" | S09, S26 |
| Confirmations at the latest head in the live runs | Not spoken; stated in `YOUTUBE.md`, `DORAHACKS.md` and the shot list as a testnet demo setting | none |

"Claude" alone was heard as "cloud" by the transcriber, so S11 says "Anthropic model" instead; "Gemini" was heard as "Jim and I", so S10 says "Google Gemini".

## Pass F: pronunciation of Payminto and HashKey

Goal: pay-MIN-toe and HASH-key, in the Slax voice at speed 1.08, checked by transcribing every regenerated line.

Tried (test files in `audio/test-phoneme/`):

| Method | Payminto heard as | HashKey heard as |
|---|---|---|
| Plain text (first voice) | "Payment 2" | "Hashki" |
| Fish Audio Arpabet phoneme tags, `<\|phoneme_start\|>P EY2 M IH1 N T OW0<\|phoneme_end\|>` and `HH AE1 SH K IY0` | "paymento" | "Hashki" or "hashkeychain" |
| Respelling "Pay-min-toe" and "Hash-key" | "paymento" | "hashkeychain" |
| Respelling "pay min toe" and "hash key" | "Paymento" | "hash keychain" |
| Respelling "Pay Mint-oh" | "PayMinto" | - |

Chosen: respelling "Pay Mint-oh" and "Hash Key" in the spoken text only (`video/build.mjs`, `RESPELL`); captions merge the words back to "Payminto" and "HashKey".
Fish's phoneme tags are documented for English, but on `s2.1-pro-free` they did not move the transcript closer than respelling did.

Regenerated: S01, S05, S07, S09, S10, S11, S13, S14, S24, S26, S27 (every line with Payminto or HashKey, plus the fact changes).
Lines that did not transcribe as Payminto on the first take were regenerated until they did (Fish output varies per take):

| Line | Final transcript of the brand words (Whisper small.en) |
|---|---|
| S01 | "This is PayMinto." (second take; the first gave "Pei Minto") |
| S05 | "So we built PayMinto" (third take; the first two gave "payment. Oh") |
| S07 | "HSP settles on hash keychain. PayMinto is the missing middle." |
| S09 | "on hash keychain testnet" |
| S10 | "This demo runs DeepSeek v3.1 through Replicate" (regenerated again in pass G) |
| S11 | "This is a real AI model, not a script." (regenerated again in pass G) |
| S14 | "pay minto nets every agent", "hashkeychain testnet", "Hashkey's live HSP server" |
| S24 | "the hash key ecosystem" |
| S26 | "on hash key chain testnet", "Ethereum-Sapolia" |
| S27 | "Pay Minto, get paid by people and AI agents" |

Whisper spells unknown names its own way, so a human ear check is still the final test, but every line now splits the brand as pay-MIN-toe and HASH-key rather than "payment two" and "Hashki".
After pass G the cut is 297.4 s (4:57).

## Pass G: model correction (2026-11-03)

The Anthropic key used for the first live runs was a short-lived token and stopped working (401).
The demo agents now run DeepSeek V3.1 through Replicate with the business's own Replicate token; a full live Sepolia run on DeepSeek V3.1 via Replicate then passed every check (clearing, gateway and AI).

| Before | After |
|---|---|
| S10: "Here it is Claude Haiku from Anthropic, and OpenAI, Google Gemini and others work the same way." | "This demo runs DeepSeek V3.1 through Replicate, and other major providers work the same way." |
| S11: "This is a real Anthropic model, not a script." | "This is a real AI model, not a script." |

No line names Claude or OpenAI as the demo model any more; the provider list (Anthropic, OpenAI, Google Gemini, OpenAI-compatible such as OpenRouter, Replicate) stays on screen and in `PITCH.md`, `YOUTUBE.md` and `DORAHACKS.md`.
"V3.1" is respelled "V three point one" for the voice and merged back to "V3.1" in the captions.
Both lines were regenerated and transcribed: S10 "This demo runs DeepSeek v3.1 through Replicate, and other major providers work the same way."; S11 "This is a real AI model, not a script."
