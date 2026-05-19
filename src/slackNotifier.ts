import { config } from "./config.js";
import { logger } from "./logger.js";
import { readSecret } from "./secretStore.js";
import { toJstParts } from "./time.js";
import type { ReservationOutcome, WatchlistItem } from "./types.js";

type SlackLevel = "success" | "warning" | "error" | "info";

export class SlackNotifier {
  async reservationAttempt(item: WatchlistItem, outcome: ReservationOutcome): Promise<void> {
    const level = outcome.status === "reserved" ? "success" : outcome.status === "failed" || outcome.status === "blocked" ? "error" : "warning";
    const title =
      outcome.status === "reserved"
        ? "スポハビ予約が取れました"
        : outcome.status === "missed"
          ? "スポハビ予約は取れませんでした"
          : outcome.status === "dry_run"
            ? "スポハビ予約DRY RUN"
            : "スポハビ予約に確認が必要です";
    await this.send(level, title, item, outcome.reason);
  }

  async expired(item: WatchlistItem): Promise<void> {
    await this.send("info", "キャンセル待ち対象が時間切れになりました", item, "レッスン開始10分前を過ぎたため期限切れにしました");
  }

  async systemWarning(title: string, reason: string): Promise<void> {
    await this.post({
      text: `${iconFor("warning")} ${title}\n${reason}`
    });
  }

  private async send(level: SlackLevel, title: string, item: WatchlistItem, reason: string): Promise<void> {
    const target = toJstParts(new Date(item.target_start_at)).compactDateTime;
    const lines = [
      `${iconFor(level)} *${title}*`,
      `*レッスン:* ${item.lesson_name ?? item.lesson_url}`,
      `*日時:* ${target}`,
      `*状態:* ${item.status}`,
      `*理由:* ${reason}`,
      `*URL:* ${item.lesson_url}`
    ];
    await this.post({ text: lines.join("\n") });
  }

  private async post(payload: { text: string }): Promise<void> {
    const webhookUrl = await this.webhookUrl();
    if (!webhookUrl) return;
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, "Slack notification failed");
      }
    } catch (error) {
      logger.warn({ error }, "Slack notification threw");
    }
  }

  private async webhookUrl(): Promise<string | undefined> {
    return config.SLACK_WEBHOOK_URL || readSecret(config.SLACK_WEBHOOK_SECRET_NAME);
  }
}

function iconFor(level: SlackLevel): string {
  if (level === "success") return ":white_check_mark:";
  if (level === "error") return ":rotating_light:";
  if (level === "warning") return ":warning:";
  return ":information_source:";
}
