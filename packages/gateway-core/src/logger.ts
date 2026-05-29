/**
 * Structured logger for GoatCitadel services.
 *
 * Provides a consistent logging interface that can be used outside of Fastify
 * request context (services, schedulers, background tasks). All output is
 * JSON-structured to stdout/stderr, making it easy to parse in production
 * while remaining readable during development.
 *
 * Usage:
 *   import { logger } from "@goatcitadel/gateway-core";
 *   const log = logger.child("my-service");
 *   log.info("started", { port: 8787 });
 *   log.warn("slow query", { durationMs: 420 });
 *   log.error("tick failed", error);
 */

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface Logger {
  readonly info: (msg: string, context?: LogContext) => void;
  readonly warn: (msg: string, context?: LogContext) => void;
  readonly error: (msg: string, errorOrContext?: unknown) => void;
  readonly debug: (msg: string, context?: LogContext) => void;
  readonly child: (component: string) => Logger;
}

const REDACTED_LOG_VALUE = "[redacted]";

/**
 * Segments that mark a key as credential-bearing wherever they appear. These
 * words do not occur in benign usage/config fields, so a whole-segment match is
 * safe to redact regardless of position.
 */
const SECRET_KEY_SEGMENTS = new Set([
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "passwd",
  "password",
  "secret",
]);

/**
 * Adjacent segment pairs that together denote a credential. The trailing word
 * ("key", "secret", "token") is too broad on its own (e.g. cacheKey,
 * tokenCount), so it only triggers redaction next to one of these qualifiers.
 */
const SECRET_SEGMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["api", "key"],
  ["private", "key"],
  ["idempotency", "key"],
  ["client", "secret"],
];

/**
 * Segments that mark a key as a usage/count/limit/tokenizer field. When any of
 * these is present, a "token" segment is treated as a metric (e.g.
 * prompt_tokens, max_tokens, token_count, tokenizer) and never redacted.
 */
const TOKEN_USAGE_SEGMENTS = new Set(["budget", "count", "limit", "max", "per", "remaining", "total", "usage", "used"]);

/** Split a key into lowercase segments on `_`, `-`, and camelCase boundaries. */
function splitKeySegments(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
}

/**
 * A singular `token` segment denotes a credential (authToken, accessToken,
 * sessionToken, x-api-token, or a bare `token`). Plural `tokens` (prompt_tokens,
 * maxTokens) and tokenizer/usage fields are metrics and are excluded.
 */
function hasCredentialTokenSegment(segments: readonly string[]): boolean {
  if (!segments.includes("token")) {
    return false;
  }
  if (segments.some((segment) => TOKEN_USAGE_SEGMENTS.has(segment))) {
    return false;
  }
  return segments.at(-1) === "token";
}

/**
 * Decide whether a metadata key should be redacted. Matching is segment-aware
 * (case-insensitive, boundary-aware) so `authToken`, `apiKeyHash`,
 * `secretValue`, `clientSecret`, and `x-api-key` redact, while usage counters
 * such as `prompt_tokens`, `maxTokens`, `tokenCount`, and `tokenizer` do not.
 */
function isSensitiveLogKey(key: string): boolean {
  const segments = splitKeySegments(key);
  if (segments.some((segment) => SECRET_KEY_SEGMENTS.has(segment))) {
    return true;
  }
  const hasSegmentPair = SECRET_SEGMENT_PAIRS.some(([first, second]) =>
    segments.some((segment, index) => segment === first && segments[index + 1] === second),
  );
  if (hasSegmentPair) {
    return true;
  }
  return hasCredentialTokenSegment(segments);
}

function formatError(errorOrContext: unknown): LogContext {
  if (errorOrContext instanceof Error) {
    return {
      err: {
        message: errorOrContext.message,
        name: errorOrContext.name,
        stack: errorOrContext.stack,
      },
    };
  }
  if (typeof errorOrContext === "object" && errorOrContext !== null) {
    return errorOrContext as LogContext;
  }
  return { value: errorOrContext };
}

function createLogger(component: string): Logger {
  const write = (level: string, stream: "stdout" | "stderr", msg: string, context?: LogContext) => {
    const entry = {
      level,
      ts: new Date().toISOString(),
      component,
      msg,
      ...sanitizeLogContext(context),
    };
    const line = JSON.stringify(entry);
    if (stream === "stderr") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  };

  return {
    info: (msg, context) => write("info", "stdout", msg, context),
    warn: (msg, context) => write("warn", "stderr", msg, context),
    error: (msg, errorOrContext) => write("error", "stderr", msg, formatError(errorOrContext)),
    debug: (msg, context) => {
      if (process.env.GOATCITADEL_LOG_LEVEL === "debug") {
        write("debug", "stdout", msg, context);
      }
    },
    child: (sub) => createLogger(`${component}:${sub}`),
  };
}

function sanitizeLogContext(value: unknown, seen = new WeakSet<object>()): LogContext {
  const sanitized = sanitizeLogValue(value, seen);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }
  return sanitized as LogContext;
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const sanitized = value.map((entry) => sanitizeLogValue(entry, seen));
    seen.delete(value);
    return sanitized;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "function") {
      continue;
    }
    if (isSensitiveLogKey(key)) {
      result[key] = REDACTED_LOG_VALUE;
      continue;
    }
    result[key] = sanitizeLogValue(entry, seen);
  }
  seen.delete(value);
  return result;
}

/** Root logger — call `.child("service-name")` to create scoped loggers. */
export const logger: Logger = createLogger("core");
