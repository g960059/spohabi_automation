import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { readSecret } from "./secretStore.js";

export async function verifyTaskSecret(value: string | string[] | undefined): Promise<boolean> {
  const expectedRaw = config.TASK_SHARED_SECRET || (await readSecret(config.TASK_SHARED_SECRET_NAME));
  const expected = expectedRaw?.trim();
  if (!expected) return true;
  const actual = Array.isArray(value) ? value[0] : value;
  return typeof actual === "string" && constantTimeEqual(actual, expected);
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
