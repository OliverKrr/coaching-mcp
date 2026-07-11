import * as oidc from "openid-client";

/**
 * Thin relying-party wrapper around openid-client: discovery is lazy (first
 * login, not process start) and cached, PKCE is always used toward the IdP,
 * and callers only ever see the verified identity claims.
 */

export type OidcIdentity = { sub: string; email: string; emailVerified: boolean; name?: string };

export type OidcProvider = {
  randomState(): string;
  randomNonce(): string;
  newPkce(): Promise<{ verifier: string; challenge: string }>;
  authorizationUrl(params: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string>;
  /** Exchange the callback for tokens and return the verified id_token identity. */
  exchangeCode(
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<OidcIdentity>;
};

export function createOidcProvider(opts: {
  issuer: string;
  clientId: string;
  clientSecret: string;
}): OidcProvider {
  let configPromise: Promise<oidc.Configuration> | undefined;

  function config(): Promise<oidc.Configuration> {
    configPromise ??= (async () => {
      const issuerUrl = new URL(opts.issuer);
      // http issuers only exist in local testing; production IdPs are https.
      const discoveryOptions =
        issuerUrl.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined;
      return oidc.discovery(
        issuerUrl,
        opts.clientId,
        opts.clientSecret,
        undefined,
        discoveryOptions,
      );
    })();
    return configPromise;
  }

  return {
    randomState: () => oidc.randomState(),
    randomNonce: () => oidc.randomNonce(),

    async newPkce() {
      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      return { verifier, challenge };
    },

    async authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
      const url = oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: redirectUri,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return url.href;
    },

    async exchangeCode(callbackUrl, { state, nonce, codeVerifier }) {
      const tokens = await oidc.authorizationCodeGrant(await config(), callbackUrl, {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: codeVerifier,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error("IdP response contained no id_token");
      const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
      if (!email) throw new Error("id_token contained no email claim");
      return {
        sub: claims.sub,
        email,
        emailVerified: claims.email_verified !== false,
        ...(typeof claims.name === "string" && claims.name ? { name: claims.name } : {}),
      };
    },
  };
}
