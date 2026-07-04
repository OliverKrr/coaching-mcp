import { existsSync, readFileSync } from "node:fs";

/**
 * Email allowlist: `ALLOWED_EMAILS` (comma-separated) merged with
 * `ALLOWED_EMAILS_FILE` (one address per line, `#` comments). The file is
 * re-read on every check, so operators can add a user without a restart.
 */
export function isEmailAllowed(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return allowedEmails(env).has(normalized);
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
