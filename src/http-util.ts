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

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
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

/** Shared minimal page chrome for the few human-facing pages. `wide` = editor layout. */
export function page(title: string, body: string, opts: { wide?: boolean } = {}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:${opts.wide ? "min(1500px,95vw)" : "560px"};margin:${opts.wide ? "24px" : "60px"} auto;padding:0 1rem;color:#222;line-height:1.5}
.split{display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap}
.split>div{flex:1 1 480px;min-width:0}
textarea.editor{height:74vh;width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:.9rem}
.preview{border:1px solid #e5e5e5;border-radius:8px;padding:.25rem 1.25rem;background:#fafafa;overflow-wrap:break-word}
.preview h1{font-size:1.35rem}.preview h2{font-size:1.15rem}.preview h3{font-size:1rem}
.preview pre{background:#f0f0f0;padding:.75rem;border-radius:6px;overflow-x:auto}
.preview code{background:#f0f0f0;padding:.1rem .3rem;border-radius:3px;font-size:.85em}
.preview pre code{background:none;padding:0}
.preview blockquote{border-left:3px solid #ccc;margin:.5rem 0;padding:.1rem 1rem;color:#555}
h1,h2{line-height:1.2}
table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #eee}
button{padding:.5rem 1.2rem;font-size:1rem;cursor:pointer;background:#1a1a1a;color:#fff;border:none;border-radius:4px}
button.danger{background:#b3261e}
input[type=text],input[type=email]{width:100%;padding:.5rem;box-sizing:border-box;font-size:1rem;border:1px solid #ccc;border-radius:4px}
form{margin:1rem 0}
.card{border:1px solid #e5e5e5;border-radius:8px;padding:1rem 1.25rem;margin:1.25rem 0}
.muted{color:#666;font-size:.9rem}
a{color:#1a4fd6}
</style>
</head>
<body>
${body}
</body>
</html>`;
}
