// S12: the buyer's mandate (caps, payees, spent) and the receipts list.
export const needs = ["MANDATE_ID"];
export const segments = (cfg) => [
  { name: "mandate", url: `${cfg.BASE_URL}/mandates/${cfg.ids.MANDATE_ID}`, ready: { text: "Remaining budget" },
    act: async (h) => {
      for (const t of ["Remaining budget", "Daily limit", "Allowed services"]) { await h.moveTo(`text=${t}`, 500); await h.highlight(`text=${t} >> xpath=ancestor::div[1]`, 800); }
      await h.scrollBy(500, 1200); await h.wait(800);
    } },
  { name: "receipts", url: `${cfg.BASE_URL}/receipts`, ready: { text: "Receipts" },
    act: async (h) => { await h.moveTo({ x: 900, y: 420 }, 700); await h.scrollBy(300, 1400); await h.wait(800); } },
];
