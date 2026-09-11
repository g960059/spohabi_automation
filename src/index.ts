#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { config } from "./config.js";
import { runGmailOAuth, calendarClientFromConfig, gmailClientFromConfig } from "./gmailAuth.js";
import { GmailReader } from "./gmailClient.js";
import { ReservationOrchestrator } from "./reservationOrchestrator.js";
import { logger } from "./logger.js";
import { expireAtForLessonStart, extractLessonInfo, normalizeLessonUrl, parseJstDateTime, toJstParts } from "./time.js";
import { FirestoreStore } from "./firestoreStore.js";
import { startHttpServer } from "./httpServer.js";
import { GmailSyncService } from "./gmailSyncService.js";
import { SpohabiClient } from "./spohabiClient.js";
import { SlackNotifier } from "./slackNotifier.js";
import { CalendarSync } from "./calendarSync.js";
import { parseReservationConfirmationEmail } from "./emailParser.js";

const program = new Command();

program.name("spohabi-automation").description("Spohabi vacancy notification triggered reservation worker");

program.command("auth:gmail").description("Run first-time Gmail OAuth with readonly scope").action(async () => {
  await runGmailOAuth();
});

program.command("auth:upload-refresh-token").description("Upload the locally saved OAuth refresh token to Secret Manager").action(async () => {
  if (!config.GOOGLE_CLOUD_PROJECT) throw new Error("GOOGLE_CLOUD_PROJECT is required");
  if (!config.GMAIL_REFRESH_TOKEN_SECRET_NAME) throw new Error("GMAIL_REFRESH_TOKEN_SECRET_NAME is required");
  const token = JSON.parse(readFileSync(config.GMAIL_TOKEN_PATH, "utf8")) as { refresh_token?: unknown };
  if (typeof token.refresh_token !== "string" || token.refresh_token.length < 20) {
    throw new Error(`No refresh_token found in ${config.GMAIL_TOKEN_PATH}. Run auth:gmail first.`);
  }

  const secretName = normalizeSecretName(config.GMAIL_REFRESH_TOKEN_SECRET_NAME, config.GOOGLE_CLOUD_PROJECT);
  const client = new SecretManagerServiceClient();
  const [version] = await client.addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(token.refresh_token, "utf8") }
  });
  console.log(`Created Secret Manager version: ${version.name}`);
});

program
  .command("watch:add")
  .description("Add or update a Spohabi lesson watch target")
  .requiredOption("--lesson-url <url>", "Spohabi lesson URL")
  .requiredOption("--target <datetime>", "Target lesson start in JST, e.g. 2026/05/09 08:00")
  .option("--lesson-name <name>", "Lesson name")
  .option("--ticket-priority <csv>", "Comma-separated ticket name priority")
  .option("--note <note>", "Optional note")
  .action(async (options) => {
    const store = new FirestoreStore();
    const lessonUrl = normalizeLessonUrl(options.lessonUrl);
    const { slug, lessonId } = extractLessonInfo(lessonUrl);
    const target = parseJstDateTime(options.target);
    const watch = await store.addWatch({
      lessonUrl,
      lessonId,
      schoolSlug: slug,
      targetStartAt: target.toISOString(),
      expiresAt: expireAtForLessonStart(target),
      lessonName: options.lessonName,
      ticketPriority: splitCsv(options.ticketPriority),
      note: options.note
    });
    console.log(JSON.stringify(formatWatch(watch), null, 2));
  });

program
  .command("watch:list")
  .description("List watch targets")
  .option("--status <status>", "Filter by status")
  .action(async (options) => {
    const store = new FirestoreStore();
    const rows = await store.listWatches(options.status);
    console.table(rows.map(formatWatch));
  });

program.command("watch:expire").description("Expire watch targets whose cutoff has passed").action(async () => {
  const store = new FirestoreStore();
  const expired = await store.expireDueWatches();
  console.log(`Expired ${expired.length} watch target(s).`);
});

