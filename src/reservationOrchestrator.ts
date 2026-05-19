import { FirestoreStore } from "./firestoreStore.js";
import { isSpohabiReservationCancellationText, isSpohabiReservationReminderText, parseReservationConfirmationEmail, parseVacancyEmail } from "./emailParser.js";
import { GmailMessageNotFoundError, GmailReader } from "./gmailClient.js";
import { logger } from "./logger.js";
import { SpohabiClient } from "./spohabiClient.js";
import { expireAtForLessonStart, isExpired, normalizeLessonUrl, toJstParts } from "./time.js";
import { config } from "./config.js";
import { redactSensitive } from "./redact.js";
import { SlackNotifier } from "./slackNotifier.js";
import { CalendarSync } from "./calendarSync.js";

export interface EmailNotificationContent {
  messageId: string;
  historyId?: string | null;
  from: string | null;
  subject: string | null;
  authenticationResults: string | null;
  text: string;
}

export class ReservationOrchestrator {
  constructor(
    private db: FirestoreStore,
    private gmail: GmailReader | null = null,
    private spohabi = new SpohabiClient(),
    private notifier = new SlackNotifier(),
    private calendar = new CalendarSync(null)
  ) {}

  async processMessage(messageId: string, options: { allowDryRunReplay?: boolean } = {}): Promise<void> {
    if (await this.db.hasProcessedMessage(messageId)) {
      logger.debug({ messageId }, "Gmail message already processed");
      return;
    }

    await this.expireDueWatchesWithNotification();
    if (!this.gmail) throw new Error("Gmail API is disabled");
    const message = await this.gmail.getMessageContent(messageId);
    await this.processEmailNotification({ ...message, messageId: message.id }, options);
  }

