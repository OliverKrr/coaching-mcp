import { existsSync, readFileSync } from "node:fs";

/**
 * Email allowlist: `ALLOWED_EMAILS` (comma-separated) merged with
 * `ALLOWED_EMAILS_FILE` (one address per line, `#` comments). The file is
 * re-read on every check, so operators can add a user without a restart.
 *
 * Since self-registration the allowlist is an optional pre-approval bootstrap
 * (and lockout recovery): listed addresses skip the approval step. `ADMIN_EMAILS`
 * addresses are implicitly allowed too and additionally gate /admin.
 */
export function isEmailAllowed(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return allowedEmails(env).has(normalized) || adminEmails(env).has(normalized);
}

export function isAdminEmail(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return adminEmails(env).has(normalized);
}

export function adminEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const emails = new Set<string>();
  for (const entry of (env.ADMIN_EMAILS ?? "").split(",")) {
    const e = entry.trim().toLowerCase();
    if (e) emails.add(e);
  }
  return emails;
}

/** Self-registration is on unless the operator sets REGISTRATION=closed. */
export function registrationOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REGISTRATION !== "closed";
}

export function allowedEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const emails = new Set<string>();
  for (const entry of (env.ALLOWED_EMAILS ?? "").split(",")) {
    const e = entry.trim().toLowerCase();
    if (e) emails.add(e);
  }
  const file = env.ALLOWED_EMAILS_FILE;
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const e = line.trim().toLowerCase();
      if (e && !e.startsWith("#")) emails.add(e);
    }
  }
  return emails;
}
