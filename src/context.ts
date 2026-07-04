import type Database from "better-sqlite3";
import type { OidcProvider } from "./auth/oidc.js";
import type { TenantManager } from "./tenancy.js";

export type ServeConfig = {
  dataDir: string;
  seedDir: string;
  port: number;
  /** External base URL including any reverse-proxy path prefix, no trailing slash. */
  publicUrl: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
};

export type ServeContext = {
  cfg: ServeConfig;
  authDb: Database.Database;
  oidc: OidcProvider;
  tenants: TenantManager;
  log: (msg: string) => void;
};
