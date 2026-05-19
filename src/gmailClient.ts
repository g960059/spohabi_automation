import type { gmail_v1 } from "googleapis";
import { stripHtml } from "./emailParser.js";
import { logger } from "./logger.js";

export interface GmailMessageContent {
  id: string;
  historyId?: string | null;
  from: string | null;
  subject: string | null;
  authenticationResults: string | null;
  text: string;
}

export class GmailReader {
  constructor(private gmail: gmail_v1.Gmail) {}

  async ensureWatch(topicName: string): Promise<{ historyId: string; expiration?: string | null }> {
    const result = await this.gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName,
        labelIds: ["INBOX"]
      }
    });
    const historyId = result.data.historyId;
    if (!historyId) throw new Error("Gmail watch did not return historyId");
    return { historyId, expiration: result.data.expiration ?? null };
  }

  async listRecentCandidateIds(maxResults = 20): Promise<string[]> {
    const result = await this.gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: "from:system@spohabi.com newer_than:30d"
    });
    return result.data.messages?.map((m) => m.id).filter((id): id is string => Boolean(id)) ?? [];
  }

  async listMessageIdsFromHistory(startHistoryId: string): Promise<string[]> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      let result;
      try {
        result = await this.gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          pageToken
        });
      } catch (error) {
        if (isGmailNotFound(error)) throw new GmailHistoryTooOldError(startHistoryId, error);
        throw error;
      }
      for (const item of result.data.history ?? []) {
        for (const added of item.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      pageToken = result.data.nextPageToken ?? undefined;
    } while (pageToken);
    return [...ids];
  }

  async getMessageContent(messageId: string): Promise<GmailMessageContent> {
    let result;
    try {
      result = await this.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full"
      });
    } catch (error) {
      if (isGmailNotFound(error)) throw new GmailMessageNotFoundError(messageId, error);
      throw error;
    }
    const message = result.data;
    if (!message.id || !message.payload) throw new Error(`Gmail message not found: ${messageId}`);
    const headers = message.payload.headers ?? [];
    const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? null;
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? null;
    const authenticationResults =
      headers
        .filter((h) => h.name?.toLowerCase() === "authentication-results")
        .map((h) => h.value)
        .filter((value): value is string => Boolean(value))
        .join("\n") || null;
    const text = extractTextFromPayload(message.payload);
    logger.debug({ messageId, from, subject }, "Loaded Gmail message");
    return {
      id: message.id,
      historyId: message.historyId ?? null,
      from,
      subject,
      authenticationResults,
      text
    };
  }
}

export class GmailHistoryTooOldError extends Error {
  constructor(
    readonly startHistoryId: string,
    options?: unknown
  ) {
    super(`Gmail historyId is too old: ${startHistoryId}`);
    this.name = "GmailHistoryTooOldError";
    this.cause = options;
  }
}

export class GmailMessageNotFoundError extends Error {
  constructor(
    readonly messageId: string,
    options?: unknown
  ) {
    super(`Gmail message not found: ${messageId}`);
    this.name = "GmailMessageNotFoundError";
    this.cause = options;
  }
}

function extractTextFromPayload(payload: gmail_v1.Schema$MessagePart): string {
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  walkPayload(payload, (part) => {
    const data = part.body?.data;
    if (!data) return;
    const decoded = decodeBase64Url(data);
    if (part.mimeType === "text/plain") textParts.push(decoded);
    if (part.mimeType === "text/html") htmlParts.push(stripHtml(decoded));
  });
  return (textParts.length ? textParts : htmlParts).join("\n").trim();
}

function walkPayload(part: gmail_v1.Schema$MessagePart, visitor: (part: gmail_v1.Schema$MessagePart) => void): void {
  visitor(part);
  for (const child of part.parts ?? []) walkPayload(child, visitor);
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function isGmailNotFound(error: unknown): boolean {
  const e = error as { code?: number; status?: number; response?: { status?: number; data?: { error?: { status?: string } } }; errors?: Array<{ reason?: string }> };
  return (
    e.code === 404 ||
    e.status === 404 ||
    e.response?.status === 404 ||
    e.response?.data?.error?.status === "NOT_FOUND" ||
    Boolean(e.errors?.some((item) => item.reason === "notFound"))
  );
}