program
  .command("reserve:once")
  .description("Manually attempt one reservation for a specific lesson target")
  .requiredOption("--lesson-url <url>", "Spohabi lesson URL")
  .requiredOption("--target <datetime>", "Target lesson start in JST, e.g. 2026/05/20 18:20")
  .option("--lesson-name <name>", "Lesson name")
  .option("--ticket-priority <csv>", "Comma-separated ticket name priority")
  .option("--note <note>", "Optional note")
  .option("--force", "Allow retrying a non-watching watch target")
  .action(async (options) => {
    const store = new FirestoreStore();
    const lessonUrl = normalizeLessonUrl(options.lessonUrl);
    const { slug, lessonId } = extractLessonInfo(lessonUrl);
    const target = parseJstDateTime(options.target);
    const watchId = store.watchId(slug, lessonId, target.toISOString());
    let watch = await store.findWatchById(watchId);

    if (!watch) {
      watch = await store.addWatch({
        lessonUrl,
        lessonId,
        schoolSlug: slug,
        targetStartAt: target.toISOString(),
        expiresAt: expireAtForLessonStart(target),
        lessonName: options.lessonName,
        ticketPriority: splitCsv(options.ticketPriority),
        note: options.note
      });
    } else if (watch.status !== "watching") {
      if (!options.force) {
        throw new Error(`Watch target ${watch.id} is ${watch.status}. Pass --force to retry it.`);
      }
      await store.updateWatchStatus(watch.id, "watching");
      watch = (await store.findWatchById(watch.id)) ?? watch;
    }

    const messageId = `manual-${Date.now()}`;
    if (!(await store.claimWatchForReservation(watch.id, messageId))) {
      throw new Error(`Failed to claim watch target for reservation: ${watch.id}`);
    }

    const claimedWatch = (await store.findWatchById(watch.id)) ?? watch;
    const outcome = await new SpohabiClient().reserveForWatch(claimedWatch, (slot) => store.canReserveWatch(watch.id, messageId, slot));
    await store.addAttempt({ watchlistId: watch.id, messageId, status: outcome.status, reason: outcome.reason, raw: outcome.raw });

    if (outcome.status === "reserved") {
      await store.updateWatchStatus(watch.id, "reserved");
    } else if (outcome.status === "blocked") {
      await store.updateWatchStatus(watch.id, "blocked");
    } else {
      await store.releaseWatchReservation(watch.id);
    }

    const updatedWatch = (await store.findWatchById(watch.id)) ?? claimedWatch;
    await new SlackNotifier().reservationAttempt(updatedWatch, outcome);
    console.log(JSON.stringify({ watch: formatWatch(updatedWatch), outcome }, null, 2));
  });

program.command("gmail:watch").description("Register or renew Gmail watch").action(async () => {
  if (!config.GMAIL_PUBSUB_TOPIC) throw new Error("GMAIL_PUBSUB_TOPIC is required");
  const store = new FirestoreStore();
  const gmail = new GmailReader(await gmailClientFromConfig());
  const calendar = new CalendarSync(config.GOOGLE_CALENDAR_ENABLED ? await calendarClientFromConfig() : null);
  const orchestrator = new ReservationOrchestrator(store, gmail, undefined, undefined, calendar);
  const sync = new GmailSyncService(store, gmail, orchestrator);
  await sync.renewWatch();
  console.log("Renewed Gmail watch and drained pending history.");
});

program.command("gmail:catch-up").description("Process recent matching Gmail notifications once").action(async () => {
  const store = new FirestoreStore();
  const calendar = new CalendarSync(config.GOOGLE_CALENDAR_ENABLED ? await calendarClientFromConfig() : null);
  const orchestrator = new ReservationOrchestrator(store, new GmailReader(await gmailClientFromConfig()), undefined, undefined, calendar);
  await orchestrator.catchUpRecent({ allowDryRunReplay: true, maxResults: 50 });
});

