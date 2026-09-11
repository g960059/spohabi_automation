# Spohabi Automation

スポハビ空席通知メールをトリガーに、通常レッスンの自動予約を試みるCloud Runサービスです。推奨構成はCloudflare Email Workerで受信したメールをCloud Runへ転送する方式です。Spohabiメール受信時に現在の予約一覧をGoogle Calendarへ整合できます。スポハビ側の短間隔ポーリングは行いません。

## Runtime

- `POST /events/spohabi-email`: Cloudflare Email WorkerからHMAC署名付きの生メールを受信します。
- `POST /events/gmail-pubsub`: legacy。Pub/Sub push subscriptionからGmail通知を受信します。`GMAIL_API_ENABLED=false` なら何もしません。
- `POST /tasks/renew-gmail-watch`: legacy。Cloud Scheduler dailyでGmail `watch` を更新します。`GMAIL_API_ENABLED=false` なら何もしません。
- `POST /tasks/gmail-sync`: legacy。Gmail History APIの差分を同期します。`GMAIL_API_ENABLED=false` なら何もしません。
- `POST /tasks/expire-watchlist`: 開始10分前を過ぎたwatchを期限切れにします。
- `GET /health`: liveness checkです。`GET /healthz` もローカル互換用に残しています。

Cloudflare Email Workerから直接呼ぶ場合、Cloud Run IAM認証は使えないため `--allow-unauthenticated` で公開し、`/events/spohabi-email` はHMAC署名で保護します。`/tasks/*` は `TASK_SHARED_SECRET` を設定した場合、`x-spohabi-task-secret` ヘッダーを要求します。

## Local setup

```bash
npm install
cp env.example .env
mkdir -p secrets data
npm run dev -- auth:gmail
```

Cloudflare Email Worker方式では、Gmail API用のOAuth client JSONとrefresh tokenは不要です。Google Calendar連携を使う場合だけ、Calendar用OAuth tokenが必要です。

legacy Gmail Pub/Sub方式を使う場合のOAuth scopeはGmail readonlyとCalendar eventsです。

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/calendar.events`

Cloudflare Email Worker方式でCalendarだけ認可する場合:

```bash
GMAIL_API_ENABLED=false npm run dev -- auth:gmail
npm run dev -- auth:upload-refresh-token
```

この場合、Gmail readonly scopeは要求しません。

## Workflow

通常運用では、スポハビ上の「空席を通知」登録を自動予約対象の正とします。

1. スポハビで対象枠の「空席を通知」を押します。
2. 空席通知メールがGmailに届くと、Cloud Runがメールを検証します。
3. メールが有効で、開始10分前を過ぎていなければ、対象枠の予約を1回だけ試みます。
4. 予約完了、キャンセル、空席通知処理後に、必要に応じてSpohabiの現在の予約一覧をGoogle Calendarへ反映します。
5. 結果はSlackへ通知し、Firestoreに履歴を残します。
6. キャンセルメールを受信すると、そのスクール・レッスン・開催日時の自動予約を停止します。後から同じコマの空席通知が届いても再予約しません。別の日の同じレッスンには影響しません。
7. その他の自動予約対象から外したい場合は、スポハビ側で「通知を解除」してください。

Firestoreの `watchlist` は、ユーザーが手で管理する待機リストではなく、予約ロック、状態表示、履歴のための内部レコードとして使います。空席通知メールを受けるたびに、対応するwatchが自動作成または更新されます。

キャンセルによる停止は `reservation_cancellations` に保存し、対象watchは `cancelled` になります。まだwatchがないコマも停止対象です。Calendar連携が無効・失敗の場合も停止は有効で、空席通知の再配信や `watch:add`、`reserve:once --force` では解除されません。予約API送信直前にも停止を確認しますが、すでに送信済みの予約要求は取り消せません。同じコマを再度予約したい場合はスポハビ上で手動予約してください。

## Cloudflare Email Worker trigger

推奨構成です。Gmail APIを使わず、Gmail OAuth restricted scopeの検証やrefresh token失効を避けます。

```text
Spohabi通知メール
  -> GmailフィルタでCloudflare管理ドメインの受信用アドレスへ転送
  -> Cloudflare Email Worker
  -> HMAC署名付きでCloud Run /events/spohabi-email へPOST
  -> 予約試行 / Calendar整合 / Slack通知
