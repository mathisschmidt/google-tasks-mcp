import process from "node:process";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authPassword?: string;
}

export interface ServerSettings {
  /** Bind address (MCP_HOST, default 0.0.0.0). */
  host: string;
  /** Bind port (MCP_PORT, then legacy PORT, default 3000). */
  port: number;
  /** Public base URL of the server, without trailing slash (MCP_PUBLIC_URL). */
  publicUrl?: string;
  /** Sign-in password required before connecting a client (MCP_AUTH_PASSWORD). */
  authPassword?: string;
}

export const MIN_AUTH_PASSWORD_LENGTH = 12;

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

function parsePublicUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MCP_PUBLIC_URL is not a valid URL: ${value}`);
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("MCP_PUBLIC_URL must use https:// (http:// is only allowed for localhost)");
  }
  if (url.search || url.hash) {
    throw new Error("MCP_PUBLIC_URL must not contain a query string or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_PORT: ${raw}`);
  }
  return port;
}

/** Reads and validates the server settings from the environment. */
export function loadServerSettings(): ServerSettings {
  const authPassword = process.env.MCP_AUTH_PASSWORD || undefined;
  if (authPassword && authPassword.length < MIN_AUTH_PASSWORD_LENGTH) {
    throw new Error(`MCP_AUTH_PASSWORD must be at least ${MIN_AUTH_PASSWORD_LENGTH} characters`);
  }

  return {
    host: process.env.MCP_HOST?.trim() || "0.0.0.0",
    port: parsePort(process.env.MCP_PORT || process.env.PORT),
    publicUrl: parsePublicUrl(process.env.MCP_PUBLIC_URL),
    authPassword,
  };
}

let serverSettings: ServerSettings | null = null;

export function setServerSettings(settings: ServerSettings) {
  serverSettings = settings;
}

/** Public base URL: MCP_PUBLIC_URL if set, otherwise derived from the request. */
export function getPublicBaseUrl(requestUrl: string): string {
  return serverSettings?.publicUrl || new URL(requestUrl).origin;
}

/**
 * Optional path of the Deno KV database (e.g. a SQLite file on a Docker
 * volume). When unset, the runtime default is used (Deno Deploy's managed KV).
 */
export function getKvPath(): string | undefined {
  return process.env.KV_PATH || undefined;
}
