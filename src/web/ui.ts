import { htmlEscape } from "../http-util.js";

/** Tinted status pill. Deliberately the only shared fragment helper — pages otherwise compose plain HTML. */
export function badge(kind: "ok" | "warn" | "err" | "muted", label: string): string {
  return `<span class="badge ${kind}">${htmlEscape(label)}</span>`;
}
