import { htmlEscape } from "../http-util.js";

/** Tinted status pill. */
export function badge(kind: "ok" | "warn" | "err" | "muted", label: string): string {
  return `<span class="badge ${kind}">${htmlEscape(label)}</span>`;
}

/**
 * An email address rendered verbatim. The comment pair is Cloudflare's
 * documented opt-out for Email Address Obfuscation — without it, a
 * Cloudflare-proxied deployment rewrites addresses into protection links
 * whose injected decoder script is dead under our `script-src 'none'` CSP,
 * so users would see "[email protected]" instead of the address. Use this for
 * every email rendered into a page.
 */
export function emailText(email: string): string {
  return `<!--email_off-->${htmlEscape(email)}<!--/email_off-->`;
}

/**
 * Read-only copy surface: a focused textarea contains Ctrl+A, so "click →
 * select all → copy" grabs exactly this content instead of the whole page.
 * Use it wherever the user is meant to copy-paste a block.
 */
export function copyBox(content: string, maxRows = 24): string {
  // +2 headroom for soft-wrapped lines; long content scrolls (and is resizable).
  const rows = Math.min(content.split("\n").length + 2, maxRows);
  return `<textarea readonly class="copybox" rows="${rows}">${htmlEscape(content)}</textarea>`;
}
