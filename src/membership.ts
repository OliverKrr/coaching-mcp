import type { User } from "./auth/db.js";
import {
  countPendingUsers,
  createPendingUser,
  deleteQuotaRequest,
  deleteUser,
  findUserBySubOrEmail,
  getUser,
  revokeUserAccess,
  setUserQuota,
  setUserStatus,
  upsertUserOnLogin,
} from "./auth/db.js";
import { deleteAllUserSecrets } from "./auth/secrets.js";
import { isEmailAllowed, registrationOpen } from "./auth/allowlist.js";
import type { OidcIdentity } from "./auth/oidc.js";
import type { ServeContext } from "./context.js";
import { deleteUserGateways } from "./gateways.js";
import type { McpSessionManager } from "./mcp-http.js";

/**
 * Membership: who may log in, and the status transitions behind the admin
 * page and the Telegram buttons. Access lives in auth.db (`users.status`);
 * `ALLOWED_EMAILS`/`ADMIN_EMAILS` are the env-side bootstrap that skips the
 * approval step (and the operator's lockout recovery).
 */

/** Backstop against registration spam — beyond this, registration closes. */
export const MAX_PENDING_USERS = 100;

export type LoginDecision =
  | { kind: "active"; user: User }
  | { kind: "pending"; user: User; created: boolean }
  | { kind: "denied" } // rejected/disabled/unverified — deliberately indistinct
  | { kind: "closed" }; // REGISTRATION=closed or pending backstop reached

export function resolveLogin(ctx: ServeContext, identity: OidcIdentity): LoginDecision {
  if (!identity.emailVerified) return { kind: "denied" };

  // Bootstrap allowlist and admins win over any stored status — this is the
  // recovery path, and adding an email there auto-approves a pending request.
  if (isEmailAllowed(identity.email)) {
    return { kind: "active", user: upsertUserOnLogin(ctx.authDb, identity) };
  }

  const existing = findUserBySubOrEmail(ctx.authDb, identity.sub, identity.email);
  if (existing) {
    if (existing.status === "active") {
      return { kind: "active", user: upsertUserOnLogin(ctx.authDb, identity) };
    }
    if (existing.status === "pending") return { kind: "pending", user: existing, created: false };
    return { kind: "denied" };
  }

  if (!registrationOpen() || countPendingUsers(ctx.authDb) >= MAX_PENDING_USERS) {
    return { kind: "closed" };
  }
  const user = createPendingUser(ctx.authDb, identity);
  ctx.log(`registration request: ${user.email} (${user.id})`);
  return { kind: "pending", user, created: true };
}

// ---------------------------------------------------------------------------
// Status transitions — shared by /admin forms and Telegram callbacks.

export function approveUser(ctx: ServeContext, userId: string): User | undefined {
  const user = getUser(ctx.authDb, userId);
  if (!user) return undefined;
  setUserStatus(ctx.authDb, userId, "active");
  ctx.log(`user approved: ${user.email} (${userId})`);
  ctx.notify.userApproved({ ...user, status: "active" }, ctx.cfg.publicUrl);
  return user;
}

export function rejectUser(ctx: ServeContext, userId: string): User | undefined {
  const user = getUser(ctx.authDb, userId);
  if (!user) return undefined;
  // The row is kept so repeat logins stay cheap and silent (no re-notification).
  setUserStatus(ctx.authDb, userId, "rejected");
  ctx.log(`user rejected: ${user.email} (${userId})`);
  return user;
}

export function disableUser(ctx: ServeContext, userId: string): User | undefined {
  const user = getUser(ctx.authDb, userId);
  if (!user) return undefined;
  setUserStatus(ctx.authDb, userId, "disabled");
  revokeUserAccess(ctx.authDb, userId); // connected clients die on their next request
  ctx.log(`user disabled: ${user.email} (${userId})`);
  return user;
}

export function enableUser(ctx: ServeContext, userId: string): User | undefined {
  const user = getUser(ctx.authDb, userId);
  if (!user) return undefined;
  setUserStatus(ctx.authDb, userId, "active");
  ctx.log(`user re-enabled: ${user.email} (${userId})`);
  return user;
}

/** Grant a quota-increase request (or set a quota directly; null = default). */
export function grantQuota(
  ctx: ServeContext,
  userId: string,
  quotaMb: number | null,
): User | undefined {
  const user = getUser(ctx.authDb, userId);
  if (!user) return undefined;
  setUserQuota(ctx.authDb, userId, quotaMb);
  deleteQuotaRequest(ctx.authDb, userId);
  ctx.log(`quota set for ${user.email} (${userId}): ${quotaMb ?? "default"} MB`);
  if (quotaMb !== null) ctx.notify.quotaGranted(user, quotaMb);
  return user;
}

/**
 * Remove a user and everything the server holds about them — the shared
 * implementation behind self-service account deletion and the admin page.
 */
export async function purgeUser(
  ctx: ServeContext,
  mcpSessions: McpSessionManager,
  userId: string,
): Promise<User | undefined> {
  const user = getUser(ctx.authDb, userId);
  if (!user) return undefined;
  await mcpSessions.closeUserSessions(userId);
  ctx.tenants.deleteUserData(userId);
  deleteUserGateways(ctx.authDb, userId);
  deleteAllUserSecrets(ctx.authDb, userId);
  deleteUser(ctx.authDb, userId); // also removes tokens + web sessions
  ctx.log(`account deleted: ${user.email} (${userId})`);
  return user;
}
