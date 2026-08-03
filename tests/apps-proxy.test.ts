// coaching-mcp/tests/apps-proxy.test.ts — prefix rewriting for proxied apps.
// The proxy moves root-absolute URLs onto /apps/<name> so a dashboard that only
// emits href="/…" still works behind it. An app that reads the
// X-Forwarded-Prefix we send and prefixes its own URLs must not be prefixed a
// second time: /apps/x/apps/x/… breaks every link and redirect on the page.
import { describe, expect, it } from "vitest";
import { isUnderPrefix, rewriteHtmlPrefix, withPrefix } from "../src/apps-proxy.js";

const PREFIX = "/apps/dashboard";

describe("isUnderPrefix", () => {
  it("accepts the prefix itself and paths below it", () => {
    expect(isUnderPrefix(PREFIX, PREFIX)).toBe(true);
    expect(isUnderPrefix(PREFIX, `${PREFIX}/settings`)).toBe(true);
    expect(isUnderPrefix(PREFIX, `${PREFIX}?page=2`)).toBe(true);
    expect(isUnderPrefix(PREFIX, `${PREFIX}#top`)).toBe(true);
  });

  it("requires a segment boundary, so a longer sibling does not count", () => {
    expect(isUnderPrefix("/apps", "/appstore/x")).toBe(false);
    expect(isUnderPrefix(PREFIX, `${PREFIX}-old/settings`)).toBe(false);
  });

  it("rejects unrelated roots", () => {
    expect(isUnderPrefix(PREFIX, "/settings")).toBe(false);
    expect(isUnderPrefix(PREFIX, "/")).toBe(false);
  });
});

describe("withPrefix", () => {
  it("prefixes an unprefixed URL", () => {
    expect(withPrefix(PREFIX, "/settings")).toBe(`${PREFIX}/settings`);
  });

  it("is idempotent", () => {
    const once = withPrefix(PREFIX, "/settings");
    expect(withPrefix(PREFIX, once)).toBe(once);
  });

  it("leaves an app's own already-prefixed redirect alone", () => {
    expect(withPrefix(PREFIX, `${PREFIX}/setup`)).toBe(`${PREFIX}/setup`);
  });
});

describe("rewriteHtmlPrefix", () => {
  it("prefixes navigation, assets, forms and htmx attributes", () => {
    const html = [
      '<link href="/static/app.css">',
      '<img src="/static/logo.svg">',
      '<a href="/settings">Settings</a>',
      '<form action="/logout">',
      '<button hx-post="/api/sync">',
    ].join("\n");
    const out = rewriteHtmlPrefix(html, PREFIX);
    expect(out).toContain(`href="${PREFIX}/static/app.css"`);
    expect(out).toContain(`src="${PREFIX}/static/logo.svg"`);
    expect(out).toContain(`href="${PREFIX}/settings"`);
    expect(out).toContain(`action="${PREFIX}/logout"`);
    expect(out).toContain(`hx-post="${PREFIX}/api/sync"`);
  });

  it("leaves an app's own prefixed output untouched", () => {
    const html = `<a href="${PREFIX}/settings">S</a><form action="${PREFIX}/login">`;
    expect(rewriteHtmlPrefix(html, PREFIX)).toBe(html);
  });

  it("is idempotent over a whole document", () => {
    const html = '<a href="/a">a</a><a href="/b">b</a><img src="/c.png">';
    const once = rewriteHtmlPrefix(html, PREFIX);
    expect(rewriteHtmlPrefix(once, PREFIX)).toBe(once);
  });

  it("does not touch absolute or protocol-relative URLs", () => {
    const html = '<a href="https://example.com/x">x</a><script src="//cdn.example.com/y.js">';
    expect(rewriteHtmlPrefix(html, PREFIX)).toBe(html);
  });

  it("does not touch fragments, queries or relative URLs", () => {
    const html = '<a href="#top">t</a><a href="?page=2">p</a><a href="sub/page">s</a>';
    expect(rewriteHtmlPrefix(html, PREFIX)).toBe(html);
  });

  it("rewrites every occurrence, not just the first", () => {
    const out = rewriteHtmlPrefix('<a href="/a"><a href="/b"><a href="/c">', PREFIX);
    expect(out.match(new RegExp(PREFIX, "g"))?.length).toBe(3);
  });
});
