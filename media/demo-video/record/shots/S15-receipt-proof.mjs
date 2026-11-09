// S15: one call's receipt and its Merkle proof verified on chain.
export const needs = ["CALL_ID"];
export const segments = (cfg) => [{
  name: "receipt", url: `${cfg.BASE_URL}/receipts/${cfg.ids.CALL_ID}`, ready: { text: "Verified on chain" },
  act: async (h) => { await h.highlight("text=Verified on chain", 1200); await h.scrollTo("text=Merkle path recomputed", 800); await h.highlight("text=Merkle path recomputed", 1100); await h.moveTo("text=ClearingHub.verifyReceipt", 600); await h.zoom("text=ClearingHub.verifyReceipt", 1.5, 1300); },
}];
