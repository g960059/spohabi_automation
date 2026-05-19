import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { simpleParser } from "mailparser";
import { config } from "./config.js";
import { stripHtml } from "./emailParser.js";
import { readSecret } from "./secretStore.js";
import type { EmailNotificationContent } from "./reservationOrchestrator.js";

export interface InboundEmailPayload {
  rawEmailBase64?: unknown;
  receivedAt?: unknown;
  source?: unknown;
}

export interface InboundEmailHeaders {
  signature?: string | string[];
  timestamp?: string | string[];
}

export async function verifyInboundEmailRequest(payload: InboundEmailPayload, headers: InboundEmailHeaders): Promise<void> {
  const secret = await inboundSecret();
  if (!secret) throw new InboundEmailAuthError("inbound_email_secret_not_configured");
  const rawEmailBase64 = stringField(payload.rawEmailBase64);
  if (!rawEmailBase64) throw new InboundEmailPayloadError("missing_raw_email");
  const timestamp = firstHeader(headers.timestamp);
  const signature = firstHeader(headers.signature);
  if (!timestamp || !signature) throw new InboundEmailAuthError("missing_signature");
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) throw new InboundEmailAuthError("invalid_timestamp");
  if (Math.abs(Date.now() - timestampMs) > config.INBOUND_EMAIL_MAX_AGE_SECONDS * 1000) {
    throw new InboundEmailAuthError("stale_signature");
  }
  const expected = hmacSignature(secret, timestamp, rawEmailBase64);
  if (!constantTimeEqual(signature, expected)) throw new InboundEmailAuthError("invalid_signature");
}

export async function parseInboundEmail(payload: InboundEmailPayload): Promise<EmailNotificationContent> {
  const rawEmailBase64 = stringField(payload.rawEmailBase64);
  if (!rawEmailBase64) throw new InboundEmailPayloadError("missing_raw_email");
  const raw = Buffer.from(rawEmailBase64, "base64");
  const parsed = await simpleParser(raw);
  const from = parsed.from?.text ?? null;
  const subject = parsed.subject ?? null;
  const authenticationResults = headerValues(parsed.headers.get("authentication-results"));
  const text = (parsed.text || (parsed.html ? stripHtml(parsed.html) : "")).trim();
  const rawMessageId = typeof parsed.messageId === "string" && parsed.messageId ? parsed.messageId : createHash("sha256").update(raw).digest("hex");
  return {
    messageId: `inbound_${createHash("sha256").update(rawMessageId).digest("hex")}`,
    from,
    subject,
    authenticationResults,
    text
  };
}

export class InboundEmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundEmailAuthError";
  }
}

export class InboundEmailPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundEmailPayloadError";
  }
}

async function inboundSecret(): Promise<string | undefined> {
  const secret = config.INBOUND_EMAIL_HMAC_SECRET || (await readSecret(config.INBOUND_EMAIL_HMAC_SECRET_NAME));
  return secret?.trim();
}

function hmacSignature(secret: string, timestamp: string, rawEmailBase64: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawEmailBase64}`).digest("hex")}`;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function headerValues(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.map(String).join("\n");
  return String(value);
}
