import { htmlEscape } from "../http-util.js";

/**
 * The page shell for every server-rendered page: document skeleton, design
 * tokens (light + dark via prefers-color-scheme), and the optional site
 * header. Pages stay plain HTML strings — no template engine, and strictly no
 * JavaScript (script-src 'none' is enforced by http-util's CSP headers).
 *
 * Pages that pass `nav` get the site header (brand + Guide/Routines/Account);
 * pages that don't — OAuth-flow and error pages — stay chrome-light on
 * purpose: mid-flow, navigation is a distraction.
 */

export type NavOpts = {
  /** PUBLIC_URL — nav links must be absolute (prefix-stripping reverse proxy). */
  base: string;
  active?: "guide" | "routines" | "account";
  /** Landing/routines pages: carry the chosen language into nav links. */
  lang?: "en" | "de";
  /** Extra right-aligned header content, e.g. the language switch. */
  extra?: string;
};

export type PageOpts = { wide?: boolean; nav?: NavOpts };

const NAV_LABELS = {
  en: { guide: "Guide", routines: "Routines", account: "Account" },
  de: { guide: "Anleitung", routines: "Routinen", account: "Account" },
} as const;

// A rounded square with a "C" arc, in the accent color (# → %23).
const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%233557c7'/><path d='M21.5 12a6.5 6.5 0 1 0 0 8' stroke='white' stroke-width='3.2' fill='none' stroke-linecap='round'/></svg>";

const CSS = `*{box-sizing:border-box}
:root{color-scheme:light dark;
--bg:#f7f7f5;--surface:#fff;--fg:#1c1e21;--muted:#63666b;--border:#e3e3e0;
--accent:#3557c7;--accent-fg:#fff;--danger:#b3261e;--ok:#1a7f37;--warn:#9a6700;--code-bg:#efefec}
@media (prefers-color-scheme:dark){:root{
--bg:#121416;--surface:#1c1f23;--fg:#e8eaed;--muted:#9aa0a6;--border:#34383d;
--accent:#8ab4f8;--accent-fg:#101318;--danger:#f28b82;--ok:#81c995;--warn:#e2c06e;--code-bg:#282c31}}
body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header.site{border-bottom:1px solid var(--border);background:var(--surface)}
header.site .inner{max-width:680px;margin:0 auto;padding:.6rem 1.25rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
header.site .inner.wide,main.wide{max-width:min(1500px,95vw)}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:650;color:var(--fg);text-decoration:none}
.brand .mark{width:.7rem;height:.7rem;border-radius:50%;background:var(--accent)}
header.site nav{margin-left:auto;display:flex;align-items:center;gap:.25rem;flex-wrap:wrap}
header.site nav a{color:var(--muted);text-decoration:none;padding:.28rem .6rem;border-radius:6px;font-size:.95rem}
header.site nav a:hover{color:var(--fg)}
header.site nav a[aria-current]{color:var(--fg);font-weight:600;background:color-mix(in srgb,var(--accent) 12%,transparent)}
header.site nav a.lang{font-size:.85rem;padding:.28rem .45rem}
header.site nav .sep{width:1px;height:1rem;background:var(--border);margin:0 .35rem}
main{max-width:680px;margin:0 auto;padding:1.4rem 1.25rem 3.5rem}
h1{font-size:1.55rem;line-height:1.25;margin:1rem 0 .6rem}
h2{font-size:1.15rem;line-height:1.3}
a{color:var(--accent)}
table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600}
td form{margin:.25rem 0}
button{padding:.5rem 1.1rem;font-size:.95rem;font-weight:600;cursor:pointer;background:var(--accent);color:var(--accent-fg);border:none;border-radius:7px;white-space:nowrap}
button:hover{filter:brightness(1.08)}
button.danger{background:transparent;color:var(--danger);border:1px solid var(--danger)}
button.quiet{background:transparent;color:var(--muted);border:1px solid var(--border)}
input,select,textarea{font:inherit;color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:.45rem .6rem}
input[type=text],input[type=email],input[type=password],input[type=url]{width:100%}
form{margin:1rem 0}
.card{border:1px solid var(--border);border-radius:10px;padding:1rem 1.25rem;margin:1.1rem 0;background:var(--surface)}
.card.danger{border-color:color-mix(in srgb,var(--danger) 45%,var(--border))}
.muted{color:var(--muted);font-size:.92rem}
.scroll{overflow-x:auto}
summary{cursor:pointer}
code{background:var(--code-bg);padding:.1rem .35rem;border-radius:4px;font-size:.88em}
pre{background:var(--code-bg);padding:.75rem .9rem;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0}
pre.snippet{font-size:.85rem;white-space:pre-wrap}
.badge{display:inline-block;padding:.05rem .55rem;border-radius:99px;font-size:.8rem;font-weight:600}
.badge.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent)}
.badge.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent)}
.badge.err{color:var(--danger);background:color-mix(in srgb,var(--danger) 14%,transparent)}
.badge.muted{color:var(--muted);background:color-mix(in srgb,var(--muted) 15%,transparent)}
.split{display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap}
.split>div{flex:1 1 480px;min-width:0}
textarea.editor{height:74vh;width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem}
textarea.editor.short{height:50vh}
textarea.mono{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem}
.preview{border:1px solid var(--border);border-radius:8px;padding:.25rem 1.25rem;background:var(--surface);overflow-wrap:break-word}
.preview h1{font-size:1.35rem}
.preview h2{font-size:1.15rem}
.preview h3{font-size:1rem}
.preview blockquote{border-left:3px solid var(--border);margin:.5rem 0;padding:.1rem 1rem;color:var(--muted)}`;

function renderNav(nav: NavOpts, wide: boolean): string {
  const labels = NAV_LABELS[nav.lang ?? "en"];
  const q = nav.lang ? `?lang=${nav.lang}` : "";
  const item = (key: NonNullable<NavOpts["active"]>, href: string, label: string): string =>
    `<a href="${href}"${nav.active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="site"><div class="inner${wide ? " wide" : ""}">
<a class="brand" href="${nav.base}/${q}"><span class="mark"></span>Coaching hub</a>
<nav>${item("guide", `${nav.base}/${q}`, labels.guide)}${item("routines", `${nav.base}/routines${q}`, labels.routines)}${item("account", `${nav.base}/account`, labels.account)}${nav.extra ?? ""}</nav>
</div></header>`;
}

export function page(title: string, body: string, opts: PageOpts = {}): string {
  const wide = opts.wide === true;
  return `<!DOCTYPE html>
<html lang="${opts.nav?.lang ?? "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f7f5">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121416">
<link rel="icon" href="${FAVICON}">
<title>${htmlEscape(title)}</title>
<style>${CSS}</style>
</head>
<body>
${opts.nav ? renderNav(opts.nav, wide) : ""}
<main${wide ? ' class="wide"' : ""}>
${body}
</main>
</body>
</html>`;
}
