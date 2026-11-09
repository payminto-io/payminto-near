// S13: the three-party chain: buyer pays Market Data for a live HSK quote, then pays the
// seller's market-brief skill with that quote; then the Netting flow graph.
export const needs = ["RUN_ID"];
export const segments = (cfg) => [
  { name: "run", url: `${cfg.BASE_URL}/agents/runs/${cfg.ids.RUN_ID}`, view: cfg.ids.SELLER_MERCHANT_ID, ready: { text: "Answer" },
    act: async (h) => {
      // The input carries the live quote the buyer paid Market Data for; the answer uses only its figures.
      await h.moveTo("text=Live quote", 700); await h.highlight("text=Live quote", 1300);
      await h.scrollTo("text=Answer", 900); await h.highlight("text=HSK spot price", 1400);
      await h.scrollBy(400, 1000); await h.wait(700);
    } },
  { name: "netting", url: `${cfg.BASE_URL}/netting`, view: "platform", ready: { text: "Next settlement" },
    act: async (h) => { await h.moveTo("text=Without bundling", 800); await h.highlight("text=Without bundling >> xpath=ancestor::div[2]", 1100); await h.moveTo("text=With bundling", 700); await h.highlight("text=With bundling >> xpath=ancestor::div[2]", 1400); } },
];
