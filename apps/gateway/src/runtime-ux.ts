import process from "node:process";
import chalk from "chalk";
import type { FastifyBaseLogger } from "fastify";

type TerminalLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
type TerminalReporterOptions = {
  scope: string;
  verbose?: boolean;
  bindings?: Record<string, unknown>;
};
type LoggerBindings = Record<string, unknown>;

const levelWeight: Record<TerminalLevel | "silent", number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

const compactMetaKeys = new Set([
  "address",
  "authMode",
  "code",
  "error",
  "fallbackUsed",
  "host",
  "method",
  "overrideEnv",
  "path",
  "pid",
  "port",
  "reason",
  "reqId",
  "retryIndex",
  "responseTime",
  "route",
  "signal",
  "statusCode",
  "url",
]);

export function isVerboseLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GOATCITADEL_VERBOSE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function setGoatcitadelTerminalTitle(task: string): void {
  if (!process.stdout.isTTY) {
    return;
  }
  const safeTask = task.trim() || "Runtime";
  process.stdout.write(`\u001b]0;GoatCitadel - ${safeTask}\u0007`);
}

export function formatVerboseFlagHint(): string {
  return chalk.dim("use --verbose for request traces and full startup detail");
}

export function createTerminalReporter(options: TerminalReporterOptions) {
  const verbose = options.verbose ?? isVerboseLoggingEnabled();
  const bindings = sanitizeObject(options.bindings);

  return {
    verbose,
    trace(message: string, meta?: unknown) {
      emitTerminalLine("trace", options.scope, message, meta, verbose, bindings);
    },
    debug(message: string, meta?: unknown) {
      emitTerminalLine("debug", options.scope, message, meta, verbose, bindings);
    },
    info(message: string, meta?: unknown) {
      emitTerminalLine("info", options.scope, message, meta, verbose, bindings);
    },
    warn(message: string, meta?: unknown) {
      emitTerminalLine("warn", options.scope, message, meta, verbose, bindings);
    },
    error(message: string, meta?: unknown) {
      emitTerminalLine("error", options.scope, message, meta, verbose, bindings);
    },
    fatal(message: string, meta?: unknown) {
      emitTerminalLine("fatal", options.scope, message, meta, verbose, bindings);
    },
    success(message: string, meta?: unknown) {
      emitTerminalLine("info", options.scope, message, meta, verbose, bindings, "success");
    },
    child(childBindings?: Record<string, unknown>) {
      return createTerminalReporter({
        ...options,
        verbose,
        bindings: {
          ...bindings,
          ...sanitizeObject(childBindings),
        },
      });
    },
  };
}

export function createGatewayLogger(verbose = isVerboseLoggingEnabled()): FastifyBaseLogger {
  return new PrettyGatewayLogger(verbose);
}

class PrettyGatewayLogger implements FastifyBaseLogger {
  public level: TerminalLevel | "silent";
  private readonly reporter;

  public constructor(
    private readonly verbose: boolean,
    private readonly bindings: Record<string, unknown> = {},
    level: TerminalLevel | "silent" = verbose ? "debug" : "info",
  ) {
    this.level = level;
    this.reporter = createTerminalReporter({
      scope: "gateway",
      verbose,
      bindings,
    });
  }

  public child(bindings: LoggerBindings): FastifyBaseLogger {
    return new PrettyGatewayLogger(
      this.verbose,
      {
        ...this.bindings,
        ...sanitizeObject(bindings as Record<string, unknown>),
      },
      this.level,
    );
  }

  public trace = (...args: unknown[]) => {
    this.log("trace", args);
  };

  public debug = (...args: unknown[]) => {
    this.log("debug", args);
  };

  public info = (...args: unknown[]) => {
    this.log("info", args);
  };

  public warn = (...args: unknown[]) => {
    this.log("warn", args);
  };

  public error = (...args: unknown[]) => {
    this.log("error", args);
  };

  public fatal = (...args: unknown[]) => {
    this.log("fatal", args);
  };

  public silent = () => undefined;

