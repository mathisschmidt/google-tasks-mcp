import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { tokenStore } from "./token-store.ts";
import crypto from "node:crypto";
import { openKv } from "@deno/kv";
import { createLogger } from "../utils/logger.ts";
import { rateLimit } from "../server/rate-limiter.ts";

const logger = createLogger({ component: "oauth" });

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface OAuthSession {
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  redirectUri: string;
  clientId?: string;
}

interface AuthCode {
  googleCode: string;
  clientId?: string;
  redirectUri: string;
  codeChallenge?: string;
}

interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

class OAuthStore {
  private kv: Awaited<ReturnType<typeof openKv>> | null = null;

  async init() {
    this.kv = await openKv();
  }

  async storeSession(sessionId: string, session: OAuthSession): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.set(["oauth_sessions", sessionId], session, { expireIn: 600000 });
  }

  async getSession(sessionId: string): Promise<OAuthSession | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<OAuthSession>(["oauth_sessions", sessionId]);
    return result.value;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["oauth_sessions", sessionId]);
  }

  async storeAuthCode(code: string, data: AuthCode): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.set(["auth_codes", code], data, { expireIn: 600000 });
  }

  async getAuthCode(code: string): Promise<AuthCode | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<AuthCode>(["auth_codes", code]);
    return result.value;
  }

  async deleteAuthCode(code: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["auth_codes", code]);
  }

  async registerClient(clientId: string, client: RegisteredClient): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.set(["clients", clientId], client);
  }

  async getClient(clientId: string): Promise<RegisteredClient | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<RegisteredClient>(["clients", clientId]);
    return result.value;
  }
}

const oauthStore = new OAuthStore();

function base64URLEncode(str: Buffer): string {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function sha256(buffer: string): Buffer {
  return crypto.createHash('sha256').update(buffer).digest();
}

const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * A redirect URI is acceptable if it is an absolute https URL, or an http URL
 * pointing to a loopback address (native/CLI clients, RFC 8252). Fragments are
 * forbidden (RFC 6749 §3.1.2).
 */
function isAcceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return true;
  return false;
}

