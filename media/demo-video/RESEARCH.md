# Demo video research: what winning demos do

Researched on 2026-11-03 with web search and page reads only; no videos were downloaded.
Where a source is a vendor blog or a secondary write-up, it is labelled as such, and its numbers are treated as claims, not facts.

## 1. The demos and guides studied

### 1.1 Dropbox: the original screencast (2007, beta video 2008)

Source: Alexander Jarvis, "Dropbox doing things that don't scale" (https://www.alexanderjarvis.com/dropbox-doing-things-that-dont-scale/); Nira, Dropbox history (https://nira.com/dropbox-history/); TechCrunch Founder Stories (https://techcrunch.com/2011/10/30/founder-stories-drew-houston-dropbox-users-save-a-billion-files-every-three-days/amp/).
What it does well:
- Hook: no logo intro, it opens on the real product doing the one thing it promises (a file appearing on another machine).
- Story arc: a single, ordinary workflow told end to end, so the viewer recognises their own problem.
- Live product: an unpolished but real screencast; nothing is faked, which is what made people trust it.
- Audience: in-jokes aimed at the exact community watching (it was posted where its early users already were).
- Result: secondary sources report the beta waitlist going from about 5,000 to about 75,000 overnight; the sources disagree on the date and the site, so we do not quote the number in our own material.

### 1.2 Apple: iPhone introduction, Macworld 2007

Source: Macworld retrospective (https://www.macworld.com/article/227736/apple-at-40-remembering-when-steve-jobs-went-electric.html); MacRumors (https://macrumors.com/2014/01/09/7-years-ago-jobs-iphone); Signpost analysis (https://signpost.beehiiv.com/p/the-birth-of-the-modern-keynote).
What it does well:
- Greeting and promise first: a warm, personal open, then a big claim before any product is shown.
- The refrain: three things named one by one, repeated, then the reframe that they are one thing.
- Delayed reveal: a deliberate pause before the product appears, so the payoff lands.
- Live demo as proof: every claim is followed by the real device doing it on stage.

### 1.3 ETHGlobal: official demo video guidance (hackathon judging)

Source: ETHGlobal Cannes event details (https://ethglobal.com/events/cannes/info/details); ETHGlobal Superhack details (https://ethglobal.com/events/superhack/info/details).
What it asks for:
- 2 to 4 minutes, 720p or higher, not sped up to fit the limit.
- Backstory kept to about 20 seconds; then show the project working, with waiting cut out.
- Slides with no more than 4 bullet points.
- Spoken explanation, not music over on-screen text.
- ETHGlobal rejects text-to-speech or AI voiceover for its own events.
  HashKey's rules are not confirmed in the repo (the DoraHacks page sits behind a WAF; `research/01-hsp-hashkey-tech.md` section 0), so we treat the Fish Audio voice as a scratch track and backup, and recommend the founder records the final voice over the same script and timing.

### 1.4 Y Combinator: Demo Day guide

Source: Geoff Ralston, "A Guide to Demo Day Presentations" (https://www.ycombinator.com/blog/guide-to-demo-day-pitches/); Paul Graham, "How to Present to Investors" (https://paulgraham.com/investors.html).
What it does well:
- Say what the company does in plain words in the first moments.
- Build the talk on three or four "vertebrae" the listener will remember.
- Traction shown honestly; without traction, lean on story and vision rather than inflated graphs.
- Slides make one point each, few words, large type.
- The goal of a short pitch is to make the listener want the next meeting, not to explain everything.

### 1.5 Product demo editing: an editor's breakdown of 20 demos (Monday.com, Slack, Trello, Notion, Linear, Superhuman)

Source: Vidpros, "20 Best Product Demo Videos: An Editor's Breakdown" (https://vidpros.com/best-product-demo-videos/), a vendor blog.
What it observes:
- Open with pain, a result, the product in action, or a real face within the first 7 seconds.
- Show real software actions early (the article puts the "trust beat" by about 0:14).
- Short shots (under 3 seconds) in the opening; longer holds (5 to 7 seconds, as in Linear's release videos) when the UI itself carries the story.
- Slack's "old way, new way" cut at about 0:09 makes the problem visible before the product.
- Notion's clips get most of their polish from automated zooms and a clean, focused cursor.
- Captions must be large and held long enough to read.
- Voiceover around 145 words a minute, warm and conversational.

### 1.6 HashKey Chain Horizon: what past payment winners did

Source: `docs/PRODUCT_PLAN.md` section 2 and the repository's market research `research/03-market-competitors.md`.
What it shows:
- Past HashKey payment winners solved a named business workflow and took the merchant's point of view (AllScale, Japan, first place, "makes merchants safe to get paid").
- Spend-limit wallets and payment links alone did not win in Hong Kong.
- Track 2 requires HSP, and the submission checklist expects HashKey Chain contracts and a live demo walked step by step (`docs/SUBMISSION.md`, requirement checklist).

### 1.7 Hook and opening research (vendor guides)

Sources: JoinBrands, product demo script guide (https://joinbrands.com/blog/product-demo-video-script/); Vidico, best explainer videos (https://vidico.com/news/best-explainer-videos-for-startups/); Advids on PLG hooks (https://advids.co/insights/the-art-of-the-hook-capturing-attention-instantly-in-plg-saas-youtube-videos).
What they agree on:
- The viewer should think "that is my problem" before "that is your product".
- Hook within the first 10 seconds, then the product solving it, then one call to action.
- Their drop-off statistics are vendor claims and are not used in our script.

## 2. Patterns we copy

1. **Warm greeting, then a person with a problem.**
   Open with a hello and one concrete merchant (an Indian API seller whose customer is now an AI agent), told in under 20 seconds, as ETHGlobal and the Dropbox screencast both do.
2. **That is my problem before that is your product.**
   Show the pain as an "old way" beat (an agent with an open wallet, a fee bigger than the sale) before the product appears, like Slack's old way, new way cut.
3. **One refrain.**
   Like the iPhone open, name three things and pay them off as one: "a budget, a bill, a proof" becomes "one link".
4. **Real product by the 30-second mark, then mostly real product.**
   About 80% of the demo act is real screen recording of the dashboard and CLI, composed with motion graphics: animated cursor focus, zooms on the number that matters, highlight boxes, kinetic type.
5. **Cut dead time, never speed up.**
   Agent thinking and block confirmations are cut or covered with a short "a few seconds later" wipe; the footage itself plays at real speed.
6. **Snap transitions between acts.**
   Each act opens with a one-second kinetic title and a hard cut: greeting and story, problem, product, live demo, pitch, go to market, on-chain proof, close.
7. **Slides with one point and at most 4 bullets.**
   Pitch and go-to-market slides follow YC and ETHGlobal: one idea each, large type, a source line at the bottom.
8. **Honest traction.**
   Say "testnet, no external users yet" plainly; judges and investors trust a clear status more than a vague one.
9. **Proof as the close.**
   End on the chain: explorer pages for the contracts and the settlement, then a single call to action (the repository).
10. **Readable captions.**
    Large, high-contrast, 3 to 5 words a group, held long enough, timed to the real voice.
11. **Voice at about 145 to 150 words a minute, warm and conversational.**
    Generated with Fish Audio as a scratch and backup track; the founder's own recording is recommended for the final upload if HashKey follows ETHGlobal's no-AI-voice rule.
