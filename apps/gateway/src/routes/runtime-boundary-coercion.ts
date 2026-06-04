export interface BoundedIntegerOptions {
  defaultValue: number;
  min: number;
  max: number;
}

export function coerceBoundedInteger(value: unknown, options: BoundedIntegerOptions): number {
  if (value === undefined || value === null || value === "") {
    return options.defaultValue;
  }
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return options.defaultValue;
  }
  const integer = Math.trunc(numeric);
  if (integer < options.min) {
    return options.min;
  }
  if (integer > options.max) {
    return options.max;
  }
  return integer;
}
