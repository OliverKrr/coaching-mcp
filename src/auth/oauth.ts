import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServeContext } from "../context.js";
import {
  htmlEscape,
  page,
  parseParams,
  readBody,
  redirect,
  sendHtml,
  sendJson,
} from "../http-util.js";
import { isEmailAllowed } from "./allowlist.js";
import {
  consumeAuthCode,
  consumePendingAuth,
  createAuthCode,
  createPendingAuth,
  createWebSession,
  getClientRedirectUris,
  issueTokens,
  lookupAccessToken,
  registerClient,
  rotateRefreshToken,
  upsertUserOnLogin,
} from "./db.js";

/**
 * Built-in OAuth 2.1 authorization server, federating the human login to an
 * OIDC identity provider. The endpoint surface (RFC 8414 metadata, RFC 7591
 * dynamic client registration, authorization_code + PKCE S256, refresh
 * rotation) is what MCP connector clients negotiate; the only human-visible
 * step is the IdP's own login page, gated by the operator's email allowlist.
 */

type PendingAuth = {
  purpose: "oauth" | "account";
  nonce: string;
  verifier: string;
  client?: {
    clientId: string;
    redirectUri: string;
    clientState: string;
    codeChallenge: string;
  };
};

function oidcRedirectUri(ctx: ServeContext): string {
  return `${ctx.cfg.publicUrl}/oidc/callback`;
}

export function oauthMetadata(ctx: ServeContext): object {
  const base = ctx.cfg.publicUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [],
  };
}

export function protectedResourceMetadata(ctx: ServeContext): object {
  return {
    resource: ctx.cfg.publicUrl,
    authorization_servers: [ctx.cfg.publicUrl],
  };
}