```

Cloudflare側:

1. Cloudflareで管理しているドメインにEmail Routingを有効化します。
2. `cloudflare/email-worker.js` をEmail Workerとしてデプロイします。
3. Email Routing ruleで、受信用アドレスをこのWorkerへ渡します。
4. Worker secret `INBOUND_EMAIL_HMAC_SECRET` を設定します。
5. Worker variable `CLOUD_RUN_EMAIL_ENDPOINT` に `https://<cloud-run-host>/events/spohabi-email` を設定します。
6. Gmailの転送先確認メールを受けるため、一時的に `FORWARD_NON_SPOHABI_TO` に自分のGmailアドレスを設定します。
7. Gmailで転送先確認後、`from:system@spohabi.com` のフィルタを作り、このCloudflare受信用アドレスへ転送します。

Cloud Run側:

```bash
openssl rand -hex 32 | gcloud secrets create inbound-email-hmac-secret \
  --project spohabi-automation \
  --data-file=-

openssl rand -hex 32 | gcloud secrets create task-shared-secret \
  --project spohabi-automation \
  --data-file=-

gcloud run deploy spohabi-automation \
  --source . \
  --region asia-northeast1 \
  --project spohabi-automation \
  --allow-unauthenticated \
  --concurrency 1 \
  --max-instances 3 \
  --min-instances 0 \
  --timeout 120 \
  --update-env-vars GMAIL_API_ENABLED=false,INBOUND_EMAIL_HMAC_SECRET_NAME=projects/spohabi-automation/secrets/inbound-email-hmac-secret,TASK_SHARED_SECRET_NAME=projects/spohabi-automation/secrets/task-shared-secret
```

`task-shared-secret` の値を取得し、Cloud Schedulerの `x-spohabi-task-secret` ヘッダーに設定してください。Cloudflare移行後はlegacy Gmail Schedulerは停止できます。

## Manual watch commands

通常運用では不要ですが、dry-runや手動テスト用にwatchを直接登録できます。

```bash
npm run dev -- watch:add \
  --lesson-url https://spohabi.com/fc-tennis/lesson/57 \
  --target "2026/05/09 08:00" \
  --lesson-name "土曜A 初中級 8:00～9:20"
```

CLIはFirestoreを直接使います。ローカルで使う場合はADCまたは `FIRESTORE_EMULATOR_HOST` を設定してください。

## Cloud resources

Required APIs:

```bash
gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com gmail.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com
```

Cloudflare Email Worker方式だけなら、Gmail APIとPub/Subは不要です。Google Calendar連携を使う場合はOAuth client自体は残りますが、Gmail readonly scopeは不要にできます。

Pub/Sub topicにはGmail publisherを付与します。

```bash
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

Pub/Sub push subscriptionはCloud Run URLへOIDC付きで作成し、ack deadline `120s`、message retention `7d`、dead-letter max delivery attempts `5` を設定します。

Cloud SchedulerもOIDC付きで `/tasks/renew-gmail-watch`, `/tasks/gmail-sync`, `/tasks/expire-watchlist` を呼びます。Scheduler用service accountとPub/Sub push用service accountには `roles/run.invoker` だけを付与してください。

Cloud Runの推奨設定:

```bash
gcloud run deploy spohabi-automation \
  --source . \
  --region asia-northeast1 \
  --no-allow-unauthenticated \
  --concurrency 1 \
  --max-instances 3 \
  --min-instances 0 \
  --timeout 120
