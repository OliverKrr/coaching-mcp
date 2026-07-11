import type Database from "better-sqlite3";
import type { User } from "./auth/db.js";

/**
 * Per-user storage quotas — deliberately roomy (a legitimate SKILL.md is a few
 * KB; the 50 MB default is orders of magnitude of markdown headroom) but hard:
 * they exist to stop the server being used as free file storage and to keep
 * backups bounded, not to police normal coaching use.
 *
 * The metric is stored content characters (SQLite LENGTH), maintained by the
 * `*_bytes_*` triggers in db.ts and recomputed on every DB open. JS-side size
 * checks use string .length — the UTF-16 vs code-point difference is noise at
 * these thresholds.
 */

/** Per section/reference document. */
export const DOC_MAX_BYTES = 1024 * 1024;
/** Per journal entry, routine prompt, or open item. */
export const ENTRY_MAX_BYTES = 64 * 1024;
/** /mcp request body cap — fits a DOC_MAX document plus JSON envelope. */
export const MCP_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** Usage ratio at which tool responses start carrying a warning line. */
export const QUOTA_WARN_RATIO = 0.8;
/** Per-user MCP write budget — generous for sessions, stops runaway loops. */
export const WRITES_PER_MINUTE = 60;
/** Telegram quick-captures per user — humans type; bots hammering get cut. */
export const TELEGRAM_CAPTURES_PER_HOUR = 30;
/** notify_user messages per user per day — check-ins, not a spam channel. */
export const TELEGRAM_NOTIFY_PER_DAY = 20;

/**
 * Bound per MCP session in serve mode and handed to the write tools; absent in
 * single-user stdio mode (no limits there). Carries no identity — the tool
 * layer stays user-agnostic.
 */
export type WriteLimits = {
  quotaBytes: number;
  allowWrite: () => boolean;
};

export function contentBytes(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'content_bytes'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

export function quotaBytesForUser(
  user: Pick<User, "quota_mb"> | undefined,
  defaultMb: number,
): number {
  return Math.round((user?.quota_mb ?? defaultMb) * 1024 * 1024);
}

export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1);
}

/**
 * Gate for every MCP write: rate budget, per-document cap, then total quota.
 * Returns the refusal message, or undefined when the write may proceed.
 * `deltaBytes` is the growth this write causes (negative for shrinking edits —
 * those always pass the quota check, so a full user can still clean up).
 */
export function checkWrite(
  db: Database.Database,
  limits: WriteLimits | undefined,
  opts: { docBytes: number; docMax: number; deltaBytes: number },
): string | undefined {
  if (!limits) return undefined;
  if (!limits.allowWrite()) {
    return `Write rate limit reached (${WRITES_PER_MINUTE} writes/min) — pause for a minute, then continue with fewer, larger writes.`;
  }
  if (opts.docBytes > opts.docMax) {
    return `This document is ${formatMb(opts.docBytes)} MB — the per-document limit is ${formatMb(opts.docMax)} MB. Split it into smaller documents.`;
  }
  if (opts.deltaBytes > 0) {
    const usage = contentBytes(db);
    if (usage + opts.deltaBytes > limits.quotaBytes) {
      return quotaExceededMessage(usage, limits.quotaBytes);
    }
  }
  return undefined;
}

export function quotaExceededMessage(usage: number, quotaBytes: number): string {
  return (
    `Storage quota exceeded: using ${formatMb(usage)} MB of ${formatMb(quotaBytes)} MB. ` +
    "Delete or shrink existing content, or call request_quota_increase with a short reason to ask the operator for more space."
  );
}

/** Warning appended to write responses (and session-start context) at ≥80%. */
export function usageWarning(db: Database.Database, limits: WriteLimits | undefined): string {
  if (!limits) return "";
  const usage = contentBytes(db);
  const ratio = usage / limits.quotaBytes;
  if (ratio < QUOTA_WARN_RATIO) return "";
  return (
    `\n\n⚠ Storage: ${formatMb(usage)} of ${formatMb(limits.quotaBytes)} MB used (${Math.round(ratio * 100)}%). ` +
    "Consolidate or delete content where possible, or call request_quota_increase with a reason."
  );
}