  async processEmailNotification(message: EmailNotificationContent, options: { allowDryRunReplay?: boolean } = {}): Promise<void> {
    const messageId = message.messageId;
    if (await this.db.hasProcessedMessage(messageId)) {
      logger.debug({ messageId }, "Email notification already processed");
      return;
    }

    await this.expireDueWatchesWithNotification();
    if (!isTrustedSpohabiSender(message.from) || !hasTrustedSpohabiAuthentication(message.authenticationResults)) {
      await this.db.markProcessed({ messageId, historyId: message.historyId ?? undefined, status: "ignored", reason: "untrusted_sender" });
      logger.warn({ messageId, from: message.from }, "Ignored vacancy-like Gmail message from unexpected sender");
      return;
    }

    const parsed = parseVacancyEmail(message.text);
    if (!parsed) {
      const confirmation = parseReservationConfirmationEmail(message.text);
      const isCancellation = isSpohabiReservationCancellationText(message.text);
      const isReminder = isSpohabiReservationReminderText(message.text);
      if (!confirmation && !isCancellation && !isReminder) {
        await this.db.markProcessed({ messageId, historyId: message.historyId ?? undefined, status: "ignored", reason: "not_spohabi_vacancy_or_confirmation" });
        return;
      }
      if (!(await this.db.claimMessage(messageId, message.historyId ?? undefined, Boolean(options.allowDryRunReplay && !config.DRY_RUN)))) {
        logger.debug({ messageId }, "Gmail message already claimed");
        return;
      }
      let outcome;
      try {
        outcome = await this.reconcileCalendarFromSpohabi(calendarReconcileReason({ confirmation: Boolean(confirmation), cancellation: isCancellation, reminder: isReminder }));
      } catch (error) {
        logger.error({ error, messageId }, "Google Calendar reconcile from Spohabi email failed");
        await this.db.markProcessed({
          messageId,
          historyId: message.historyId ?? undefined,
          status: "calendar_failed",
          reason: JSON.stringify(errorSummary(error))
        });
        return;
      }
      await this.db.markProcessed({
        messageId,
        historyId: message.historyId ?? undefined,
        status: outcome.status === "disabled" ? "calendar_disabled" : "calendar_reconciled",
        reason: outcome.status === "disabled" ? outcome.status : JSON.stringify(outcome.result)
      });
      return;
    }

    const expiresAt = expireAtForLessonStart(new Date(parsed.targetStartAt));
    if (isExpired(expiresAt)) {
      await this.db.markProcessed({ messageId, historyId: message.historyId ?? undefined, status: "ignored", reason: "vacancy_expired" });
      return;
    }

    if (!(await this.db.claimMessage(messageId, message.historyId ?? undefined, Boolean(options.allowDryRunReplay && !config.DRY_RUN)))) {
      logger.debug({ messageId }, "Gmail message already claimed");
      return;
    }

    const watch = await this.db.upsertWatchFromVacancy({
      lessonUrl: normalizeLessonUrl(parsed.lessonUrl),
      lessonId: parsed.lessonId,
      schoolSlug: parsed.schoolSlug,
      targetStartAt: parsed.targetStartAt,
      expiresAt,
      lessonName: parsed.lessonName,
      note: "auto-created from Spohabi vacancy notification"
    });

    if (!(await this.db.claimWatchForReservation(watch.id, messageId))) {
      await this.db.markProcessed({ messageId, historyId: message.historyId ?? undefined, watchlistId: watch.id, status: "ignored", reason: "watch_reservation_already_claimed" });
      logger.info({ watchId: watch.id, messageId }, "Watch reservation was already claimed");
      return;
    }

    let outcome;
    try {
      const currentWatch = (await this.db.findWatchById(watch.id)) ?? watch;
      outcome = await this.spohabi.reserveForWatch(currentWatch);
    } catch (error) {
      logger.error({ error, watchId: watch.id }, "Spohabi reservation path threw");
      await this.db.addAttempt({ watchlistId: watch.id, messageId, status: "failed", reason: "spohabi_exception", raw: errorSummary(error) });
      await this.db.releaseWatchReservation(watch.id);
      await this.notifier.reservationAttempt(watch, { status: "failed", reason: "spohabi_exception", raw: errorSummary(error) });
      throw error;
    }

    await this.db.addAttempt({ watchlistId: watch.id, messageId, status: outcome.status, reason: outcome.reason, raw: redactSensitive(outcome.raw) });

    if (outcome.status === "reserved") {
      await this.db.updateWatchStatus(watch.id, "reserved");
      await this.db.markProcessed({ messageId, historyId: message.historyId ?? undefined, watchlistId: watch.id, status: "reserved", reason: outcome.reason });
      await this.notifier.reservationAttempt({ ...watch, status: "reserved" }, outcome);
      await this.reconcileCalendarSafely("auto_reservation_success");
      logger.info({ watchId: watch.id }, "Reserved Spohabi lesson");
      return;
    }

    if (outcome.status === "missed" || outcome.status === "dry_run") {
      await this.db.releaseWatchReservation(watch.id);
    } else if (outcome.status === "blocked") {
      await this.db.updateWatchStatus(watch.id, "blocked");
    } else {
      await this.db.releaseWatchReservation(watch.id);
      await this.notifier.reservationAttempt(watch, outcome);
      throw new Error(`Transient Spohabi reservation failure: ${outcome.reason}`);
    }

    await this.db.markProcessed({ messageId, historyId: message.historyId ?? undefined, watchlistId: watch.id, status: outcome.status, reason: outcome.reason });
    const notifiedStatus = outcome.status === "blocked" ? "blocked" : "watching";
    await this.notifier.reservationAttempt({ ...watch, status: notifiedStatus }, outcome);
    await this.reconcileCalendarSafely(`auto_reservation_${outcome.status}`);
    logger.info({ watchId: watch.id, outcome }, "Reservation attempt completed without reservation");
  }

