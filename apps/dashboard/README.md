# Payminto Clearing dashboard

Operator console for a Payminto Clearing node: mandates, providers, live calls, netting, batches with HSP status, receipt proofs and the double-entry ledger.

Next.js 16 (App Router), React 19, Tailwind 4, shadcn/ui on Radix, TanStack Query, Recharts, viem.

## Run

```bash
pnpm install                                  # from the repo root
pnpm --filter dashboard dev:mock              # in-browser mock node with fixtures, http://localhost:3000
NEXT_PUBLIC_MOCK=empty pnpm --filter dashboard dev   # fresh mock node, shows the first-run guide
NEXT_PUBLIC_NODE_URL=http://localhost:8787 pnpm --filter dashboard dev   # a live clearing node
```

Against a live node, sign in with the node's `ADMIN_TOKEN`.
For a local node (`localhost`) the field is prefilled with `dev-admin-token`.
The node must allow the dashboard origin in `CORS_ORIGINS` (default `http://localhost:3000`).
Mandates can be signed with a browser wallet (EIP-1193), or with a pasted development key on the local anvil chain (31337) only.

## Check

```bash
pnpm --filter dashboard lint
pnpm --filter dashboard typecheck
pnpm --filter dashboard test
pnpm --filter dashboard build
```

## Layout

- `lib/api.ts` typed client for SPEC 5.6, every response parsed with the zod schemas in `lib/schemas.ts`.
- `lib/mock/server.ts` the mock node, built on `@payminto/protocol` so Merkle proofs and netting are real.
- `lib/live.tsx` SSE subscription (`/v1/events?token=`) that refreshes the affected screens.
- `lib/netting.ts` the hub's netting algorithm, the two-column flow layout and the before-versus-after figures used on the Netting screen.
- `lib/denials.ts` plain-language names for each policy rule and the per-rule summary on Blocked calls.
- `lib/agents-api.ts` the merchant AI agent routes (docs/AGENTS.md section 6); `lib/agents.ts` plain words, the run timeline, polling rules and who may do what; `lib/run-follower.ts` follows one run from the live stream, falling back to `?wait=25` long polls and `events?after=`; `lib/mock/agents.ts` the demo connections, agents and runs with a step-by-step worker.
- `lib/spend.ts` the mandate budget bar and validity countdown; `lib/proof.ts` the individual checks behind a receipt verdict.
- `docs/screenshots/` reference captures; `live-anvil-*` were taken against a real node on anvil, `v2-*` after the Mobbin-informed redesign, `v3-*` from a `pnpm demo:stage` film run at 1920x1080 (dark) and 1440x900 (light), with `v3-before-*` showing the same screens before the camera-ready pass.
- `docs/DESIGN_REFERENCES.md` the Mobbin references behind each screen.
