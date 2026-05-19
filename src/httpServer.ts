import Fastify from "fastify";
import { config } from "./config.js";
import { FirestoreStore } from "./firestoreStore.js";
import { calendarClientFromConfig, gmailClientFromConfig } from "./gmailAuth.js";
import { GmailReader } from "./gmailClient.js";
import { GmailSyncService, isInvalidGrant, type GmailPushPayload } from "./gmailSyncService.js";
import { verifyTaskSecret } from "./httpAuth.js";
import { InboundEmailAuthError, InboundEmailPayloadError, parseInboundEmail, verifyInboundEmailRequest, type InboundEmailPayload } from "./inboundEmail.js";
import { logger } from "./logger.js";
import { ReservationOrchestrator } from "./reservationOrchestrator.js";
import { CalendarSync } from "./calendarSync.js";

interface PubSubPushBody {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

export async function startHttpServer(): Promise<void> {
  const store = new FirestoreStore();
  const gmail = config.GMAIL_API_ENABLED ? new GmailReader(await gmailClientFromConfig()) : null;
  const calendar = new CalendarSync(config.GOOGLE_CALENDAR_ENABLED ? await calendarClientFromConfig() : null);
  const orchestrator = new ReservationOrchestrator(store, gmail, undefined, undefined, calendar);
  const sync = gmail ? new GmailSyncService(store, gmail, orchestrator) : null;
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/events/gmail-pubsub", async (request, reply) => {
    if (!sync) return reply.code(204).send();
    const payload = decodePubSubPush(request.body as PubSubPushBody);
    if (!payload) {
      logger.warn({ body: request.body }, "Ignored malformed Pub/Sub push payload");
      return reply.code(204).send();
    }
    try {
      await sync.handlePush(payload);
      return reply.code(204).send();
    } catch (error) {
      if (isInvalidGrant(error)) return reply.code(204).send();
      throw error;
    }
  });

  app.post("/events/spohabi-email", async (request, reply) => {
    const payload = request.body as InboundEmailPayload;
    try {
      await verifyInboundEmailRequest(payload, {
        signature: request.headers["x-spohabi-email-signature"],
        timestamp: request.headers["x-spohabi-email-timestamp"]
      });
      const message = await parseInboundEmail(payload);
      await orchestrator.processEmailNotification(message);
      logger.info({ messageId: message.messageId, source: payload.source, from: message.from, subject: message.subject }, "Handled inbound Spohabi email");
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof InboundEmailAuthError) {
        logger.warn({ error }, "Rejected inbound email request");
        return reply.code(401).send({ error: error.message });
      }
      if (error instanceof InboundEmailPayloadError) {
        logger.warn({ error }, "Ignored malformed inbound email payload");
        return reply.code(204).send();
      }
      throw error;
    }
  });

  app.post("/tasks/renew-gmail-watch", async (_request, reply) => {
    if (!(await verifyTaskSecret(_request.headers["x-spohabi-task-secret"]))) return reply.code(401).send({ error: "invalid_task_secret" });
    if (!sync) return reply.code(204).send();
    try {
      await sync.renewWatch();
      return reply.code(204).send();
    } catch (error) {
      if (isInvalidGrant(error)) return reply.code(204).send();
      throw error;
    }
  });

  app.post("/tasks/gmail-sync", async (_request, reply) => {
    if (!(await verifyTaskSecret(_request.headers["x-spohabi-task-secret"]))) return reply.code(401).send({ error: "invalid_task_secret" });
    if (!sync) return reply.code(204).send();
    try {
      await sync.syncPending();
      return reply.code(204).send();
    } catch (error) {
      if (isInvalidGrant(error)) return reply.code(204).send();
      throw error;
    }
  });

  app.post("/tasks/expire-watchlist", async (_request, reply) => {
    if (!(await verifyTaskSecret(_request.headers["x-spohabi-task-secret"]))) return reply.code(401).send({ error: "invalid_task_secret" });
    const expired = await orchestrator.expireDueWatchesWithNotification();
    logger.info({ expired }, "Expired watchlist targets");
    return reply.code(204).send();
  });

  await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info({ port: config.PORT }, "Cloud Run HTTP server started");
}

export function decodePubSubPush(body: PubSubPushBody | null | undefined): GmailPushPayload | null {
  const data = body?.message?.data;
  if (!data) return null;
  try {
    const decoded = Buffer.from(data, "base64").toString("utf8");
    const payload = JSON.parse(decoded) as { emailAddress?: unknown; historyId?: unknown };
    if (!payload.emailAddress || !payload.historyId) return null;
    return { emailAddress: String(payload.emailAddress), historyId: String(payload.historyId) };
  } catch {
    return null;
  }
}
