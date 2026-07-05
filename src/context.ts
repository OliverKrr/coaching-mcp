import type Database from "better-sqlite3";
import type { OidcProvider } from "./auth/oidc.js";
import type { TenantManager } from "./tenancy.js";

export type ProtectedApp = {
  name: string;
  url: string;
  /** Lowercased emails allowed to reach this app — login alone is not enough. */
  emails: Set<string>;
};

export type ServeConfig = {
  dataDir: string;
  seedDir: string;
  port: number;
  /** External base URL including any reverse-proxy path prefix, no trailing slash. */
  publicUrl: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  /** Master key for the per-user secret store; absent → integrations disabled. */
  secretsKey?: Buffer;
  /** Internal web apps served behind the login at /apps/<name>/. */
  apps: ProtectedApp[];
};

export type ServeContext = {
  cfg: ServeConfig;
  authDb: Database.Database;
  oidc: OidcProvider;
  tenants: TenantManager;
  log: (msg: string) => void;
};
