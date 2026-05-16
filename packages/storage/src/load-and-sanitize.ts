export interface QuarantineEntry {
  store: string;
  rowId: string;
  rawValue: string | null;
  schemaError: string;
  observedAt: string;
}

export interface SafeParseResult<T> {
  success: boolean;
  data?: T;
  error?: { message: string };
}

export type SafeParse<T> = (value: unknown) => SafeParseResult<T>;

export interface LoadAndSanitizeContext<T> {
  store: string;
  rowId: string;
  parse: SafeParse<T>;
  onQuarantine?: (entry: QuarantineEntry) => void;
  log?: { warn: (data: unknown, message: string) => void };
}

export function loadAndSanitize<T>(
  rawValue: unknown,
  ctx: LoadAndSanitizeContext<T>,
  fallback: T | undefined,
): T | undefined {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return fallback;
  }

  let parsed: unknown;
  if (typeof rawValue === "string") {
    try {
      parsed = JSON.parse(rawValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportQuarantine(ctx, rawValue, `json_parse: ${message}`);
      return fallback;
    }
  } else {
    parsed = rawValue;
  }

  const result = ctx.parse(parsed);
  if (!result.success || result.data === undefined) {
    const message = result.error?.message ?? "unknown schema error";
    const rawForQuarantine = typeof rawValue === "string" ? rawValue : safeStringify(rawValue);
    reportQuarantine(ctx, rawForQuarantine, `schema: ${message}`);
    return fallback;
  }

  return result.data;
}

function reportQuarantine<T>(ctx: LoadAndSanitizeContext<T>, rawValue: string | null, schemaError: string): void {
  ctx.log?.warn(
    { store: ctx.store, rowId: ctx.rowId, schemaError },
    "state validation failed; row routed to quarantine",
  );
  if (!ctx.onQuarantine) {
    return;
  }
  try {
    ctx.onQuarantine({
      store: ctx.store,
      rowId: ctx.rowId,
      rawValue,
      schemaError,
      observedAt: new Date().toISOString(),
    });
  } catch (sinkError) {
    ctx.log?.warn(
      {
        store: ctx.store,
        rowId: ctx.rowId,
        sinkError: stringifyError(sinkError),
      },
      "state validation quarantine sink threw; suppressed",
    );
  }
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
