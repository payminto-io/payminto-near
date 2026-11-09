// S14: the settled batch with HSP status chips, the HSP method waiting for access, the explorer.
export const needs = ["BATCH_ID"];
export const segments = (cfg) => [
  { name: "batch", url: `${cfg.BASE_URL}/batches/${cfg.ids.BATCH_ID}`, ready: { text: "transfers" },
    act: async (h) => {
      // 60 charges netted into a few wallet-to-wallet transfers, each with its HSP status.
      await h.highlight("text=Charges cleared >> xpath=ancestor::div[1]", 1500);
      await h.zoom("text=Net transfers", 1.5, 1800);
      const rows = Math.min(await h.page.locator("text=Matched").count(), 4);
      for (let i = 0; i < rows; i++) { await h.moveTo(`text=Matched >> nth=${i}`, 500); await h.wait(600); }
      await h.scrollTo("text=ACCEPT", 1000); await h.highlight("text=ACCEPT", 1600); await h.wait(1200);
    } },
  { name: "methods", url: `${cfg.BASE_URL}/settings/methods`, view: cfg.ids.NORTHWIND_MERCHANT_ID, ready: { text: "HSP" },
    act: async (h) => { await h.wait(500); await h.moveTo("text=HSP", 700); await h.highlight("text=HSP >> xpath=ancestor::li[1]", 2000); await h.wait(800); } },
  { name: "explorer", url: `${cfg.explorer.hashkey}/tx/${cfg.explorer.hashkeyTx.clearingSettle}`, ready: { text: "Transaction details" }, hideText: ["Launch your own"],
    act: async (h) => { await h.wait(1200); await h.highlight("text=Success", 1200); await h.scrollTo("text=Tokens transferred", 1100, 300); await h.wait(3200); } },
];
