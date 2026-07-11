// Shared test helpers: a minimal RS256 OIDC issuer on 127.0.0.1 (discovery,
// JWKS, authorize, token) driving the full redirect chain, plus a listen()
// helper for ephemeral mock servers. Used by serve.test.ts and
// registration.test.ts — tests never touch the network beyond 127.0.0.1.
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export type MockIdentity = { sub: string; email: string; emailVerified?: boolean; name?: string };

export class MockIssuer {
  nextIdentity: MockIdentity = { sub: "sub-default", email: "default@example.com" };
  url = "";
  private server!: Server;
  private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly codes = new Map<string, { nonce: string; identity: MockIdentity }>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", this.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: this.url,
            authorization_endpoint: `${this.url}/authorize`,
            token_endpoint: `${this.url}/token`,
            jwks_uri: `${this.url}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
        return;
      }
      if (url.pathname === "/jwks") {
        const jwk = this.keys.publicKey.export({ format: "jwk" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] }));
        return;
      }
      if (url.pathname === "/authorize") {
        const code = randomBytes(16).toString("hex");
        this.codes.set(code, {
          nonce: url.searchParams.get("nonce") ?? "",
          identity: this.nextIdentity,
        });
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", code);
        const state = url.searchParams.get("state");
        if (state) redirect.searchParams.set("state", state);
        res.writeHead(302, { location: redirect.href });
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          const params = new URLSearchParams(body);
          const grant = this.codes.get(params.get("code") ?? "");
          if (!grant) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          const now = Math.floor(Date.now() / 1000);
          const idToken = this.signJwt({
            iss: this.url,
            aud: "test-client",
            sub: grant.identity.sub,
            email: grant.identity.email,
            email_verified: grant.identity.emailVerified ?? true,
            ...(grant.identity.name ? { name: grant.identity.name } : {}),
            nonce: grant.nonce,
            iat: now,
            exp: now + 300,
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: randomBytes(8).toString("hex"),
              token_type: "bearer",
              expires_in: 300,
              id_token: idToken,
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address === null || typeof address === "string") throw new Error("no address");
        this.url = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  private signJwt(payload: object): string {
    const enc = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const signingInput = `${enc({ alg: "RS256", typ: "JWT", kid: "test-key" })}.${enc(payload)}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(this.keys.privateKey)
      .toString("base64url");
    return `${signingInput}.${signature}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
