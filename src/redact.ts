const SENSITIVE_KEYS = new Set([
  "last_name",
  "first_name",
  "email",
  "email_address",
  "tel",
  "mobile_phone",
  "home_phone",
  "postal_code",
  "prefecture",
  "city",
  "address_line1",
  "address_line2",
  "actionBy"
]);

export function redactSensitive<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEYS.has(key) ? "[REDACTED]" : redact(child);
  }
  return result;
}
