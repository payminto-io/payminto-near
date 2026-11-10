/**
 * Permissions as the server names them (docs/PRODUCT.md section 10.4). The session object carries the actor's grants;
 * the sidebar, the palette and every button read them through `can`. The server checks the same table on every route,
 * so hiding is cosmetic and never the control.
 */

export type PlatformRole = "owner" | "admin";
export type BusinessRole = "admin" | "staff" | "viewer";

export const PLATFORM_PERMISSIONS = [
  "platform.read",
  "platform.manage",
  "pricing.read",
  "pricing.manage",
  "businesses.read",
  "businesses.manage",
  "earnings.read",
  "team.read",
  "team.manage",
  "signups.review",
  "outbox.read",
  "audit.read",
  "agents.read",
  "agents.manage",
  "settlements.run",
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const BUSINESS_PERMISSIONS = [
  "payments.read",
  "payments.write",
  "links.write",
  "refunds.request",
  "refunds.issue",
  "refunds.approve",
  "payout.change",
  "business.update",
  "methods.terms",
  "developers.manage",
  "screening.read",
  "screening.manage",
  "members.read",
  "members.manage",
  "audit.read",
] as const;
export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];

export type Permission = PlatformPermission | BusinessPermission;

/** `businesses` maps a merchant id to its permissions; `"*"` applies to every business (platform roles). */
export type Grants = { platform: readonly string[]; businesses: Readonly<Record<string, readonly string[]>> };

export const NO_GRANTS: Grants = { platform: [], businesses: {} };

/** Where a check applies: the platform, or one business. */
export type Scope = { kind: "platform" } | { kind: "business"; merchantId: string };
export const PLATFORM_SCOPE: Scope = { kind: "platform" };

const isPlatformPermission = (p: Permission): p is PlatformPermission => (PLATFORM_PERMISSIONS as readonly string[]).includes(p);

export function businessGrants(grants: Grants, merchantId: string | null): readonly string[] {
  const own = merchantId ? grants.businesses[merchantId] : undefined;
  return own ?? grants.businesses["*"] ?? [];
}

/**
 * True when the actor holds the permission in this scope. A business permission on the platform scope asks whether
 * it holds on every business (`"*"`); `audit.read` counts from either table.
 */
export function can(grants: Grants, permission: Permission, scope: Scope = PLATFORM_SCOPE): boolean {
  // `audit.read` lives in both tables: all businesses for platform roles, one business for its Admins.
  if (permission === "audit.read") return grants.platform.includes("audit.read") || businessGrants(grants, scope.kind === "business" ? scope.merchantId : null).includes("audit.read");
  if (isPlatformPermission(permission)) return grants.platform.includes(permission);
  return businessGrants(grants, scope.kind === "business" ? scope.merchantId : null).includes(permission);
}

// ---------------------------------------------------------------------------
// The role table itself (10.4), used by the mock server and as a fallback when a session object carries no grants.
// ---------------------------------------------------------------------------

const BUSINESS_BY_ROLE: Record<BusinessRole, readonly BusinessPermission[]> = {
  admin: ["payments.read", "payments.write", "links.write", "refunds.request", "refunds.issue", "refunds.approve", "payout.change", "business.update", "developers.manage", "screening.read", "screening.manage", "members.read", "members.manage", "audit.read"],
  staff: ["payments.read", "payments.write", "links.write", "refunds.request", "screening.read", "members.read"],
  viewer: ["payments.read", "screening.read", "members.read"],
};

const PLATFORM_BY_ROLE: Record<PlatformRole, readonly PlatformPermission[]> = {
  owner: PLATFORM_PERMISSIONS,
  admin: ["platform.read", "pricing.read", "businesses.read", "businesses.manage", "team.read", "signups.review", "audit.read", "agents.read", "agents.manage", "settlements.run"],
};

const ALL_BUSINESS: readonly BusinessPermission[] = BUSINESS_PERMISSIONS;

export function grantsFor(user: { platformRole: PlatformRole | null; memberships: { merchantId: string; role: BusinessRole }[] } | "recovery_key"): Grants {
  if (user === "recovery_key") return { platform: PLATFORM_PERMISSIONS, businesses: { "*": ALL_BUSINESS } };
  const businesses: Record<string, readonly string[]> = {};
  for (const m of user.memberships) businesses[m.merchantId] = BUSINESS_BY_ROLE[m.role];
  if (user.platformRole === "owner") businesses["*"] = ALL_BUSINESS;
  // A platform admin holds every business permission except changing a payout wallet.
  if (user.platformRole === "admin") businesses["*"] = ALL_BUSINESS.filter((p) => p !== "payout.change");
  return { platform: user.platformRole ? PLATFORM_BY_ROLE[user.platformRole] : [], businesses };
}

// ---------------------------------------------------------------------------
// Plain role names and tooltips (section 2.2)
// ---------------------------------------------------------------------------

export type RoleLabelKey = "platform_owner" | "platform_admin" | "recovery_key" | BusinessRole;

export function roleKey(platformRole: PlatformRole | null, businessRole: BusinessRole | null, actorType: "user" | "recovery_key" = "user"): RoleLabelKey | null {
  if (actorType === "recovery_key") return "recovery_key";
  if (platformRole) return platformRole === "owner" ? "platform_owner" : "platform_admin";
  return businessRole;
}

export const ROLE_LABEL: Record<RoleLabelKey, string> = {
  platform_owner: "Platform owner",
  platform_admin: "Platform admin",
  recovery_key: "Recovery key",
  admin: "Admin",
  staff: "Staff",
  viewer: "Viewer",
};

export const ROLE_TOOLTIP: Record<RoleLabelKey, string> = {
  platform_owner: "Runs this Payminto server and adds businesses. Payminto charges no processing fee.",
  platform_admin: "Helps the platform owner manage businesses; cannot change platform pricing, the fee wallet, or remove the owner.",
  recovery_key: "Emergency access for the server owner; not a login.",
  admin: "Full control of one business: payout wallet, team, API keys, refunds.",
  staff: "Creates payment links, views payments, and requests refunds.",
  viewer: "Read-only access to payments and reports.",
};
