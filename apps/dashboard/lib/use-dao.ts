"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NearReadError, type AccountId } from "@payminto/protocol";
import { useApi } from "./session";
import { useInfo } from "./queries";
import { useWallet } from "./use-wallet";
import { readErrorText } from "./near-reader";
import { daoAbility, daoPolicySchema, daoProposalSchema, latestProposalsArgs, policyUsesTokenRoles, PROPOSAL_PAGE, type DaoAbility, type DaoAddon, type DaoPolicy, type DaoProposal } from "./dao";

export const daoKey = (dao: string | null) => ["dao", dao ?? "none"] as const;

/** One sentence for a DAO read that did not work. Never the RPC's raw error. */
export function daoReadErrorText(e: unknown, dao: string): string {
  if (e instanceof NearReadError) {
    if (e.kind === "not_found") return `No contract answers at ${dao} on this network. Check the DAO's account.`;
    if (e.kind === "contract_error") return `${dao} did not answer as a Sputnik DAO does. Check that it is the DAO's own account.`;
    if (e.kind === "invalid_response") return "The DAO answered with something this page does not understand.";
    return readErrorText(e);
  }
  if (e instanceof Error && e.name === "ZodError") return "The DAO answered in a shape this page does not understand. It may run a different DAO contract.";
  if (e instanceof Error && e.message === "NO_RPC") return "No NEAR RPC is configured for this network, so the DAO could not be read.";
  return "The DAO could not be read. Try again.";
}

/** The add-on's DAO module, loaded when a DAO screen first needs it. */
export function useDaoAddon(enabled = true) {
  return useQuery<DaoAddon>({ queryKey: ["near-addons", "dao"], queryFn: async () => (await import("@payminto/near-addons")).dao, enabled, staleTime: Infinity, gcTime: Infinity, retry: 1 });
}

function useReader() {
  const api = useApi();
  const info = useInfo();
  return useMemo(() => (info.data ? api.nearReader(info.data) : null), [api, info.data]);
}

/** The DAO's policy, read from `get_policy` at final finality. */
export function useDaoPolicy(dao: AccountId | null) {
  const source = useReader();
  const info = useInfo();
  return useQuery<DaoPolicy>({
    queryKey: [...daoKey(dao), "policy", source?.reader.rpcUrl ?? "none"],
    enabled: Boolean(dao) && info.isSuccess,
    queryFn: async () => {
      if (!source) throw new Error("NO_RPC");
      return daoPolicySchema.parse((await source.reader.view<unknown>(dao!, "get_policy", {})).value);
    },
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** The DAO's newest proposals: `get_last_proposal_id`, then one page of `get_proposals`. Refreshed while the page is open. */
export function useDaoProposals(dao: AccountId | null) {
  const source = useReader();
  const info = useInfo();
  return useQuery<{ proposals: DaoProposal[]; total: number }>({
    queryKey: [...daoKey(dao), "proposals", source?.reader.rpcUrl ?? "none"],
    enabled: Boolean(dao) && info.isSuccess,
    queryFn: async () => {
      if (!source) throw new Error("NO_RPC");
      const last = (await source.reader.view<unknown>(dao!, "get_last_proposal_id", {})).value;
      if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0) throw new NearReadError("invalid_response", `${dao}.get_last_proposal_id`, "not a count");
      if (last === 0) return { proposals: [], total: 0 };
      const rows = (await source.reader.view<unknown>(dao!, "get_proposals", latestProposalsArgs(last))).value;
      return { proposals: daoProposalSchema.array().parse(rows), total: last };
    },
    refetchInterval: 15_000,
    retry: false,
  });
}

export type DaoMembership = {
  /** The connected wallet account, or null. */
  account: AccountId | null;
  ability: DaoAbility | null;
};

/** What the connected account may do in this DAO. Token roles are judged from `delegation_balance_of` when the policy has any. */
export function useDaoMembership(dao: AccountId | null, policy: DaoPolicy | undefined): DaoMembership {
  const { account } = useWallet();
  const source = useReader();
  const needsStake = Boolean(policy && account && policyUsesTokenRoles(policy));
  const stake = useQuery<bigint>({
    queryKey: [...daoKey(dao), "stake", account ?? "none"],
    enabled: needsStake && Boolean(source),
    queryFn: async () => BigInt(String((await source!.reader.view<unknown>(dao!, "delegation_balance_of", { account_id: account })).value)),
    staleTime: 60_000,
    retry: false,
  });
  const ability = useMemo(() => (policy ? daoAbility(policy, account, needsStake ? (stake.data ?? null) : null) : null), [policy, account, needsStake, stake.data]);
  return { account, ability };
}

export { PROPOSAL_PAGE };