/** Constant-time string comparison to avoid leaking information via timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function initOAuthStore() {
  await oauthStore.init();
}

export function createOAuthRouter(config: OAuthConfig) {
  const oauth = new Hono();

  oauth.post(
    "/register",
    rateLimit({ maxRequests: 30, windowMs: 3600000 }),
    async (c) => {
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_client_metadata", error_description: "Request body must be valid JSON" }, 400);
      }

      const redirectUris = body?.redirect_uris;
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        redirectUris.length > MAX_REDIRECT_URIS ||
        !redirectUris.every(isAcceptableRedirectUri)
      ) {
        logger.warn("OAuth client registration rejected: invalid redirect_uris");
        return c.json({
          error: "invalid_redirect_uri",
          error_description: "redirect_uris must be a non-empty array of https URLs (or http loopback URLs)",
        }, 400);
      }

      const clientId = crypto.randomUUID();

      await oauthStore.registerClient(clientId, {
        clientId,
        redirectUris,
      });

      logger.info("OAuth client registered");

      return c.json({
        client_id: clientId,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }, 201);
    }
  );

  oauth.get(
    "/authorize",
    rateLimit({ maxRequests: 60, windowMs: 3600000 }),
    async (c) => {
    const responseType = c.req.query("response_type");
    const clientId = c.req.query("client_id");
    const redirectUri = c.req.query("redirect_uri");
    const state = c.req.query("state");
    const codeChallenge = c.req.query("code_challenge");
    const codeChallengeMethod = c.req.query("code_challenge_method");

    if (responseType !== "code") {
      logger.warn("OAuth authorization failed: unsupported response type");
      return c.json({ error: "unsupported_response_type" }, 400);
    }

    if (!clientId) {
      logger.warn("OAuth authorization failed: missing client_id");
      return c.json({ error: "invalid_request", error_description: "client_id is required" }, 400);
    }

    if (!redirectUri) {
      logger.warn("OAuth authorization failed: missing redirect_uri");
      return c.json({ error: "invalid_request", error_description: "redirect_uri is required" }, 400);
    }

    // The client must be registered and the redirect_uri must exactly match one
    // of its registered URIs. Without this check, an attacker could send a victim
    // a crafted link and have the authorization code delivered to their own server.
    const client = await oauthStore.getClient(clientId);
    if (!client) {
      logger.warn("OAuth authorization failed: unknown client_id");
      return c.json({ error: "invalid_client", error_description: "Unknown client_id" }, 400);
    }

    if (!client.redirectUris.includes(redirectUri)) {
      logger.warn("OAuth authorization failed: redirect_uri not registered for client");
      return c.json({ error: "invalid_request", error_description: "redirect_uri is not registered for this client" }, 400);
    }

    // PKCE with S256 is mandatory (OAuth 2.1 / MCP authorization spec).
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      logger.warn("OAuth authorization failed: missing or unsupported PKCE parameters");
      return c.json({ error: "invalid_request", error_description: "code_challenge with code_challenge_method=S256 is required" }, 400);
    }

    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      logger.warn("OAuth authorization failed: malformed code_challenge");
      return c.json({ error: "invalid_request", error_description: "Malformed code_challenge" }, 400);
    }

    if (!state) {
      logger.warn("OAuth authorization failed: missing state parameter");
      return c.json({ error: "invalid_request", error_description: "state parameter is required for CSRF protection" }, 400);
    }

    logger.info("Starting OAuth authorization flow");

    const internalState = crypto.randomUUID();

    await oauthStore.storeSession(internalState, {
      state,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      clientId,
    });

    const googleAuthUrl = new URL(GOOGLE_AUTH_URL);
    googleAuthUrl.searchParams.append("response_type", "code");
    googleAuthUrl.searchParams.append("client_id", config.clientId);
    googleAuthUrl.searchParams.append("redirect_uri", config.redirectUri);
    googleAuthUrl.searchParams.append("scope", "https://www.googleapis.com/auth/tasks");
    googleAuthUrl.searchParams.append("state", internalState);
    googleAuthUrl.searchParams.append("access_type", "offline");
    googleAuthUrl.searchParams.append("prompt", "consent");

    return c.redirect(googleAuthUrl.toString());
    }
  );

  oauth.get("/callback", async (c) => {
    const code = c.req.query("code");
    const internalState = c.req.query("state");
    const googleError = c.req.query("error");

    if (!internalState) {
      logger.warn("OAuth callback failed: missing state");
      return c.json({ error: "invalid_request" }, 400);
    }

    const session = await oauthStore.getSession(internalState);
    if (!session) {
      logger.warn("OAuth callback failed: invalid or expired state");
      return c.json({ error: "invalid_state" }, 400);
    }

    // The internal state is single-use.
    await oauthStore.deleteSession(internalState);

    if (googleError || !code) {
      logger.warn("OAuth callback: Google returned an error or no code");
      const errorUrl = new URL(session.redirectUri);
      errorUrl.searchParams.append("error", googleError === "access_denied" ? "access_denied" : "server_error");
      errorUrl.searchParams.append("state", session.state);
      return c.redirect(errorUrl.toString());
    }

    logger.info("Processing OAuth callback from Google");

    const authCode = crypto.randomUUID();

    await oauthStore.storeAuthCode(authCode, {
      googleCode: code,
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      codeChallenge: session.codeChallenge,
    });

    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.append("code", authCode);
    redirectUrl.searchParams.append("state", session.state);

    return c.redirect(redirectUrl.toString());
  });

  oauth.post(
    "/token",
    rateLimit({ maxRequests: 100, windowMs: 3600000 }),
    async (c) => {
    const body = await c.req.parseBody();
    const grantType = body.grant_type;
    const code = body.code;
    const codeVerifier = body.code_verifier;
    const redirectUri = body.redirect_uri;
    const clientId = body.client_id;

    if (grantType !== "authorization_code") {
      logger.warn("Token exchange failed: unsupported grant type");
      return c.json({ error: "unsupported_grant_type" }, 400);
    }

    if (typeof code !== "string" || !code) {
      logger.warn("Token exchange failed: missing code");
      return c.json({ error: "invalid_request", error_description: "code is required" }, 400);
    }

    const authCodeData = await oauthStore.getAuthCode(code);
    if (!authCodeData) {
      logger.warn("Token exchange failed: invalid authorization code");
      return c.json({ error: "invalid_grant" }, 400);
    }

    // Authorization codes are single-use: invalidate it on first presentation,
    // whether or not the exchange below succeeds.
    await oauthStore.deleteAuthCode(code);

    if (authCodeData.clientId && clientId !== authCodeData.clientId) {
      logger.warn("Token exchange failed: client_id mismatch");
      return c.json({ error: "invalid_grant", error_description: "client_id does not match authorization request" }, 400);
    }

    logger.info("Processing token exchange request");

    if (redirectUri !== authCodeData.redirectUri) {
      logger.warn("Token exchange failed: redirect_uri mismatch");
      return c.json({ error: "invalid_grant", error_description: "redirect_uri does not match authorization request" }, 400);
    }

    if (!authCodeData.codeChallenge) {
      // Should not happen: /authorize requires PKCE.
      logger.warn("PKCE validation failed: no code_challenge stored");
      return c.json({ error: "invalid_grant" }, 400);
    }

    if (typeof codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
      logger.warn("PKCE validation failed: missing or malformed code_verifier");
      return c.json({ error: "invalid_request", error_description: "valid code_verifier required" }, 400);
    }

    const hash = base64URLEncode(sha256(codeVerifier));
    if (!safeEqual(hash, authCodeData.codeChallenge)) {
      logger.warn("PKCE validation failed: invalid code_verifier");
      return c.json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
    }

    try {
      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code: authCodeData.googleCode,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok) {
        logger.error("Google token exchange failed", { status: tokenResponse.status });
        return c.json({ error: "server_error", error_description: "Failed to exchange Google token" }, 500);
      }

      const mcpToken = crypto.randomUUID();

      await tokenStore.storeTokens(mcpToken, {
        googleAccessToken: tokenData.access_token,
        googleRefreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
      });

      logger.info("Token exchange completed successfully");

      const MCP_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

      return c.json({
        access_token: mcpToken,
        token_type: "Bearer",
        expires_in: MCP_TOKEN_TTL_SECONDS,
      });
    } catch (error) {
      logger.error("Token exchange error", { error: String(error) });
      return c.json({ error: "server_error", error_description: "Failed to exchange authorization code" }, 500);
    }
    }
  );

  return oauth;
}

export async function refreshGoogleToken(
  refreshToken: string,
  config: OAuthConfig
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  logger.info("Refreshing Google access token");

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    logger.error("Google token refresh failed");
    throw new Error(`Failed to refresh Google token: ${tokenData.error}`);
  }

  logger.info("Token refresh completed successfully");

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || refreshToken,
    expiresIn: tokenData.expires_in,
  };
}
