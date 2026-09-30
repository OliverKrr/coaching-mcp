---
paths:
  - "src/gateways.ts"
  - "src/telemetry.ts"
  - "src/apps-proxy.ts"
---

# Gateways and the app proxy

- Gateway passthrough reads private SDK internals (`_requestHandlers`, `_registeredTools`) through
  `sdkInternals()`. After an `@modelcontextprotocol/sdk` upgrade, run `just test`: the guard test in
  `tests/serve.test.ts` is what tells you those internals moved.
- Upstream tools pass through with their exact schemas and annotations; only the per-server name
  prefix and the "Server: " attribution are added. Don't route them through `registerTool`, which
  re-serializes schemas through zod.
- Tool lists are cached per gateway (`GATEWAY_TOOLS_TTL_MS`); connections are opened lazily on the
  first routed `tools/call`. Call `invalidateGatewayTools` from anything that changes what an
  upstream exposes. `refresh_connected_servers` must end with `sendToolListChanged()`, or the
  client keeps its cached list and the refresh is invisible.
- Keep the SSRF guard on (https-only, no private targets, re-checked per redirect hop).
  `GATEWAY_ALLOW_INSECURE=1` exists for 127.0.0.1 mock upstreams in tests.
- `instrumentToolCalls` wraps `tools/call` after `attachGatewayTools`, so gateway calls are
  counted too. It records counts only; arguments and results never reach the operator.
- App proxy: access needs the user's email on `PROTECTED_APP_<NAME>_EMAILS`, a login alone is not
  enough. Route prefixing through `withPrefix`/`rewriteHtmlPrefix`, which skip URLs already under
  the prefix; concatenating double-prefixes apps that honour `X-Forwarded-Prefix`.

Full rationale: `docs/design-decisions.md`, section "Gateways and the app proxy".
