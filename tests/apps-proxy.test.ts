// coaching-mcp/tests/apps-proxy.test.ts — prefix rewriting for proxied apps.
// The proxy moves root-absolute URLs onto /apps/<name> so a dashboard that only
// emits href="/…" still works behind it. An app that reads the
// X-Forwarded-Prefix we send and prefixes its own URLs must not be prefixed a
// second time: /apps/x/apps/x/… breaks every link and redirect on the page.
import { describe, expect, it } from "vitest";
import {
  isUnderPrefix,
  parseProtectedApps,
  rewriteHtmlPrefix,
  upstreamRequest,
  withPrefix,
} from "../src/apps-proxy.js";

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

describe("parseProtectedApps", () => {
  it("takes no base path and no header by default", () => {
    const [app] = parseProtectedApps({ PROTECTED_APPS: "dash=http://dash:8080/" });
    expect(app).toMatchObject({ name: "dash", url: "http://dash:8080", basePath: "" });
    expect(app?.header).toBeUndefined();
  });

  it("reads a base path from the target URL", () => {
    const [app] = parseProtectedApps({ PROTECTED_APPS: "dash=http://dash:8080/tools/dash/" });
    expect(app?.basePath).toBe("/tools/dash");
  });

  it("rejects a query or fragment on the target", () => {
    expect(() => parseProtectedApps({ PROTECTED_APPS: "dash=http://dash:8080/x?y=1" })).toThrow();
  });

  it("reads the per-app header, lowercasing its name", () => {
    const [app] = parseProtectedApps({
      PROTECTED_APPS: "my-dash=http://dash:8080",
      PROTECTED_APP_MY_DASH_HEADER: "X-Proxy-Secret: a:b c",
    });
    expect(app?.header).toEqual({ name: "x-proxy-secret", value: "a:b c" });
  });

  it("refuses headers it must control itself, and malformed ones", () => {
    for (const bad of [
      "Host: x",
      "X-Forwarded-Prefix: /x",
      "Connection: close",
      "no-colon",
      "X-A:",
    ]) {
      expect(() =>
        parseProtectedApps({ PROTECTED_APPS: "d=http://d:1", PROTECTED_APP_D_HEADER: bad }),
      ).toThrow();
    }
  });
});

describe("upstreamRequest", () => {
  const app = {
    name: "d",
    url: "http://d:1/base",
    basePath: "/base",
    header: { name: "x-proxy-secret", value: "real" },
    emails: new Set<string>(),
  };

  it("prepends the base path and sets the prefix", () => {
    const { path, headers } = upstreamRequest(app, "/apps/d", "/x?q=1", {});
    expect(path).toBe("/base/x?q=1");
    expect(headers["x-forwarded-prefix"]).toBe("/apps/d");
    expect(headers.host).toBe("d:1");
  });

  it("replaces a client-sent copy of the app header", () => {
    const { headers } = upstreamRequest(app, "/apps/d", "/", { "x-proxy-secret": "forged" });
    expect(headers["x-proxy-secret"]).toBe("real");
  });
});