```

## Secrets and config

Secret Manager:

- `gmail-oauth-client-json`
- `gmail-refresh-token`
- `inbound-email-hmac-secret`
- `task-shared-secret`
- `spohabi-password`
- `spohabi-api-key`
- `slack-webhook-url`

Non-secret env:

- `SPOHABI_EMAIL`
- `SPOHABI_LAST_NAME`, `SPOHABI_FIRST_NAME`, `SPOHABI_TEL`, address fields
- `GMAIL_EXPECTED_EMAIL`
- `GMAIL_PUBSUB_TOPIC`
- `GMAIL_API_ENABLED`。Cloudflare Email Worker方式では `false`
- `INBOUND_EMAIL_HMAC_SECRET_NAME` または `INBOUND_EMAIL_HMAC_SECRET`
- `TASK_SHARED_SECRET_NAME` または `TASK_SHARED_SECRET`
- `GOOGLE_CALENDAR_ENABLED`
- `GOOGLE_CALENDAR_ID`。通常は `primary`
- `GOOGLE_CALENDAR_RECONCILE_DAYS`。Calendar整合対象の日数。通常は `60`
- `GOOGLE_CALENDAR_RECONCILE_SCHOOL_SLUG`。通常は `fc-tennis`
- endpoint URLs
- `DRY_RUN`
- `SLACK_WEBHOOK_SECRET_NAME` または `SLACK_WEBHOOK_URL`

`DRY_RUN=true` では最終予約APIを呼ばず、reservation attemptだけを記録します。`DRY_RUN=false` への切り替え後、dry-run済みメールの実予約replayは手動 `gmail:catch-up` のみで許可されます。Pub/Sub handlerではreplayしません。

Slack webhookを設定すると、以下を通知します。

- 予約成功
- 空席通知を受けたが満席などで取れなかった場合
- 設定不備や同時間帯予約などで予約不可になった場合
- transient failure
- `DRY_RUN` の予約試行
- 内部watchがレッスン開始10分前を過ぎて期限切れになった場合

## Google Calendar

`GOOGLE_CALENDAR_ENABLED=true` にすると、スポハビからの予約完了メール、キャンセルメール、空席通知メール処理時に、Spohabiの現在の予約一覧を正としてGoogle Calendarを整合します。今後 `GOOGLE_CALENDAR_RECONCILE_DAYS` 日以内のSpohabi予約イベントを作成または更新し、同じ範囲の余分なSpohabi作成イベントは削除します。

通常運用では定期的なSpohabi照会は行いません。Calendar整合はGmail Pub/SubでSpohabiメールを受けた処理に連動します。

既存のOAuth refresh tokenがGmail readonlyだけで発行されている場合、またはGoogle OAuth同意画面をTestingから本番環境へ変更した場合は、再認可してSecret Managerの `gmail-refresh-token` を更新してください。`pbpaste` などで手動投入するとコマンド文字列を誤登録しやすいため、ローカルに保存された `refresh_token` だけをアップロードするCLIを使います。

```bash
GMAIL_API_ENABLED=false npm run dev -- auth:gmail
GOOGLE_CLOUD_PROJECT=spohabi-automation \
GMAIL_REFRESH_TOKEN_SECRET_NAME=projects/spohabi-automation/secrets/gmail-refresh-token \
npm run dev -- auth:upload-refresh-token
gcloud run services update spohabi-automation \
  --region asia-northeast1 \
  --project spohabi-automation \
  --update-env-vars GOOGLE_CALENDAR_ENABLED=true,GOOGLE_CALENDAR_ID=primary
```

手動で現在のSpohabi予約一覧からCalendarを整合する場合:

```bash
GOOGLE_CALENDAR_ENABLED=true npm run dev -- calendar:reconcile --delete-extra
```

`calendar:catch-up` は過去メール履歴から復元するため、キャンセル済み予約を再作成する可能性があります。通常は使わず、必要な場合だけ `--unsafe-from-email-history` を明示してください。

## Operational notes

- Gmail messageは `From: system@spohabi.com` と `Authentication-Results` のSPF/DKIM/DMARC passを確認します。
- 予約完了メールとキャンセルメールは同じGmail処理経路で検証し、Calendar連携が有効な場合はSpohabiの現在の予約一覧を正としてCalendarを整合します。
- Gmail History APIの `404` はhistoryが古すぎる扱いにし、Gmail `watch` を再発行して候補メール最大50件だけcatch-upします。
- 空席通知メールが有効なら、対応する内部watchを自動作成または更新します。
- 内部watchは予約前に `watching -> reserving` のleaseを取るため、別メールやretryから同じ枠を二重処理しにくくします。最終的な同時間帯予約の重複はスポハビAPI照会でも確認します。
- `processed_messages.ttlAt` は30日、`reservation_attempts.ttlAt` は90日を想定します。Firestore TTL policyを有効化してください。
- Alert推奨: DLQ depth、watch expiration 36h未満、history 404、OAuth `invalid_grant`、Spohabi reserve failure連続発生、stale `reserving` / stale sync lease。

## Constraints

- スポハビへのアクセスは、検証済みのSpohabiメール処理時だけです。空席通知では予約試行、予約完了・キャンセル・空席通知後のCalendar整合では現在の予約一覧取得を行います。
- Spohabi定期ポーリング、reCAPTCHA回避、bot対策迂回は実装しません。
- v1ではPlaywright/Chromium fallbackは実装しません。
- スポハビの公開画面が使う内部APIを呼ぶため、`DRY_RUN=false` にする前に利用規約と運用リスクを確認してください。
