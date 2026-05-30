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