  private log(level: TerminalLevel, args: unknown[]): void {
    if (levelWeight[level] < levelWeight[this.level]) {
      return;
    }
    const normalized = normalizeLogArgs(args);
    switch (level) {
      case "trace":
        this.reporter.trace(normalized.message, normalized.meta);
        break;
      case "debug":
        this.reporter.debug(normalized.message, normalized.meta);
        break;
      case "info":
        this.reporter.info(normalized.message, normalized.meta);
        break;
      case "warn":
        this.reporter.warn(normalized.message, normalized.meta);
        break;
      case "error":
        this.reporter.error(normalized.message, normalized.meta);
        break;
      case "fatal":
        this.reporter.fatal(normalized.message, normalized.meta);
        break;
    }
  }
}

function emitTerminalLine(
  level: TerminalLevel,
  scope: string,
  message: string,
  meta: unknown,
  verbose: boolean,
  bindings: Record<string, unknown>,
  variant: "default" | "success" = "default",
): void {
  if ((level === "debug" || level === "trace") && !verbose) {
    return;
  }

  const timestamp = chalk.dim(
    new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );
  const scopeLabel = chalk.cyan(scope);
  const levelLabel = formatLevelLabel(level, variant);
  const bindingLabel = formatBindingLabel(bindings);
  const baseMessage = message.trim() || fallbackMessageForLevel(level);
  const allowDetail = verbose || level === "warn" || level === "error" || level === "fatal";
  const detail = allowDetail ? formatMetaDetail(meta, verbose, bindings, level, variant) : "";
  const line = [timestamp, levelLabel, scopeLabel, bindingLabel, baseMessage].filter(Boolean).join(" ");
  const output = colorizeTerminalLine(level, variant, detail ? `${line}\n${detail}` : line);

  if (level === "warn") {
    // eslint-disable-next-line no-console -- terminal reporter is the sink for gateway runtime logs.
    console.warn(output);
    return;
  }
  if (level === "error" || level === "fatal") {
    // eslint-disable-next-line no-console -- terminal reporter is the sink for gateway runtime logs.
    console.error(output);
    return;
  }
  // eslint-disable-next-line no-console -- terminal reporter is the sink for gateway runtime logs.
  console.log(output);
}

function formatLevelLabel(level: TerminalLevel, variant: "default" | "success"): string {
  if (variant === "success") {
    return chalk.green("OK");
  }
  switch (level) {
    case "trace":
      return chalk.gray("TRACE");
    case "debug":
      return chalk.magenta("DEBUG");
    case "info":
      return chalk.blue("INFO");
    case "warn":
      return chalk.yellow("WARN");
    case "error":
      return chalk.red("ERROR");
    case "fatal":
      return chalk.bgRed.white("FATAL");
  }
}

function formatBindingLabel(bindings: Record<string, unknown>): string {
  const reqId = asShortText(bindings.reqId);
  if (reqId) {
    return chalk.dim(`[${reqId}]`);
  }
  const route = asShortText(bindings.route);
  if (route) {
    return chalk.dim(route);
  }
  return "";
}

function formatMetaDetail(
  meta: unknown,
  verbose: boolean,
  bindings: Record<string, unknown>,
  level: TerminalLevel,
  variant: "default" | "success",
): string {
  const merged = mergeMeta(bindings, meta);
  if (!merged) {
    return "";
  }
  const normalized = verbose ? sanitizeUnknown(merged, true) : compactMeta(sanitizeUnknown(merged, false));
  if (!normalized || (typeof normalized === "object" && Object.keys(normalized).length === 0)) {
    return "";
  }
  return colorizeTerminalLine(level, variant, chalk.dim(JSON.stringify(normalized)));
}

function colorizeTerminalLine(
  level: TerminalLevel,
  variant: "default" | "success",
  value: string,
): string {
  if (variant === "success") {
    return chalk.green(value);
  }
  switch (level) {
    case "warn":
      return chalk.yellow(value);
    case "error":
      return chalk.red(value);
    case "fatal":
      return chalk.bgRed.white(value);
    default:
      return value;
  }
}

