// S17: the ops agent requests a refund; a human approves it on Refunds.
// The business's refund approval rule must be on, or the refund goes out without approval.
export const needs = ["OPS_AGENT_ID", "REFUND_PAYMENT_ID"];
export const segments = (cfg) => [
  { name: "request", url: `${cfg.BASE_URL}/agents/${cfg.ids.OPS_AGENT_ID}`, ready: { text: "Ask" },
    act: async (h) => {
      await h.moveTo("textarea", 500); await h.page.fill("textarea", `Refund 0.01 USDC on payment ${cfg.ids.REFUND_PAYMENT_ID}, reason: demo`); await h.wait(500);
      await h.click('button[aria-label="Ask"]', 600);
      // A live model run: fail the shot rather than film a question that never got an answer.
      await h.page.getByText("Wrote the answer", { exact: false }).first().waitFor({ timeout: 180000 });
      await h.wait(800);
    } },
  // A human approves on the payment's page, where the Approve button lives.
  { name: "approve", url: `${cfg.BASE_URL}/payments/${cfg.ids.REFUND_PAYMENT_ID}`, ready: { text: "Approve" },
    act: async (h) => { await h.scrollTo('button:has-text("Approve")', 800); await h.click('button:has-text("Approve")', 700); await h.wait(2200); await h.highlight("text=Approved", 1000); } },
];
