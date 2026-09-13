import { redactSecretText } from "@goatcitadel/contracts";

export function sanitizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    // callbackQueryId, replyToken, interactionToken, and responseUrl are
    // provider reply capabilities. Routes strip them too, but the durable
    // owner independently rejects every known key spelling.
    if (
      /(?:secret|token|password|authorization|cookie|signature|callbackdata|callbackqueryid|replytoken|interactiontoken|responseurl)/i.test(
        normalizedKey,
      )
    ) {
      continue;
    }
    if (typeof item === "string") {
      sanitized[key] = redactSecretText(item).value.slice(0, 2_000);
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      sanitized[key] = item;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
