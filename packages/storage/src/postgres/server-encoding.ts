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
): unknown[] {
  if (normalizeServerEncoding(serverEncoding) !== "WIN1252") {
    return [...params];
  }
  return params.map((value) => sanitizeValueForWindows1252(value));
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

function sanitizeValueForWindows1252(value: unknown): unknown {
  if (typeof value === "string") {
    return escapeUnsupportedWindows1252Characters(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValueForWindows1252(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeValueForWindows1252(item)]),
    );
  }
  return value;
}

function isWindows1252CodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x7f
    || (codePoint >= 0x00a0 && codePoint <= 0x00ff)
    || WINDOWS_1252_EXTRA_CODE_POINTS.has(codePoint)
  );
}

function formatEscapedCodePoint(codePoint: number): string {
  if (codePoint <= 0xffff) {
    return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return `\\u{${codePoint.toString(16).toUpperCase()}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
