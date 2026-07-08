import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024; // auth/account endpoints only — /mcp bodies bypass this

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a form-encoded or JSON body into flat string params. */
export function parseParams(body: string, contentType: string | undefined): URLSearchParams {
  if (contentType?.includes("application/json")) {
    const params = new URLSearchParams();
    const obj = JSON.parse(body) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") params.set(k, v);
    }
    return params;
  }
  return new URLSearchParams(body);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

/**
 * Strict security headers for every server-rendered page. `script-src 'none'`
 * is load-bearing: the pages deliberately contain no JavaScript at all, so any
 * script that ever slips into rendered content is dead on arrival. Proxied
 * app responses (apps-proxy) do NOT pass through here — they keep their own
 * headers, because this CSP would break them.
 */
const HTML_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'; script-src 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS });
  res.end(html);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

export function sessionCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
