// S09: create a link, pay it as a customer, show Paid and the fee split, open the explorer.
// The wallet signature happens in a browser wallet, which headless Chromium cannot drive:
// record the checkout payment itself with a screen recorder, and use this script for the
// dashboard and explorer parts (it records link creation, the paid payment and the transaction).
export const needs = ["PAYMENT_ID"];
export const segments = (cfg) => [
  { name: "new link", url: `${cfg.BASE_URL}/links/new`, ready: { text: "Title" },
    act: async (h) => {
      await h.type('#l-title', "Market dataset");
      await h.type('#l-amount', "2");
      await h.highlight('#l-amount', 900);
      await h.wait(600);
    } },
  { name: "paid payment", url: `${cfg.BASE_URL}/payments/${cfg.ids.PAYMENT_ID}`, ready: { text: "Paid" },
    act: async (h) => { await h.highlight("text=Paid", 1100); await h.scrollTo("text=Fee", 900); await h.zoom("text=Fee", 1.6, 1200); } },
  { name: "explorer", url: `${cfg.explorer.hashkey}/tx/${cfg.explorer.hashkeyTx.walletPayment}`, ready: { text: "Transaction details" }, hideText: ["Launch your own"],
    act: async (h) => { await h.moveTo("text=Success", 700); await h.highlight("text=Success", 1000); } },
];
