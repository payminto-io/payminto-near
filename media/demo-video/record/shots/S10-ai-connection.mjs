// S10: the business's own Replicate token running deepseek-ai/deepseek-v3.1, and the provider list.
export const needs = [];
export const segments = (cfg) => [{
  name: "ai models", url: `${cfg.BASE_URL}/settings/ai`, ready: { text: "Replicate" },
  act: async (h) => {
    await h.moveTo("text=Replicate", 800); await h.zoom("text=Replicate >> xpath=ancestor::li[1]", 1.5, 1500);
    await h.click("text=Add connection", 700); await h.wait(1600); await h.page.keyboard.press("Escape"); await h.wait(500);
  },
}];
