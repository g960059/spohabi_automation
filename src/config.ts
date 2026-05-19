import dotenv from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

dotenv.config({ quiet: true });

const envSchema = z.object({
  DRY_RUN: z.string().default("true").transform((v) => v.toLowerCase() !== "false"),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().default(8080),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_PATH: z.string().default("./secrets/google-oauth-client.json"),
  GMAIL_TOKEN_PATH: z.string().default("./data/google-token.json"),
  GMAIL_OAUTH_CLIENT_SECRET_NAME: z.string().optional(),
  GMAIL_REFRESH_TOKEN_SECRET_NAME: z.string().optional(),
  SPOHABI_PASSWORD_SECRET_NAME: z.string().optional(),
  SPOHABI_API_KEY_SECRET_NAME: z.string().optional(),
  SLACK_WEBHOOK_SECRET_NAME: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),
  INBOUND_EMAIL_HMAC_SECRET_NAME: z.string().optional(),
  INBOUND_EMAIL_HMAC_SECRET: z.string().optional(),
  INBOUND_EMAIL_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  INBOUND_EMAIL_EXPECTED_FROM: z.string().default("system@spohabi.com"),
  TASK_SHARED_SECRET_NAME: z.string().optional(),
  TASK_SHARED_SECRET: z.string().optional(),
  GMAIL_API_ENABLED: z.string().default("true").transform((v) => v.toLowerCase() !== "false"),
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  GMAIL_PUBSUB_SUBSCRIPTION: z.string().optional(),
  GMAIL_PUBSUB_SUBSCRIPTION_PATH: z.string().optional(),
  GMAIL_EXPECTED_EMAIL: z.string().optional(),
  SPOHABI_EMAIL: z.string().optional(),
  SPOHABI_PASSWORD: z.string().optional(),
  SPOHABI_LAST_NAME: z.string().optional(),
  SPOHABI_FIRST_NAME: z.string().optional(),
  SPOHABI_TEL: z.string().optional(),
  SPOHABI_POSTAL_CODE: z.string().optional(),
  SPOHABI_PREFECTURE: z.string().optional(),
  SPOHABI_CITY: z.string().optional(),
  SPOHABI_ADDRESS_LINE1: z.string().optional(),
  SPOHABI_ADDRESS_LINE2: z.string().optional(),
  SPOHABI_MEMBER_NOTE: z.string().optional(),
  SPOHABI_FIREBASE_TENANT_ID: z.string().default("spohabi-members-nemtn"),
  GOOGLE_CALENDAR_ENABLED: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
  GOOGLE_CALENDAR_RECONCILE_DAYS: z.coerce.number().int().positive().default(60),
  GOOGLE_CALENDAR_RECONCILE_SCHOOL_SLUG: z.string().default("fc-tennis"),
  SPOHABI_GRAPHQL_ENDPOINT: z.string().url().default("https://fitting-jay-29.hasura.app/v1/graphql"),
  SPOHABI_RESERVE_API_BASE: z.string().url().default("https://product-spohabi-tennis-api-cloud-run-275144620206.asia-northeast1.run.app"),
  SPOHABI_API_KEY: z.string().optional()
});

const parsed = envSchema.parse(process.env);
mkdirSync(dirname(resolve(parsed.GMAIL_TOKEN_PATH)), { recursive: true });

export const config = {
  ...parsed,
  GMAIL_EXPECTED_EMAIL: parsed.GMAIL_EXPECTED_EMAIL || parsed.SPOHABI_EMAIL,
  GOOGLE_OAUTH_CLIENT_PATH: resolve(parsed.GOOGLE_OAUTH_CLIENT_PATH),
  GMAIL_TOKEN_PATH: resolve(parsed.GMAIL_TOKEN_PATH)
};

export type AppConfig = typeof config;