function mergeMeta(bindings: Record<string, unknown>, meta: unknown): Record<string, unknown> | undefined {
  const sanitizedMeta = sanitizeUnknown(meta, true);
  const sanitizedBindings = sanitizeObject(bindings);
  if (!sanitizedMeta && Object.keys(sanitizedBindings).length === 0) {
    return undefined;
  }
  if (typeof sanitizedMeta === "object" && sanitizedMeta && !Array.isArray(sanitizedMeta)) {
    return {
      ...sanitizedBindings,
      ...sanitizedMeta,
    };
  }
  return {
    ...sanitizedBindings,
    detail: sanitizedMeta,
  };
}

function compactMeta(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => compactMeta(entry)).filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (compactMetaKeys.has(key)) {
      result[key] = compactMeta(entry);
      continue;
    }
    if (key === "err" || key === "error") {
      result.error = compactMeta(entry);
      continue;
    }
    if (key === "req" && entry && typeof entry === "object") {
      const req = entry as Record<string, unknown>;
      Object.assign(
        result,
        compactMeta({
          reqId: req.id,
          method: req.method,
          url: req.url,
        }) as Record<string, unknown>,
      );
      continue;
    }
    if (key === "res" && entry && typeof entry === "object") {
      const res = entry as Record<string, unknown>;
      Object.assign(
        result,
        compactMeta({
          statusCode: res.statusCode,
        }) as Record<string, unknown>,
      );
      continue;
    }
    if (key === "context" && entry && typeof entry === "object") {
      const context = entry as Record<string, unknown>;
      Object.assign(
        result,
        compactMeta({
          error: context.error,
          reason: context.reason,
          retryIndex: context.retryIndex,
          fallbackUsed: context.fallbackUsed,
        }) as Record<string, unknown>,
      );
      continue;
    }
    if (key === "responseTime") {
      result.responseTime = entry;
    }
  }
  return result;
}

function normalizeLogArgs(args: unknown[]): { message: string; meta?: unknown } {
  if (args.length === 0) {
    return { message: "" };
  }

  if (typeof args[0] === "string") {
    return {
      message: args[0],
      meta: args.length > 1 ? args[1] : undefined,
    };
  }

  if (args[0] instanceof Error) {
    return {
      message: typeof args[1] === "string" ? args[1] : args[0].message,
      meta: args[0],
    };
  }

  if (typeof args[1] === "string") {
    return {
      message: args[1],
      meta: args[0],
    };
  }

  if (typeof args[0] === "object" && args[0] !== null) {
    const objectMessage = inferMessageFromMeta(args[0]);
    return {
      message: objectMessage,
      meta: args[0],
    };
  }

  return {
    message: String(args[0] ?? ""),
    meta: args.length > 1 ? args[1] : undefined,
  };
}

function inferMessageFromMeta(meta: unknown): string {
  if (meta instanceof Error) {
    return meta.message;
  }
  if (!meta || typeof meta !== "object") {
    return "";
  }
  const objectValue = meta as Record<string, unknown>;
  const direct = asShortText(objectValue.msg) ?? asShortText(objectValue.message);
  if (direct) {
    return direct;
  }
  const errValue = objectValue.err;
  if (errValue && typeof errValue === "object") {
    const errObject = errValue as Record<string, unknown>;
    const errMessage = asShortText(errObject.message);
    if (errMessage) {
      return errMessage;
    }
  }
  return "";
}

function fallbackMessageForLevel(level: TerminalLevel): string {
  return level === "info" ? "runtime event" : `${level} event`;
}

function sanitizeUnknown(value: unknown, verbose: boolean, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      error: value.message,
      code: "code" in value ? (value as Error & { code?: string }).code : undefined,
      stack: verbose ? value.stack : undefined,
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const normalized = value.map((entry) => sanitizeUnknown(entry, verbose, seen));
    seen.delete(value);
    return normalized;
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
    const normalized = sanitizeUnknown(entry, verbose, seen);
    if (normalized !== undefined) {
      result[key] = normalized;
    }
  }
  seen.delete(value);
  return result;
}

function sanitizeObject(value: unknown): Record<string, unknown> {
  const normalized = sanitizeUnknown(value, false);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return {};
  }
  return normalized as Record<string, unknown>;
}

function asShortText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
