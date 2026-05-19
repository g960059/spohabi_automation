import { google, calendar_v3, gmail_v1 } from "googleapis";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import http from "node:http";
import { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import { readSecret } from "./secretStore.js";

export function googleOAuthScopes(): string[] {
  const scopes = ["https://www.googleapis.com/auth/calendar.events"];
  if (config.GMAIL_API_ENABLED) scopes.unshift("https://www.googleapis.com/auth/gmail.readonly");
  return scopes;
}

interface InstalledClient {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

export function loadOAuthClient(): OAuth2Client {
  const raw = JSON.parse(readFileSync(config.GOOGLE_OAUTH_CLIENT_PATH, "utf8")) as InstalledClient;
  const client = raw.installed ?? raw.web;
  if (!client) throw new Error(`OAuth client JSON must contain installed or web client: ${config.GOOGLE_OAUTH_CLIENT_PATH}`);
  const redirectUri = client.redirect_uris.find((uri) => uri.includes("localhost")) ?? client.redirect_uris[0];
  const oauth = new google.auth.OAuth2(client.client_id, client.client_secret, redirectUri);

  try {
    const token = JSON.parse(readFileSync(config.GMAIL_TOKEN_PATH, "utf8"));
    oauth.setCredentials(token);
  } catch {
    // Token is created by auth:gmail.
  }

  return oauth;
}

export async function runGmailOAuth(): Promise<void> {
  const { oauth, closeServer } = await createInteractiveOAuthClient();
  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    scope: googleOAuthScopes(),
    prompt: "consent"
  });
  console.log(`Open this URL in your browser and authorize: ${googleOAuthScopes().join(", ")}`);
  console.log(authUrl);
  try {
    const code = await waitForOAuthCode();
    const { tokens } = await oauth.getToken(code);
    mkdirSync(dirname(config.GMAIL_TOKEN_PATH), { recursive: true });
    writeFileSync(config.GMAIL_TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    console.log(`Saved Gmail OAuth token to ${config.GMAIL_TOKEN_PATH}`);
    if (tokens.refresh_token) {
      console.log("Upload only the refresh_token to Secret Manager for Cloud Run. Do not store access_token as a secret.");
    }
  } finally {
    await closeServer();
  }
}

export function gmailClient(): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: loadOAuthClient() });
}

export function calendarClient(): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: loadOAuthClient() });
}

export async function gmailClientFromConfig(): Promise<gmail_v1.Gmail> {
  if (config.GMAIL_OAUTH_CLIENT_SECRET_NAME && config.GMAIL_REFRESH_TOKEN_SECRET_NAME) {
    return google.gmail({ version: "v1", auth: await loadOAuthClientFromSecrets() });
  }
  return gmailClient();
}

export async function calendarClientFromConfig(): Promise<calendar_v3.Calendar> {
  if (config.GMAIL_OAUTH_CLIENT_SECRET_NAME && config.GMAIL_REFRESH_TOKEN_SECRET_NAME) {
    return google.calendar({ version: "v3", auth: await loadOAuthClientFromSecrets() });
  }
  return calendarClient();
}

async function loadOAuthClientFromSecrets(): Promise<OAuth2Client> {
  const clientJson = await readSecret(config.GMAIL_OAUTH_CLIENT_SECRET_NAME);
  const refreshToken = await readSecret(config.GMAIL_REFRESH_TOKEN_SECRET_NAME);
  if (!clientJson || !refreshToken) throw new Error("Gmail OAuth client and refresh token secrets are required");
  const raw = JSON.parse(clientJson) as InstalledClient;
  const client = raw.installed ?? raw.web;
  if (!client) throw new Error("OAuth client secret must contain installed or web client");
  const redirectUri = client.redirect_uris.find((uri) => uri.includes("localhost")) ?? client.redirect_uris[0];
  const oauth = new google.auth.OAuth2(client.client_id, client.client_secret, redirectUri);
  oauth.setCredentials({ refresh_token: refreshToken.trim() });
  return oauth;
}

let oauthCodeResolver: ((code: string) => void) | null = null;
let oauthCodeRejecter: ((error: Error) => void) | null = null;

async function createInteractiveOAuthClient(): Promise<{ oauth: OAuth2Client; closeServer: () => Promise<void> }> {
  const raw = JSON.parse(readFileSync(config.GOOGLE_OAUTH_CLIENT_PATH, "utf8")) as InstalledClient;
  const client = raw.installed ?? raw.web;
  if (!client) throw new Error(`OAuth client JSON must contain installed or web client: ${config.GOOGLE_OAUTH_CLIENT_PATH}`);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end(`OAuth failed: ${error}`);
      oauthCodeRejecter?.(new Error(`OAuth failed: ${error}`));
      return;
    }
    if (!code) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Missing OAuth code.");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Gmail OAuth completed. You can close this tab and return to the terminal.");
    oauthCodeResolver?.(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind local OAuth callback server");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const oauth = new google.auth.OAuth2(client.client_id, client.client_secret, redirectUri);
  return {
    oauth,
    closeServer: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function waitForOAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    oauthCodeResolver = resolve;
    oauthCodeRejecter = reject;
  });
}
