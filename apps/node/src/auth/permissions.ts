/**
 * Roles and permissions (PRODUCT.md 4.7 and 10.4). One table, read by `can()` on every route and served to the
 * dashboard in the session object, so hiding a button is cosmetic and never the control.
 */

export const PLATFORM_ROLES = ["owner", "admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const BUSINESS_ROLES = ["admin", "staff", "viewer"] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

/** Permissions that apply to one business. */
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

/** Permissions that apply to the whole server. */
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

export type Permission = BusinessPermission | PlatformPermission;

const ALL_BUSINESS: readonly BusinessPermission[] = BUSINESS_PERMISSIONS;

export const BUSINESS_ROLE_PERMISSIONS: Record<BusinessRole, readonly BusinessPermission[]> = {
  admin: ALL_BUSINESS.filter((p) => p !== "methods.terms"),
  staff: ["payments.read", "payments.write", "links.write", "refunds.request", "screening.read", "members.read"],
  viewer: ["payments.read", "screening.read", "members.read"],
};

/** Platform roles hold these on every business. */
export const PLATFORM_ROLE_BUSINESS_PERMISSIONS: Record<PlatformRole, readonly BusinessPermission[]> = {
  owner: ALL_BUSINESS,
  admin: ALL_BUSINESS.filter((p) => p !== "payout.change"),
};

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  owner: PLATFORM_PERMISSIONS,
  admin: [
    "platform.read",
    "pricing.read",
    "businesses.read",
    "businesses.manage",
    "team.read",
    "signups.review",
    "audit.read",
    "agents.read",
    "agents.manage",
    "settlements.run",
  ],
};

/** What a secret API key (sk_) may do for its own business: server-to-server, no people or keys. */
export const API_KEY_PERMISSIONS: readonly BusinessPermission[] = [
  "payments.read",
  "payments.write",
  "links.write",
  "refunds.request",
  "refunds.issue",
  "business.update",
  "developers.manage",
  "screening.read",
  "screening.manage",
];

export function isPlatformPermission(p: Permission): p is PlatformPermission {
  return (PLATFORM_PERMISSIONS as readonly string[]).includes(p) && !(BUSINESS_PERMISSIONS as readonly string[]).includes(p);
}

export function isBusinessRole(v: unknown): v is BusinessRole {
  return typeof v === "string" && (BUSINESS_ROLES as readonly string[]).includes(v);
}
