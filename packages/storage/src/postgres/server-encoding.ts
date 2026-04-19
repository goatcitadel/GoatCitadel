const WINDOWS_1252_EXTRA_CODE_POINTS = new Set<number>([
  0x20ac,
  0x201a,
  0x0192,
  0x201e,
  0x2026,
  0x2020,
  0x2021,
  0x02c6,
  0x2030,
  0x0160,
  0x2039,
  0x0152,
  0x017d,
  0x2018,
  0x2019,
  0x201c,
  0x201d,
  0x2022,
  0x2013,
  0x2014,
  0x02dc,
  0x2122,
  0x0161,
  0x203a,
  0x0153,
  0x017e,
  0x0178,
]);

export function sanitizeParamsForServerEncoding(
  params: readonly unknown[],
  serverEncoding: string | undefined,
  sql?: string,
): unknown[] {
  if (normalizeServerEncoding(serverEncoding) !== "WIN1252") {
    return [...params];
  }
  const context = looksLikeWriteStatement(sql) ? "top_level_write" : "plain";
  return params.map((value) => sanitizeStructuredValueForWindows1252(value, context));
}

export function normalizeServerEncoding(serverEncoding: string | undefined): string | undefined {
  return serverEncoding?.trim().toUpperCase();
}

export function escapeUnsupportedWindows1252Characters(input: string): string {
  let output = "";
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || isWindows1252CodePoint(codePoint)) {
      output += char;
      continue;
    }
    output += formatEscapedCodePoint(codePoint);
  }
  return output;
}

type ServerEncodingSanitizeContext = "plain" | "top_level_write" | "structured_value";

function sanitizeStructuredValueForWindows1252(
  value: unknown,
  context: ServerEncodingSanitizeContext,
): unknown {
  if (typeof value === "string") {
    if (looksLikeStructuredStringPayload(value)) {
      return context === "structured_value"
        ? escapeUnsupportedWindows1252Characters(value)
        : escapeUnsupportedWindows1252CharactersForJsonText(value);
    }
    return context === "plain" ? value : escapeUnsupportedWindows1252Characters(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredValueForWindows1252(item, "structured_value"));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        escapeUnsupportedWindows1252Characters(key),
        sanitizeStructuredValueForWindows1252(item, "structured_value"),
      ]),
    );
  }
  return value;
}

function looksLikeStructuredStringPayload(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function looksLikeWriteStatement(sql: string | undefined): boolean {
  return /^\s*(insert|update|merge)\b/i.test(sql ?? "");
}

function isWindows1252CodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x7f
    || (codePoint >= 0x00a0 && codePoint <= 0x00ff)
    || WINDOWS_1252_EXTRA_CODE_POINTS.has(codePoint)
  );
}

function formatEscapedCodePoint(codePoint: number): string {
  return formatEscapedCodePointForJsonText(codePoint, false);
}

function escapeUnsupportedWindows1252CharactersForJsonText(input: string): string {
  let output = "";
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || isWindows1252CodePoint(codePoint)) {
      output += char;
      continue;
    }
    output += formatEscapedCodePointForJsonText(codePoint, true);
  }
  return output;
}

function formatEscapedCodePointForJsonText(codePoint: number, literalBackslashes: boolean): string {
  const prefix = literalBackslashes ? "\\\\u" : "\\u";
  if (codePoint <= 0xffff) {
    return `${prefix}${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  const adjusted = codePoint - 0x10000;
  const highSurrogate = 0xd800 + (adjusted >> 10);
  const lowSurrogate = 0xdc00 + (adjusted & 0x3ff);
  return (
    `${prefix}${highSurrogate.toString(16).toUpperCase().padStart(4, "0")}` +
    `${prefix}${lowSurrogate.toString(16).toUpperCase().padStart(4, "0")}`
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
