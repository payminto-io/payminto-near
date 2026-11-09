// T14 (short cut): self-host with any AI agent. Public GitHub pages only; no sign-in.
// Timed to the T14 voice line (audio-short/audio_meta.json frame 14). 2 s handle at each end.
// README: the use-case image, "Watch the 5-minute demo", the "With your AI coding agent" line;
// then docs/SELF_HOST.md: the guide title, Path A (A2 runs your own node and dashboard), Path B (testnet server).
export const needs = [];
export const needsLogin = false;
const REPO = "https://github.com/sagarjethi/payminto-clearing";
export function segments() {
  return [
    {
      name: "README", url: REPO, ms: 5600, scale: 1.25, ready: { text: "Watch the 5-minute demo" },
      act: async (h) => {
        await h.scrollTo("article.markdown-body h1", 600, 110); await h.wait(1300);
        await h.moveTo("text=Watch the 5-minute demo", 400); await h.highlight("text=Watch the 5-minute demo", 500, 8);
        await h.scrollTo("article.markdown-body blockquote", 700, 330); await h.moveTo("article.markdown-body blockquote", 300); await h.highlight("article.markdown-body blockquote", 1200, 10);
      },
    },
    {
      name: "SELF_HOST", url: `${REPO}/blob/main/docs/SELF_HOST.md`, ms: 12200, scale: 1.25, ready: { text: "Path A" },
      act: async (h) => {
        await h.scrollTo("article.markdown-body h1", 300, 110);
        await h.moveTo("article.markdown-body h1", 500); await h.highlight("article.markdown-body h1", 500, 8);
        await h.scrollTo('article.markdown-body h3:has-text("A2.")', 1000, 150); await h.highlight('article.markdown-body h3:has-text("A2.")', 700, 8);
        await h.scrollTo('article.markdown-body h2:has-text("Path B")', 1200, 150); await h.highlight('article.markdown-body h2:has-text("Path B")', 900, 8);
        await h.scrollBy(650, 2800);
      },
    },
  ];
}
