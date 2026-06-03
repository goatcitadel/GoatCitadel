export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export interface BoundedIntOptions {
  fallback: number;
  min: number;
  max: number;
}

export interface BoundedDurationOptions {
  fallback?: number;
  minMs?: number;
  maxMs: number;
}

export interface BoundedDateOptions {
  fallback?: Date;
  min?: Date;
  max?: Date;
}

export interface HttpContentLengthOptions {
  fallback?: number;
  maxBytes: number;
}

export interface HttpRetryAfterOptions {
  fallback?: number;
  maxMs: number;
  now?: Date;
}

export function coerceBoundedInt(value: unknown, options: BoundedIntOptions): number {
  return clampInt(value, options.fallback, options.min, options.max);
}

export function coercePositiveInt(value: unknown, fallback: number, max: number): number {
  return coerceBoundedInt(value, { fallback, min: 1, max });
}

export function coerceDurationMs(value: unknown, options: BoundedDurationOptions): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return options.fallback;
  }
  return Math.min(options.maxMs, Math.max(options.minMs ?? 1, Math.floor(parsed)));
}

export function coerceDeadlineDate(value: unknown, options: BoundedDateOptions = {}): Date | undefined {
  const parsed =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "number" || typeof value === "string"
        ? new Date(value)
        : undefined;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    return options.fallback;
  }
  if (options.min && parsed.getTime() < options.min.getTime()) {
    return new Date(options.min.getTime());
  }
  if (options.max && parsed.getTime() > options.max.getTime()) {
    return new Date(options.max.getTime());
  }
  return parsed;
}

export function coerceHttpContentLength(value: unknown, options: HttpContentLengthOptions): number | undefined {
  const parsed = parseFiniteNumber(value);
  if (parsed === undefined || parsed < 0 || !Number.isInteger(parsed)) {
    return options.fallback;
  }
  return Math.min(options.maxBytes, parsed);
}

export function coercePort(value: unknown, fallback?: number): number | undefined {
  const parsed = parseFiniteNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

export function coerceRetryAfterMs(value: unknown, options: HttpRetryAfterOptions): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return options.fallback;
  }
  const trimmed = typeof value === "string" ? value.trim() : value;
  if (trimmed === "") {
    return options.fallback;
  }

  const numeric = parseFiniteNumber(trimmed);
  if (numeric !== undefined) {
    if (numeric < 0) {
      return options.fallback;
    }
    return Math.min(options.maxMs, Math.floor(numeric * 1000));
  }

  if (typeof trimmed !== "string") {
    return options.fallback;
  }
  const parsed = coerceDeadlineDate(trimmed, { fallback: undefined });
  if (!parsed) {
    return options.fallback;
  }
  const nowMs = options.now?.getTime() ?? Date.now();
  return Math.min(options.maxMs, Math.max(0, parsed.getTime() - nowMs));
}

export function coerceIsoDeadlineDate(value: unknown, options: BoundedDateOptions = {}): Date | undefined {
  if (value instanceof Date) {
    return coerceDeadlineDate(value, options);
  }
  if (typeof value !== "string") {
    return options.fallback;
  }
  const trimmed = value.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}T/u.test(trimmed)) {
    return options.fallback;
  }
  return coerceDeadlineDate(trimmed, options);
}

function parseFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
