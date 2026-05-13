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
const SENSITIVE_LOG_KEY_PATTERN =
  /(?:api[_-]?key|authorization|bearer|client[_-]?secret|companion[_-]?session[_-]?token|connector[_-]?secret[_-]?value|cookie|idempotency[_-]?key|password|provider[_-]?api[_-]?key|refresh[_-]?token|request[_-]?secret|secret|session[_-]?token|token)$/i;

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
    if (SENSITIVE_LOG_KEY_PATTERN.test(key)) {
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