  async catchUpRecent(options: { allowDryRunReplay?: boolean; maxResults?: number } = {}): Promise<void> {
    if (!this.gmail) throw new Error("Gmail API is disabled");
    const ids = await this.gmail.listRecentCandidateIds(options.maxResults ?? 50);
    for (const id of ids.reverse()) {
      try {
        await this.processMessage(id, { allowDryRunReplay: options.allowDryRunReplay });
      } catch (error) {
        if (error instanceof GmailMessageNotFoundError) {
          logger.info({ messageId: id }, "Skipped Gmail catch-up message that no longer exists");
          continue;
        }
        throw error;
      }
    }
  }

  async processHistory(startHistoryId: string, newHistoryId: string): Promise<void> {
    if (!this.gmail) throw new Error("Gmail API is disabled");
    const ids = await this.gmail.listMessageIdsFromHistory(startHistoryId);
    for (const id of ids) {
      try {
        await this.processMessage(id);
      } catch (error) {
        if (error instanceof GmailMessageNotFoundError) {
          logger.info({ messageId: id }, "Skipped Gmail history message that no longer exists");
          continue;
        }
        throw error;
      }
    }
  }

  async expireDueWatchesWithNotification(): Promise<number> {
    const expired = await this.db.expireDueWatches();
    for (const item of expired) {
      await this.notifier.expired(item);
    }
    return expired.length;
  }

  async reconcileCalendarFromSpohabi(reason: string): Promise<{ status: "disabled" } | { status: "reconciled"; result: { created: number; exists: number; deleted: number; kept: number } }> {
    if (!config.GOOGLE_CALENDAR_ENABLED) {
      logger.info({ reason }, "Google Calendar reconcile disabled");
      return { status: "disabled" };
    }
    const fromDate = todayJstDateSlash();
    const toDate = futureJstDateSlash(config.GOOGLE_CALENDAR_RECONCILE_DAYS);
    const reservations = await this.spohabi.listCurrentReservations({
      fromDate,
      toDate,
      schoolSlug: config.GOOGLE_CALENDAR_RECONCILE_SCHOOL_SLUG
    });
    const result = await this.calendar.reconcileReservations({
      reservations,
      timeMin: `${fromDate.replace(/\//g, "-")}T00:00:00+09:00`,
      timeMax: `${toDate.replace(/\//g, "-")}T23:59:59+09:00`,
      deleteExtra: true
    });
    logger.info({ reason, result, reservations: reservations.length, fromDate, toDate }, "Reconciled Google Calendar from current Spohabi reservations");
    return { status: "reconciled", result };
  }

  private async reconcileCalendarSafely(reason: string): Promise<void> {
    try {
      await this.reconcileCalendarFromSpohabi(reason);
    } catch (error) {
      logger.error({ error, reason }, "Google Calendar reconcile failed");
    }
  }
}

function isTrustedSpohabiSender(from: string | null): boolean {
  if (!from) return false;
  return /(^|<)\s*system@spohabi\.com\s*(>|$)/i.test(from);
}

function hasTrustedSpohabiAuthentication(authenticationResults: string | null): boolean {
  if (!authenticationResults) return false;
  const lower = authenticationResults.toLowerCase();
  const hasPass = lower.includes("spf=pass") || lower.includes("dkim=pass") || lower.includes("dmarc=pass");
  return hasPass && lower.includes("spohabi.com");
}

function errorSummary(error: unknown): Record<string, string> {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}

function calendarReconcileReason(input: { confirmation: boolean; cancellation: boolean; reminder: boolean }): string {
  if (input.confirmation) return "reservation_confirmation_email";
  if (input.cancellation) return "reservation_cancellation_email";
  if (input.reminder) return "reservation_reminder_email";
  return "spohabi_reservation_email";
}

function todayJstDateSlash(): string {
  return toJstParts(new Date()).date.replace(/-/g, "/");
}

function futureJstDateSlash(days: number): string {
  return toJstParts(new Date(Date.now() + days * 24 * 60 * 60 * 1000)).date.replace(/-/g, "/");
}