export async function handleRegister(
  ctx: ServeContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let redirectUris: string[];
  try {
    const body = JSON.parse(await readBody(req)) as { redirect_uris?: unknown };
    redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
  } catch {
    sendJson(res, 400, { error: "invalid_client_metadata" });
    return;
  }
  if (redirectUris.length === 0) {
    sendJson(res, 400, { error: "invalid_redirect_uri" });
    return;
  }
  const clientId = registerClient(ctx.authDb, redirectUris);
  sendJson(res, 201, {
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

/** OAuth authorize: validate the client request, then bounce to the IdP. */
export async function handleAuthorize(
  ctx: ServeContext,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const registered = getClientRedirectUris(ctx.authDb, clientId);
  // Never redirect to an unvalidated URI — client/redirect problems get a page.
  if (!registered || !registered.includes(redirectUri)) {
    sendHtml(
      res,
      400,
      page(
        "Invalid request",
        "<h1>Invalid client or redirect URI</h1><p>Re-add the connector in your MCP client to re-register it.</p>",
      ),
    );
    return;
  }
  const clientState = q.get("state") ?? "";
  const errorRedirect = (error: string): void => {
    const sep = redirectUri.includes("?") ? "&" : "?";
    const state = clientState ? `&state=${encodeURIComponent(clientState)}` : "";
    redirect(res, `${redirectUri}${sep}error=${error}${state}`);
  };
  const codeChallenge = q.get("code_challenge") ?? "";
  if (q.get("response_type") !== "code" || !codeChallenge) {
    errorRedirect("invalid_request");
    return;
  }
  if ((q.get("code_challenge_method") ?? "S256") !== "S256") {
    errorRedirect("invalid_request");
    return;
  }
  await startIdpLogin(ctx, res, {
    purpose: "oauth",
    client: { clientId, redirectUri, clientState, codeChallenge },
  });
}

/** Account-page login: same IdP flow, but the destination is a web session. */
export async function startAccountLogin(ctx: ServeContext, res: ServerResponse): Promise<void> {
  await startIdpLogin(ctx, res, { purpose: "account" });
}

async function startIdpLogin(
  ctx: ServeContext,
  res: ServerResponse,
  pending: Omit<PendingAuth, "nonce" | "verifier">,
): Promise<void> {
  const nonce = ctx.oidc.randomNonce();
  const pkce = await ctx.oidc.newPkce();
  const state = createPendingAuth(ctx.authDb, {
    ...pending,
    nonce,
    verifier: pkce.verifier,
  } satisfies PendingAuth);
  const idpUrl = await ctx.oidc.authorizationUrl({
    redirectUri: oidcRedirectUri(ctx),
    state,
    nonce,
    codeChallenge: pkce.challenge,
  });
  redirect(res, idpUrl);
}

export async function handleOidcCallback(
  ctx: ServeContext,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const pending = consumePendingAuth<PendingAuth>(ctx.authDb, state);
  if (!pending) {
    sendHtml(
      res,
      400,
      page(
        "Login expired",
        "<h1>Login expired</h1><p>This sign-in link is no longer valid. Start again from your MCP client or the account page.</p>",
      ),
    );
    return;
  }

  // Rebuild the callback URL on the public base: the reverse proxy strips the
  // path prefix, but the IdP validated the full registered redirect URI.
  const callbackUrl = new URL(oidcRedirectUri(ctx));
  callbackUrl.search = url.search;

  let identity;
  try {
    identity = await ctx.oidc.exchangeCode(callbackUrl, {
      state,
      nonce: pending.nonce,
      codeVerifier: pending.verifier,
    });
  } catch (err) {
    ctx.log(`oidc callback rejected: ${err instanceof Error ? err.message : String(err)}`);
    sendHtml(
      res,
      400,
      page(
        "Login failed",
        "<h1>Login failed</h1><p>The identity provider response could not be verified. Please try again.</p>",
      ),
    );
    return;
  }

  if (!identity.emailVerified || !isEmailAllowed(identity.email)) {
    ctx.log(`login denied for ${identity.email} (not on allowlist)`);
    sendHtml(
      res,
      403,
      page(
        "Not invited",
        `<h1>Access is by invitation</h1>
<p>You signed in as <strong>${htmlEscape(identity.email)}</strong>, but this address is not on the invitation list.</p>
<p>Ask the operator of this server to add it, then try again.</p>`,
      ),
    );
    return;
  }

  const user = upsertUserOnLogin(ctx.authDb, identity);
  ctx.tenants.open(user.id); // first login provisions + seeds the coaching DB
  ctx.log(`login ok: ${user.email} (${user.id})`);

  if (pending.purpose === "account") {
    const session = createWebSession(ctx.authDb, user.id);
    res.writeHead(302, {
      location: `${ctx.cfg.publicUrl}/account`,
      "set-cookie": `account_session=${encodeURIComponent(session.id)}; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
    res.end();
    return;
  }

  const client = pending.client;
  if (!client) {
    sendHtml(res, 400, page("Invalid request", "<h1>Invalid request</h1>"));
    return;
  }
  const code = createAuthCode(ctx.authDb, {
    user_id: user.id,
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_challenge: client.codeChallenge,
  });
  const sep = client.redirectUri.includes("?") ? "&" : "?";
  const stateParam = client.clientState ? `&state=${encodeURIComponent(client.clientState)}` : "";
  redirect(res, `${client.redirectUri}${sep}code=${encodeURIComponent(code)}${stateParam}`);
}

export async function handleToken(
  ctx: ServeContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let params: URLSearchParams;
  try {
    params = parseParams(await readBody(req), req.headers["content-type"]);
  } catch {
    sendJson(res, 400, { error: "invalid_request" });
    return;
  }
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const verifier = params.get("code_verifier") ?? "";
    const grant = consumeAuthCode(ctx.authDb, code);
    if (!grant || !verifier) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (challenge !== grant.code_challenge) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    if (
      (clientId && clientId !== grant.client_id) ||
      (redirectUri && redirectUri !== grant.redirect_uri)
    ) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    const tokens = issueTokens(
      ctx.authDb,
      grant.user_id,
      grant.client_id,
      ctx.cfg.accessTokenTtlSec,
      ctx.cfg.refreshTokenTtlSec,
    );
    sendJson(res, 200, {
      access_token: tokens.accessToken,
      token_type: "bearer",
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
    });
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token") ?? "";
    const rotated = rotateRefreshToken(
      ctx.authDb,
      refreshToken,
      ctx.cfg.accessTokenTtlSec,
      ctx.cfg.refreshTokenTtlSec,
    );
    if (!rotated || rotated === "reused") {
      if (rotated === "reused") ctx.log("refresh token reuse detected — token chain revoked");
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    sendJson(res, 200, {
      access_token: rotated.accessToken,
      token_type: "bearer",
      expires_in: rotated.expiresIn,
      refresh_token: rotated.refreshToken,
    });
    return;
  }

  sendJson(res, 400, { error: "unsupported_grant_type" });
}

export function authenticateBearer(
  ctx: ServeContext,
  req: IncomingMessage,
): { userId: string } | undefined {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return undefined;
  return lookupAccessToken(ctx.authDb, header.slice("Bearer ".length));
}

export function sendUnauthorized(ctx: ServeContext, res: ServerResponse): void {
  sendJson(
    res,
    401,
    { error: "unauthorized" },
    {
      "WWW-Authenticate": `Bearer resource_metadata="${ctx.cfg.publicUrl}/.well-known/oauth-protected-resource"`,
    },
  );
}
