import { describe, expect, it } from "vitest";
import { parseInboundEmail } from "../src/inboundEmail.js";

describe("parseInboundEmail", () => {
  it("extracts message content from a raw RFC822 email", async () => {
    const raw = [
      "Message-ID: <spohabi-test@example.com>",
      "From: spohabi-スポハビ- <system@spohabi.com>",
      "To: user@example.com",
      "Subject: =?UTF-8?B?44CQ44K544Od44OP44OT44CR44GU5biM5pyb44Gu44Os44OD44K544Oz44Oz44G456m65bi444GM5Ye644G+44GX44Gf44CC?=",
      "Authentication-Results: mx.google.com; dkim=pass header.i=@spohabi.com",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "以下のレッスンに空席が出ました。",
      "レッスンURL: https://spohabi.com/fc-tennis/lesson/57",
      "予約日程: 2026/05/24 08:00-09:20"
    ].join("\r\n");
    const parsed = await parseInboundEmail({ rawEmailBase64: Buffer.from(raw, "utf8").toString("base64") });
    expect(parsed.messageId).toMatch(/^inbound_[a-f0-9]{64}$/);
    expect(parsed.from).toContain("system@spohabi.com");
    expect(parsed.authenticationResults).toContain("dkim=pass");
    expect(parsed.text).toContain("以下のレッスンに空席が出ました");
  });
});
