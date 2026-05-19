import { FirestoreStore, maxHistoryId } from "./firestoreStore.js";
import { GmailHistoryTooOldError, GmailReader } from "./gmailClient.js";
import { logger } from "./logger.js";
import { ReservationOrchestrator } from "./reservationOrchestrator.js";
import { config } from "./config.js";
import { SlackNotifier } from "./slackNotifier.js";

const SYSTEM_WARNING_THROTTLE_MS = 24 * 60 * 60 * 1000;

export interface GmailPushPayload {
  emailAddress: string;
  historyId: string;
}

export class GmailSyncService {
  constructor(
    private store: FirestoreStore,
    private gmail: GmailReader,
    private orchestrator: ReservationOrchestrator,
    private notifier = new SlackNotifier()
  ) {}

  async handlePush(payload: GmailPushPayload): Promise<"processed" | "ignored" | "lease_busy"> {
    if (!payload.historyId) throw new Error("Gmail payload missing historyId");
    if (config.GMAIL_EXPECTED_EMAIL && payload.emailAddress.toLowerCase() !== config.GMAIL_EXPECTED_EMAIL.toLowerCase()) {
      logger.warn({ emailAddress: payload.emailAddress }, "Ignored Gmail Pub/Sub payload for unexpected mailbox");
      return "ignored";
    }
    await this.store.updatePendingHistoryId(payload.historyId);
    const result = await this.syncPending();
    logger.info({ result, historyId: payload.historyId }, "Handled Gmail Pub/Sub push");
    return result;
  }

  async syncPending(): Promise<"processed" | "lease_busy"> {
    let processedAny = false;
    for (;;) {
      const lease = await this.store.acquireSyncLease();
      if (!lease) return processedAny ? "processed" : "lease_busy";

      try {
        const targetHistoryId = maxHistoryId(lease.pendingHistoryId, lease.lastHistoryId);
        if (!lease.lastHistoryId) {
          await this.orchestrator.catchUpRecent({ maxResults: 50 });
          await this.store.completeSyncLease(lease.owner, targetHistoryId);
          processedAny = true;
          continue;
        }

        await this.orchestrator.processHistory(lease.lastHistoryId, targetHistoryId);
        await this.store.completeSyncLease(lease.owner, targetHistoryId);
        processedAny = true;
      } catch (error) {
        if (isInvalidGrant(error)) {
          logger.error({ error }, "Gmail OAuth refresh token is invalid or revoked; manual re-authentication required");
          if (await this.store.shouldNotifySystemWarning("gmail_invalid_grant", SYSTEM_WARNING_THROTTLE_MS)) {
            await this.notifier.systemWarning("Gmail OAuth refresh token is invalid", "Gmail同期が停止しています。手動で再認可してください。");
          }
          await this.store.failSyncLease(lease.owner, "invalid_grant");
          throw error;
        }
        if (isGmailHistoryTooOld(error)) {
          logger.error({ error }, "Gmail historyId is too old; resetting watch and running bounded catch-up");
          await this.notifier.systemWarning("Gmail history reset occurred", "Gmail History APIの差分取得に失敗したため、watchを再発行して直近メールをcatch-upしました。");
          const watch = await this.gmail.ensureWatch(requiredTopic());
          await this.orchestrator.catchUpRecent({ maxResults: 50 });
          await this.store.resetHistoryAfter404(watch.historyId);
          if (watch.expiration) await this.store.setWatchRenewal(watch);
          await this.store.failSyncLease(lease.owner, "history_404_reset");
          return "processed";
        }
        await this.store.failSyncLease(lease.owner, errorSummary(error));
        throw error;
      }
    }
  }

  async renewWatch(): Promise<void> {
    const watch = await this.gmail.ensureWatch(requiredTopic());
    await this.store.updatePendingHistoryId(watch.historyId);
    await this.syncPending();
    await this.store.setWatchRenewal(watch);
  }
}

function requiredTopic(): string {
  if (!config.GMAIL_PUBSUB_TOPIC) throw new Error("GMAIL_PUBSUB_TOPIC is required");
  return config.GMAIL_PUBSUB_TOPIC;
}

function isGmailHistoryTooOld(error: unknown): boolean {
  return error instanceof GmailHistoryTooOldError;
}

export function isInvalidGrant(error: unknown): boolean {
  const e = error as { message?: string; response?: { data?: { error?: string } }; errors?: Array<{ reason?: string; message?: string }> };
  return e.response?.data?.error === "invalid_grant" || e.message?.includes("invalid_grant") === true || Boolean(e.errors?.some((item) => item.reason === "invalid_grant" || item.message?.includes("invalid_grant")));
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
