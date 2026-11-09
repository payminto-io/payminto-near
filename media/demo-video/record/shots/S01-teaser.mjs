// S01: a slow pass over the dashboard Overview; it plays soft-focus behind the greeting.
export const needs = [];
export const segments = (cfg) => [{
  name: "overview", url: `${cfg.BASE_URL}/`, ready: { text: "Paid" },
  act: async (h) => { await h.moveTo({ x: 1300, y: 420 }, 1500); await h.scrollBy(420, 3000); await h.wait(1200); await h.scrollBy(-420, 2200); },
}];
