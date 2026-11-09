// S16: the ops agent answers "what did we earn today". The answer arrives from the model;
// the script waits for it, and the edit cuts the wait.
export const needs = ["OPS_AGENT_ID"];
export const segments = (cfg) => [{
  name: "ask", url: `${cfg.BASE_URL}/agents/${cfg.ids.OPS_AGENT_ID}`, ready: { text: "Ask" },
  act: async (h) => {
    await h.type("textarea", "What did we earn today?");
    await h.click('button[aria-label="Ask"]', 600);
    // A live model run: fail the shot rather than film a question that never got an answer.
      await h.page.getByText("Wrote the answer", { exact: false }).first().waitFor({ timeout: 180000 });
    await h.wait(800); await h.scrollBy(500, 1200); await h.wait(1500);
  },
}];
