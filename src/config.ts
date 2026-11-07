import process from "node:process";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

let oauthConfig: OAuthConfig | null = null;

export function setOAuthConfig(config: OAuthConfig) {
  oauthConfig = config;
}

export function getOAuthConfig(): OAuthConfig {
  if (!oauthConfig) {
    throw new Error("OAuth config not initialized");
  }
  return oauthConfig;
}

/**
 * Optional path of the Deno KV database (e.g. a SQLite file on a Docker
 * volume). When unset, the runtime default is used (Deno Deploy's managed KV).
 */
export function getKvPath(): string | undefined {
  return process.env.KV_PATH || undefined;
}
