import { describe, expect, it } from "vitest";
import { maxHistoryId } from "../src/firestoreStore.js";
import { decodePubSubPush } from "../src/httpServer.js";

describe("Cloud Run helpers", () => {
  it("does not regress Gmail history ids", () => {
    expect(maxHistoryId("200", "100")).toBe("200");
    expect(maxHistoryId("200", "300")).toBe("300");
    expect(maxHistoryId(null, "300")).toBe("300");
  });

  it("decodes Gmail Pub/Sub push payloads", () => {
    const payload = Buffer.from(JSON.stringify({ emailAddress: "user@example.com", historyId: "123" }), "utf8").toString("base64");
    expect(decodePubSubPush({ message: { data: payload } })).toEqual({ emailAddress: "user@example.com", historyId: "123" });
  });

  it("normalizes numeric Gmail Pub/Sub history ids", () => {
    const payload = Buffer.from(JSON.stringify({ emailAddress: "user@example.com", historyId: 123 }), "utf8").toString("base64");
    expect(decodePubSubPush({ message: { data: payload } })).toEqual({ emailAddress: "user@example.com", historyId: "123" });
  });

  it("ignores malformed Pub/Sub push payloads", () => {
    expect(decodePubSubPush({ message: { data: "not-base64-json" } })).toBeNull();
    expect(decodePubSubPush({ message: {} })).toBeNull();
  });
});