program
  .command("calendar:catch-up")
  .description("Create Google Calendar events from recent Spohabi reservation confirmation emails")
  .option("--max-results <n>", "Maximum recent Spohabi emails to inspect", "50")
  .option("--unsafe-from-email-history", "Allow syncing from historical Gmail reservation confirmations")
  .action(async (options) => {
    if (!options.unsafeFromEmailHistory) {
      throw new Error("calendar:catch-up can recreate canceled reservations from old emails. Use calendar:reconcile instead, or pass --unsafe-from-email-history explicitly.");
    }
    if (!config.GOOGLE_CALENDAR_ENABLED) throw new Error("GOOGLE_CALENDAR_ENABLED=true is required");
    const gmail = new GmailReader(await gmailClientFromConfig());
    const calendar = new CalendarSync(await calendarClientFromConfig());
    const ids = await gmail.listRecentCandidateIds(Number(options.maxResults));
    let synced = 0;
    for (const id of ids.reverse()) {
      const message = await gmail.getMessageContent(id);
      const confirmation = parseReservationConfirmationEmail(message.text);
      if (!confirmation) continue;
      const outcome = await calendar.syncReservation(id, confirmation);
      if (outcome.status === "created" || outcome.status === "exists") synced += 1;
      console.log(JSON.stringify({ messageId: id, outcome, lessonName: confirmation.lessonName, target: toJstParts(new Date(confirmation.targetStartAt)).compactDateTime }));
    }
    console.log(`Synced ${synced} reservation confirmation(s).`);
  });

program
  .command("calendar:reconcile")
  .description("Reconcile Google Calendar events from the current Spohabi reservation list")
  .option("--from <date>", "JST date YYYY/MM/DD. Default: today")
  .option("--to <date>", "JST date YYYY/MM/DD. Default: GOOGLE_CALENDAR_RECONCILE_DAYS from today")
  .option("--school-slug <slug>", "Limit to one school slug", config.GOOGLE_CALENDAR_RECONCILE_SCHOOL_SLUG)
  .option("--delete-extra", "Delete existing Spohabi calendar events in range that are not in current Spohabi reservations")
  .action(async (options) => {
    if (!config.GOOGLE_CALENDAR_ENABLED) throw new Error("GOOGLE_CALENDAR_ENABLED=true is required");
    const fromDate = normalizeDateOption(options.from) ?? toJstParts(new Date()).compactDateTime.slice(0, 10);
    const toDate =
      normalizeDateOption(options.to) ?? toJstParts(new Date(Date.now() + config.GOOGLE_CALENDAR_RECONCILE_DAYS * 24 * 60 * 60 * 1000)).compactDateTime.slice(0, 10);
    const spohabi = new SpohabiClient();
    const reservations = await spohabi.listCurrentReservations({ fromDate, toDate, schoolSlug: options.schoolSlug });
    const calendar = new CalendarSync(await calendarClientFromConfig());
    const result = await calendar.reconcileReservations({
      reservations,
      timeMin: `${fromDate.replace(/\//g, "-")}T00:00:00+09:00`,
      timeMax: `${toDate.replace(/\//g, "-")}T23:59:59+09:00`,
      deleteExtra: Boolean(options.deleteExtra)
    });
    console.table(
      reservations.map((item) => ({
        start: toJstParts(new Date(item.targetStartAt)).compactDateTime,
        end: toJstParts(new Date(item.targetEndAt)).time,
        lesson: item.lessonName,
        court: item.court,
        coach: item.coach
      }))
    );
    console.log(JSON.stringify(result, null, 2));
  });

program.command("http").description("Run the Cloud Run HTTP service").action(startHttpServer);
program.command("serve").description("Alias for http").action(startHttpServer);

program.parseAsync(process.argv).catch((error) => {
  logger.error({ error }, "Command failed");
  process.exitCode = 1;
});

function splitCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function formatWatch(row: {
  id: string;
  lesson_url: string;
  lesson_id: number;
  school_slug: string;
  target_start_at: string;
  expires_at: string;
  lesson_name: string | null;
  status: string;
  event_date_id: number | null;
}) {
  return {
    id: row.id,
    status: row.status,
    school: row.school_slug,
    lesson_id: row.lesson_id,
    target_jst: toJstParts(new Date(row.target_start_at)).compactDateTime,
    expires_jst: toJstParts(new Date(row.expires_at)).compactDateTime,
    lesson_name: row.lesson_name,
    event_date_id: row.event_date_id,
    lesson_url: row.lesson_url
  };
}

function normalizeDateOption(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/-/g, "/");
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(normalized)) throw new Error(`Invalid date: ${value}`);
  return normalized;
}

function normalizeSecretName(value: string, projectId: string): string {
  if (value.startsWith("projects/")) return value.replace(/\/versions\/[^/]+$/, "");
  return `projects/${projectId}/secrets/${value}`;
}
