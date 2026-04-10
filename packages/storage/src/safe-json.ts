export function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }
  if (typeof raw !== "string") {
    return raw as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
