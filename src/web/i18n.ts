import type { IncomingMessage } from "node:http";
import { parseCookies } from "../http-util.js";

/**
 * Language is a first-class, sticky preference: `?lang=` (the header toggle)
 * wins and is persisted to a cookie by the router, the cookie carries the
 * choice across every page — including the account area — and Accept-Language
 * is only the first-visit fallback.
 */

export type Lang = "en" | "de";

const LANG_COOKIE = "lang";

function asLang(value: string | null | undefined): Lang | undefined {
  return value === "de" || value === "en" ? value : undefined;
}

export function pickLang(req: IncomingMessage, url: URL): Lang {
  return (
    asLang(url.searchParams.get("lang")) ??
    asLang(parseCookies(req.headers.cookie)[LANG_COOKIE]) ??
    ((req.headers["accept-language"] ?? "").toLowerCase().startsWith("de") ? "de" : "en")
  );
}

/** Set-Cookie value persisting an explicit `?lang=` choice for a year; undefined otherwise. */
export function langCookieHeader(url: URL): string | undefined {
  const lang = asLang(url.searchParams.get("lang"));
  if (!lang) return undefined;
  return `${LANG_COOKIE}=${lang}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
