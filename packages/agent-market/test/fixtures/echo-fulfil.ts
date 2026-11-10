// A fulfil module for the CLI tests: what `market work --fulfil <module>` loads. It buys nothing.
import type { Fulfil } from "../../src/index.ts";

export const fulfil: Fulfil = async (job, ctx) => ({
  deliverableMarkdown: `# Echo\n\nRound ${job.round}, ceiling ${ctx.spendCeilingAtomic}, ${job.tags.length} tags.`,
  receipts: [],
});
