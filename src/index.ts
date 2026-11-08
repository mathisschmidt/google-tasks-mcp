#!/usr/bin/env node

import process from "node:process";
import { initOAuthStore } from "./auth/oauth.ts";
import { tokenStore } from "./auth/token-store.ts";
import { createApp } from "./server/app.ts";
import { loadServerSettings, setOAuthConfig, setServerSettings } from "./config.ts";
import { initRateLimiter } from "./server/rate-limiter.ts";
import { createLogger } from "./utils/logger.ts";

const logger = createLogger({ component: "main" });

const settings = loadServerSettings();
setServerSettings(settings);

await tokenStore.init();
await initOAuthStore();
await initRateLimiter();

const oauthConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  redirectUri: process.env.GOOGLE_REDIRECT_URI ||
    (settings.publicUrl ? `${settings.publicUrl}/callback` : `http://localhost:${settings.port}/callback`),
  authPassword: settings.authPassword,
};

setOAuthConfig(oauthConfig);

if (!settings.authPassword) {
  logger.warn(
    "MCP_AUTH_PASSWORD is not set: anyone who can reach this server can connect their own Google account through it",
  );
}

const app = createApp({ oauthConfig });

// deno-lint-ignore no-explicit-any
const deno = (globalThis as any).Deno;
if (!deno?.serve) {
  throw new Error("This server must be run with Deno (deno task dev, or the Docker image)");
}

deno.serve(
  {
    hostname: settings.host,
    port: settings.port,
    onListen: ({ hostname, port }: { hostname: string; port: number }) => {
      logger.info(`Listening on http://${hostname}:${port}` +
        (settings.publicUrl ? ` (public URL: ${settings.publicUrl})` : ""));
    },
  },
  app.fetch,
);
